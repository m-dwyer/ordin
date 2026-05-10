import type { VerifyResult } from "../broker/audit-chain";
import type { PhasePreview } from "../domain/phase-preview";
import type { WorkflowManifest } from "../domain/workflow";
import type { GateDecision } from "../gates/types";
import type { RunEvent } from "../orchestrator/events";
import type { PendingGate } from "../runtime/deferred-gate-prompter";
import {
  HarnessRuntime,
  type HarnessRuntimeOptions,
  type RunMeta,
  type RunSession,
  type StartRunInput,
} from "../runtime/harness";

/**
 * HTTP/MCP-shaped facade over `HarnessRuntime`. Server-mode entry point:
 *
 *   - Forces `sandboxMode: "passthrough"` per ADR-008 — wrapping the
 *     server itself is nonsensical, so any `srt`/`broker` from
 *     config is ignored unless the caller overrides explicitly.
 *   - Resolves runId-keyed lookups by delegating to
 *     `HarnessRuntime.findSession` — sessions own events, pending
 *     gates, and gate resolution.
 *   - Read-only operations (listRuns, getRun, verifyAudit, preview,
 *     workflowDefinition) pass straight through.
 */
export type RunServiceOptions = HarnessRuntimeOptions;

export type StartRunRequest = Omit<StartRunInput, "onEvent" | "gateForKind">;

export class RunService {
  private readonly harness: HarnessRuntime;

  constructor(opts: RunServiceOptions = {}) {
    this.harness = new HarnessRuntime({
      ...opts,
      sandboxMode: opts.sandboxMode ?? "passthrough",
    });
  }

  async startRun(input: StartRunRequest): Promise<string> {
    const session = await this.harness.prepareRun(input);
    return session.runId;
  }

  previewRun(input: StartRunRequest): Promise<readonly PhasePreview[]> {
    return this.harness.previewRun(input);
  }

  subscribe(runId: string): AsyncIterable<RunEvent> {
    return this.requireSession(runId).events;
  }

  /**
   * Polling-friendly view of the same event stream `subscribe()` exposes.
   * MCP tool calls are one-shot, so MCP clients can't hold an
   * async-iterable open across the run; instead they page through the
   * buffer with a cursor until `done` is true.
   */
  getEvents(runId: string, since = 0): { events: RunEvent[]; nextCursor: number; done: boolean } {
    const session = this.requireSession(runId);
    const buffered = session.buffered();
    return {
      events: buffered.slice(since),
      nextCursor: buffered.length,
      done: session.isClosed(),
    };
  }

  pendingGatesFor(runId: string): readonly PendingGate[] {
    return this.requireSession(runId).pendingGates();
  }

  resolveGate(runId: string, phaseId: string, decision: GateDecision): boolean {
    const session = this.harness.findSession(runId);
    if (!session) return false;
    return session.resolveGate(phaseId, decision);
  }

  getRun(runId: string): Promise<RunMeta> {
    return this.harness.getRun(runId);
  }

  listRuns(): Promise<RunMeta[]> {
    return this.harness.listRuns();
  }

  verifyAudit(runId: string): Promise<VerifyResult> {
    return this.harness.verifyAudit(runId);
  }

  workflowDefinition(): Promise<WorkflowManifest> {
    return this.harness.workflowDefinition();
  }

  private requireSession(runId: string): RunSession {
    const session = this.harness.findSession(runId);
    if (!session) throw new Error(`No active run with id ${runId}`);
    return session;
  }
}
