import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuditChainWriter, type AuditEvent } from "./audit-chain";
import type { BrokerEgressEvent } from "./index";

/**
 * Per-run hash-chained audit log. The harness funnels every parent-
 * emitted `RunEvent` (run lifecycle, phase lifecycle, promoted runtime
 * observations) through `appendEvent`, and the broker fans `broker.*`
 * egress events into the same chain via `egressSink`.
 *
 * Per-run chain file: `<runStoreDir>/<runId>/audit.jsonl`. Writer is
 * opened lazily on the first event for a run and kept open across
 * appends. Concurrency: one writer per run file — concurrent runs
 * use distinct files; appends within a run are awaited per call so
 * writes never race.
 *
 * Broker-internal observations (`broker.forward`, `broker.connect`,
 * etc.) are recorded against whatever run is currently active. We
 * track current run by watching `run.started` events arriving via
 * `appendEvent`. If no run is active when a broker observation fires,
 * the event is dropped (logged via `onWarn`); pre-run egress shouldn't
 * happen in practice, and audit gaps fail-open per the "audit is
 * supplementary" trade-off.
 *
 * Failure mode: write errors are logged; audit is supplementary like
 * tracing, never load-bearing for the run.
 */

export interface AuditServiceOptions {
  /** Per-run chain files live at `<runStoreDir>/<runId>/audit.jsonl`. */
  readonly runStoreDir: string;
  /** Logger for non-fatal anomalies (write errors, dropped pre-run
   *  observations). Defaults to `console.warn`. */
  readonly onWarn?: (message: string) => void;
  /** Inject for tests; defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
  /**
   * Fires once per audit event after the chain write succeeds. The
   * harness wires this to its `StartRunInput.onEvent` so every
   * `RunEvent` flows into the parent's TUI. Errors thrown by the
   * callback are logged via `onWarn` and never propagate — audit is
   * supplementary.
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
   * Append an event to its run's chain.
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
