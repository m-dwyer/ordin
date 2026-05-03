import { mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AuditChainWriter, type AuditEvent } from "./audit-chain";
import type { BrokerEgressEvent, InternalService, InternalServiceHandler } from "./index";

/**
 * The broker-side audit endpoint. Receives `RunEvent` envelopes from
 * the inner via `POST http://audit/events` (HTTP_PROXY → srt → broker
 * → this handler) and appends them to a per-run hash chain.
 *
 * Per-run chain file: `<runStoreDir>/<runId>/audit.jsonl`. Writer is
 * opened lazily on the first event for a run, kept open across
 * appends, closed on `run.completed`. Concurrency: one writer per run
 * file — concurrent runs use distinct files; events are
 * single-threaded through the broker's HTTP server so writes within a
 * run never race.
 *
 * Broker-internal observations (`broker.forward`, `broker.connect`,
 * etc.) are recorded against whatever run is currently active. We
 * track current run by watching `run.started` / `run.completed` events
 * arriving on `/events`. If no run is active when a broker observation
 * fires, the event is dropped (logged via `onWarn`); for step 2 this
 * is acceptable — pre-run egress shouldn't happen in practice, and
 * audit gaps fail-open per the "audit is supplementary" trade-off.
 *
 * Failure mode: write errors return 500 to the inner; the inner's
 * AuditEmitter logs and continues. Audit is supplementary like
 * tracing; never load-bearing for the run.
 */
export const AuditEventSchema = z.object({
  runId: z.string().min(1),
  kind: z.string().min(1),
  payload: z.unknown(),
});

const MAX_BODY_BYTES = 1_048_576;

export interface AuditServiceOptions {
  /** Per-run chain files live at `<runStoreDir>/<runId>/audit.jsonl`. */
  readonly runStoreDir: string;
  /** Logger for non-fatal anomalies (write errors, dropped pre-run
   *  observations, malformed bodies). Defaults to `console.warn`. */
  readonly onWarn?: (message: string) => void;
  /** Inject for tests; defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
  /**
   * Fires once per audit event after the chain write succeeds. The
   * harness wires this to its `StartRunInput.onEvent` so worker-emitted
   * RunEvents (delivered here as audit POSTs) flow into the parent's
   * TUI. Errors thrown by the callback are logged via `onWarn` and
   * never propagate — audit is supplementary.
   */
  readonly onEvent?: (event: AuditEvent) => void;
}

export class AuditService {
  private readonly runStoreDir: string;
  private readonly onWarn: (message: string) => void;
  private readonly now: () => string;
  private readonly onEvent?: (event: AuditEvent) => void;
  private readonly writers = new Map<string, Promise<AuditChainWriter>>();
  private currentRunId?: string;

  constructor(opts: AuditServiceOptions) {
    this.runStoreDir = opts.runStoreDir;
    this.onWarn = opts.onWarn ?? ((m) => console.warn(`[audit] ${m}`));
    this.now = opts.now ?? (() => new Date().toISOString());
    if (opts.onEvent) this.onEvent = opts.onEvent;
  }

  /** Register on the broker as `{ kind: "internal", name: "audit", handler }`. */
  asInternalService(): InternalService {
    return { kind: "internal", name: "audit", handler: this.handler() };
  }

  /** Wire as the broker's `onEgress` callback so broker.* observations
   *  flow into the same chain as the inner-emitted events. */
  egressSink(): (event: BrokerEgressEvent) => void {
    return (event) => {
      const runId = this.currentRunId;
      if (!runId) {
        this.onWarn(`dropped pre-run broker observation: ${event.kind}`);
        return;
      }
      // Fire and forget — egress emission is synchronous from the
      // broker's perspective and must never block proxy traffic.
      this.appendInternal(runId, event.kind, event.payload).catch((err: unknown) => {
        this.onWarn(`failed to append broker event ${event.kind}: ${errMessage(err)}`);
      });
    };
  }

  /** Close all open writers. Called by the harness during shutdown. */
  async closeAll(): Promise<void> {
    const promises = [...this.writers.values()];
    this.writers.clear();
    this.currentRunId = undefined;
    await Promise.all(
      promises.map(async (p) => {
        const w = await p;
        await w.close();
      }),
    );
  }

  /**
   * Append an event to its run's chain. Public for tests + for any
   * future parent-side code that wants to record audit events without
   * going through HTTP. The HTTP handler is a thin wrapper around this.
   *
   * `run.started` updates `currentRunId` so subsequent broker.*
   * observations land in the right run's chain. We deliberately do NOT
   * close the writer or clear `currentRunId` on `run.completed` —
   * trailing telemetry (OTel batches flushed during process shutdown,
   * after the engine has already emitted run.completed) would otherwise
   * be dropped. Open writers stay alive until `closeAll()` (or process
   * exit); per-entry fdatasync means data is already durable so the fd
   * lifetime is just resource management, not correctness.
   */
  async appendEvent(event: AuditEvent): Promise<void> {
    await this.appendInternal(event.runId, event.kind, event.payload);
    if (event.kind === "run.started") {
      this.currentRunId = event.runId;
    }
  }

  private handler(): InternalServiceHandler {
    return async (req, res) => {
      if (req.method !== "POST") {
        respond(res, 405, "method not allowed");
        return;
      }
      // The broker has already validated req.url + Host before
      // dispatching to us; we only need the pathname. Resolving with
      // a fixed base yields a well-formed URL whether req.url is
      // absolute (proxy form) or path-only (direct form).
      const path = new URL(req.url ?? "/", "http://internal.invalid").pathname;
      if (path !== "/events") {
        respond(res, 404, "not found");
        return;
      }
      let body: string;
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch (err) {
        this.onWarn(`body read failed: ${errMessage(err)}`);
        respond(res, 413, "body too large or read failed");
        return;
      }
      let parsed: AuditEvent;
      try {
        parsed = AuditEventSchema.parse(JSON.parse(body));
      } catch (err) {
        this.onWarn(`malformed audit event: ${errMessage(err)}`);
        respond(res, 400, "malformed event");
        return;
      }
      try {
        await this.appendEvent(parsed);
        respond(res, 204, "");
      } catch (err) {
        this.onWarn(`audit append failed: ${errMessage(err)}`);
        respond(res, 500, "audit append failed");
      }
    };
  }

  private async appendInternal(runId: string, kind: string, payload: unknown): Promise<void> {
    const writer = await this.writerFor(runId);
    await writer.append({ runId, kind, payload });
    if (this.onEvent) {
      try {
        this.onEvent({ runId, kind, payload });
      } catch (err) {
        this.onWarn(`onEvent threw for ${kind}: ${errMessage(err)}`);
      }
    }
  }

  private writerFor(runId: string): Promise<AuditChainWriter> {
    const existing = this.writers.get(runId);
    if (existing) return existing;
    // Cache the Promise (not the resolved writer) and set() before any
    // await so concurrent callers join the same open instead of racing
    // to create separate writers.
    const promise = (async () => {
      const path = join(this.runStoreDir, runId, "audit.jsonl");
      await mkdir(dirname(path), { recursive: true });
      const writer = new AuditChainWriter({ path, now: this.now });
      await writer.open();
      return writer;
    })();
    this.writers.set(runId, promise);
    return promise;
  }
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`body exceeded ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) return;
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
