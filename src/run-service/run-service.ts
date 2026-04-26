import type { PhasePreview } from "../domain/phase-preview";
import type { WorkflowManifest } from "../domain/workflow";
import { gateResolverFor } from "../gates/resolver";
import type { GateDecision } from "../gates/types";
import type { RunEvent } from "../orchestrator/events";
import {
  HarnessRuntime,
  type HarnessRuntimeOptions,
  type RunMeta,
  type StartRunInput,
} from "../runtime/harness";
import { DeferredGatePrompter, type PendingGate } from "./deferred-gate-prompter";
import { EventBus } from "./event-bus";

/**
 * Run-management layer that turns the blocking, callback-based
 * `HarnessRuntime` into a non-blocking surface fit for HTTP and MCP:
 *
 *   - `startRun` returns a `runId` immediately; the run continues in
 *     the background, with events fanned into a per-run `EventBus`.
 *   - `subscribe(runId)` is an async iterable used by SSE handlers.
 *   - Human gates pause inside the engine until `resolveGate` is called
 *     out-of-band; the deferred promise the gate is awaiting completes
 *     and the engine resumes.
 *
 * Status is not tracked here — `RunMeta` (filesystem-backed via
 * `RunStore`) is the single source of truth and is read on demand.
 */
export type RunServiceOptions = HarnessRuntimeOptions;

export type StartRunRequest = Omit<StartRunInput, "onEvent">;

export class RunService {
  private readonly harness: HarnessRuntime;
  private readonly prompter = new DeferredGatePrompter();
  private readonly buses = new Map<string, EventBus<RunEvent>>();

  constructor(opts: RunServiceOptions = {}) {
    this.harness = new HarnessRuntime({
      ...opts,
      gateForKind: gateResolverFor(this.prompter),
    });
  }

  /**
   * Resolves on the first `run.started` event — the engine emits it
   * synchronously when it allocates the run id. If `harness.startRun`
   * rejects before any event fires, the rejection propagates here.
   */
  async startRun(input: StartRunRequest): Promise<string> {
    const bus = new EventBus<RunEvent>();
    let runId: string | undefined;

    return new Promise<string>((resolveStart, rejectStart) => {
      const onEvent = (event: RunEvent) => {
        bus.emit(event);
        if (!runId && event.type === "run.started") {
          runId = event.runId;
          this.buses.set(runId, bus);
          resolveStart(runId);
        }
      };

      this.harness.startRun({ ...input, onEvent }).then(
        () => bus.close(),
        (err) => {
          bus.close();
          if (runId) this.prompter.rejectRun(runId, "run failed");
          else rejectStart(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  previewRun(input: StartRunRequest): Promise<readonly PhasePreview[]> {
    return this.harness.previewRun(input);
  }

  subscribe(runId: string): AsyncIterable<RunEvent> {
    const bus = this.buses.get(runId);
    if (!bus) throw new Error(`No active run with id ${runId}`);
    return bus.subscribe();
  }

  pendingGatesFor(runId: string): readonly PendingGate[] {
    return this.prompter.listFor(runId);
  }

  resolveGate(runId: string, phaseId: string, decision: GateDecision): boolean {
    return this.prompter.resolve(runId, phaseId, decision);
  }

  getRun(runId: string): Promise<RunMeta> {
    return this.harness.getRun(runId);
  }

  listRuns(): Promise<RunMeta[]> {
    return this.harness.listRuns();
  }

  workflowDefinition(): Promise<WorkflowManifest> {
    return this.harness.workflowDefinition();
  }
}
