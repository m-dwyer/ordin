import type { Phase } from "../domain/workflow";
import { gateResolverFor } from "../gates/resolver";
import type { Gate, GateDecision } from "../gates/types";
import type { RunEvent } from "../orchestrator/events";
import type { RunMeta } from "../orchestrator/run-store";
import { DeferredGatePrompter, type PendingGate } from "./deferred-gate-prompter";
import { EventBus } from "./event-bus";

/**
 * Live handle for a running invocation. Returned by
 * `HarnessRuntime.prepareRun` once the engine has emitted `run.started`
 * and a `runId` is available.
 *
 * Owns the per-run event stream, the pending-gate registry, and the
 * eventual `RunMeta` completion. CLI awaits `completion` directly; HTTP
 * and MCP transports look the session up by `runId` and read `events` /
 * `pendingGates()` / call `resolveGate()` from out-of-band requests.
 */
export interface RunSession {
  readonly runId: string;
  readonly events: AsyncIterable<RunEvent>;
  buffered(): readonly RunEvent[];
  isClosed(): boolean;
  pendingGates(): readonly PendingGate[];
  resolveGate(phaseId: string, decision: GateDecision): boolean;
  readonly completion: Promise<RunMeta>;
}

/**
 * Default implementation. Composes an in-memory `EventBus` with replay
 * for late subscribers and a `DeferredGatePrompter` whose `prompt()`
 * suspends the engine's gate loop until `resolveGate()` arrives.
 *
 * Construction is two-step because the runId isn't known until the
 * engine emits `run.started`: the harness creates a session with
 * `runId` undefined, wires `onEvent` and gate resolution, and then
 * calls `bind(runId, completion)` once the runId is observed.
 */
export class DefaultRunSession implements RunSession {
  private readonly bus = new EventBus<RunEvent>();
  private readonly prompter = new DeferredGatePrompter();
  private resolvedRunId: string | undefined;
  private resolvedCompletion: Promise<RunMeta> | undefined;

  get runId(): string {
    if (!this.resolvedRunId) throw new Error("RunSession used before bind()");
    return this.resolvedRunId;
  }

  get events(): AsyncIterable<RunEvent> {
    return this.bus.subscribe();
  }

  buffered(): readonly RunEvent[] {
    return this.bus.buffered();
  }

  isClosed(): boolean {
    return this.bus.isClosed();
  }

  pendingGates(): readonly PendingGate[] {
    if (!this.resolvedRunId) return [];
    return this.prompter.listFor(this.resolvedRunId);
  }

  resolveGate(phaseId: string, decision: GateDecision): boolean {
    if (!this.resolvedRunId) return false;
    return this.prompter.resolve(this.resolvedRunId, phaseId, decision);
  }

  get completion(): Promise<RunMeta> {
    if (!this.resolvedCompletion) throw new Error("RunSession used before bind()");
    return this.resolvedCompletion;
  }

  /**
   * The `onEvent` callback the harness threads into the engine. Emits
   * to the bus and forwards to the optional user-supplied callback.
   */
  onEvent(userOnEvent: ((event: RunEvent) => void) | undefined): (event: RunEvent) => void {
    return (event) => {
      this.bus.emit(event);
      userOnEvent?.(event);
    };
  }

  /**
   * Gate resolver bound to this session's deferred prompter. Pass to
   * the engine via the `gateForKind` thread.
   */
  gateResolver(): (kind: Phase["gate"]) => Gate {
    return gateResolverFor(this.prompter);
  }

  /**
   * Called by the harness once the engine emits `run.started` and
   * `completion` is observable. Idempotent. The user-visible completion
   * is wrapped so that `await session.completion` doesn't return until
   * `bus.close()` has run and any pending gates have been rejected —
   * callers can rely on `isClosed()` and `pendingGates()` being final
   * by the time their await resolves.
   */
  bind(runId: string, completion: Promise<RunMeta>): void {
    if (this.resolvedRunId) return;
    this.resolvedRunId = runId;
    this.resolvedCompletion = completion.then(
      (meta) => {
        this.bus.close();
        return meta;
      },
      (err: unknown) => {
        this.prompter.rejectRun(runId, "run failed");
        this.bus.close();
        throw err;
      },
    );
  }
}
