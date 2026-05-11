import type { Phase } from "../domain/workflow";
import { gateResolverFor } from "../gates/dispatch";
import type { Gate, GateContext, GateDecision, GatePrompter } from "../gates/types";
import type { RunEvent } from "../orchestrator/events";
import type { RunMeta } from "../orchestrator/run-store";
import { EventBus } from "./event-bus";

/**
 * Snapshot of a gate that's waiting for an out-of-band decision.
 * Returned from `RunSession.pendingGates()` so HTTP/MCP transports can
 * show the reviewer what's awaiting them.
 */
export interface PendingGate {
  readonly runId: string;
  readonly phaseId: string;
  readonly cwd: string;
  readonly artefacts: readonly { readonly label: string; readonly path: string }[];
  readonly summary?: string;
}

/**
 * Live handle for a running invocation. Returned by
 * `Harness.prepareRun` once the engine has emitted `run.started`
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

interface PendingEntry {
  readonly ctx: GateContext;
  readonly resolve: (decision: GateDecision) => void;
  readonly reject: (err: Error) => void;
}

/**
 * `GatePrompter` that suspends `prompt()` until an external caller
 * decides the gate via `resolve(runId, phaseId, decision)`. Bridges the
 * engine's synchronous gate loop with the request/response shape of
 * HTTP/MCP transports. Lifetime is tied 1:1 to its owning `RunSession`
 * — never used from anywhere else.
 */
class DeferredGatePrompter implements GatePrompter {
  private readonly pending = new Map<string, Map<string, PendingEntry>>();

  prompt(ctx: GateContext): Promise<GateDecision> {
    return new Promise<GateDecision>((resolve, reject) => {
      const phases = this.pending.get(ctx.runId) ?? new Map<string, PendingEntry>();
      phases.set(ctx.phaseId, { ctx, resolve, reject });
      this.pending.set(ctx.runId, phases);
    });
  }

  resolve(runId: string, phaseId: string, decision: GateDecision): boolean {
    const phases = this.pending.get(runId);
    const entry = phases?.get(phaseId);
    if (!entry || !phases) return false;
    phases.delete(phaseId);
    if (phases.size === 0) this.pending.delete(runId);
    entry.resolve(decision);
    return true;
  }

  rejectRun(runId: string, reason: string): void {
    const phases = this.pending.get(runId);
    if (!phases) return;
    for (const entry of phases.values()) entry.reject(new Error(reason));
    this.pending.delete(runId);
  }

  listFor(runId: string): readonly PendingGate[] {
    const phases = this.pending.get(runId);
    if (!phases) return [];
    return Array.from(phases.values()).map(({ ctx }) => ({
      runId: ctx.runId,
      phaseId: ctx.phaseId,
      cwd: ctx.cwd,
      artefacts: ctx.artefacts,
      ...(ctx.summary !== undefined ? { summary: ctx.summary } : {}),
    }));
  }
}

/**
 * Default implementation. Composes an in-memory `EventBus` with replay
 * for late subscribers and a private `DeferredGatePrompter` whose
 * `prompt()` suspends the engine's gate loop until `resolveGate()`
 * arrives.
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
