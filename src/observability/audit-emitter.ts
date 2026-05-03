import { request } from "node:http";
import type { RunEvent } from "../orchestrator/events";

/**
 * Inner-side emitter that posts every `RunEvent` to the broker's
 * audit endpoint. The broker is the sole writer of the hash-chained
 * `audit.jsonl` per run; the inner just forwards events as HTTP.
 *
 * Activation is gated by `ORDIN_AUDIT_ENABLED=1` + a populated
 * `HTTP_PROXY` env var. Both are set by the outer (parent) process
 * when an `audit` internal service is registered on the broker. In
 * passthrough sandbox mode, neither is set and `emit()` is a no-op.
 *
 * Audit is supplementary like tracing — never load-bearing for the
 * run. `emit()` returns immediately (fire-and-forget); transport
 * errors are logged at warn but never thrown back into the orchestrator
 * loop. The trade-off (fail-open) is documented in the L3a roadmap.
 */
export class AuditEmitter {
  private readonly enabled: boolean;
  private readonly proxyHost?: string;
  private readonly proxyPort?: number;
  private readonly endpoint = "http://audit/events";

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (env["ORDIN_AUDIT_ENABLED"] !== "1") {
      this.enabled = false;
      return;
    }
    const proxyUrl = env["HTTP_PROXY"];
    if (!proxyUrl || !URL.canParse(proxyUrl)) {
      this.enabled = false;
      return;
    }
    const u = new URL(proxyUrl);
    const port = u.port ? Number.parseInt(u.port, 10) : 80;
    if (!u.hostname || !Number.isFinite(port)) {
      this.enabled = false;
      return;
    }
    this.enabled = true;
    this.proxyHost = u.hostname;
    this.proxyPort = port;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Fire-and-forget. Returns immediately; the actual POST runs
   * asynchronously. Errors are logged but never propagate.
   */
  emit(event: RunEvent): void {
    if (!this.enabled || !this.proxyHost || !this.proxyPort) return;
    const body = JSON.stringify({
      runId: event.runId,
      kind: event.type,
      payload: event,
    });
    const req = request({
      host: this.proxyHost,
      port: this.proxyPort,
      method: "POST",
      // Absolute URL in path = proxy form. The broker (srt's
      // parentProxy) recognises this and dispatches by hostname to the
      // audit internal handler.
      path: this.endpoint,
      headers: {
        Host: "audit",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
    });
    req.on("error", (err) => {
      console.warn(`[audit] emit failed for ${event.type}: ${err.message}`);
    });
    req.on("response", (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        console.warn(`[audit] broker rejected ${event.type}: HTTP ${res.statusCode}`);
      }
      // Drain the response so the socket can close.
      res.resume();
    });
    req.write(body);
    req.end();
  }
}
