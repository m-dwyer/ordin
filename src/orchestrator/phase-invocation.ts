import type { ArtefactPointer, Feedback } from "../domain/composer";
import type { PhasePreparer, PhasePreview } from "../domain/phase-preview";
import type { Phase, WorkflowManifest } from "../domain/workflow";
import type { PhaseRunResult } from "../worker/phase-runner";
import type { EngineRunInput, EngineServices } from "./engine";
import type { RunEvent } from "./events";

/**
 * Result of composing a phase invocation: the prepared prompt + the
 * NAME of the runtime that should execute it. The runtime instance
 * lives wherever the dispatcher chooses to run the phase (in-process
 * default, or in a sandboxed worker under L2). The planner does not
 * resolve the instance — it only validates that the runtime is known
 * to the registered set.
 */
export interface PhaseInvocationPlan {
  readonly preview: PhasePreview;
  readonly runtimeName: string;
}

export type PhaseInvocationPlanningResult =
  | { readonly ok: true; readonly plan: PhaseInvocationPlan }
  | { readonly ok: false; readonly error: string };

export class PhaseInvocationPlanner {
  constructor(
    private readonly input: EngineRunInput,
    private readonly services: EngineServices,
    private readonly preparer: PhasePreparer,
  ) {}

  plan(
    manifest: WorkflowManifest,
    phase: Phase,
    artefactInputs: readonly ArtefactPointer[],
    artefactOutputs: readonly ArtefactPointer[],
    feedback: Feedback | undefined,
  ): PhaseInvocationPlanningResult {
    const agent = this.services.agents.get(phase.agent);
    if (!agent) {
      return {
        ok: false,
        error: `Agent "${phase.agent}" declared by phase "${phase.id}" not loaded`,
      };
    }

    const preview = this.preparer.prepare({
      phase,
      agent,
      workflow: manifest,
      config: this.services.config,
      task: this.input.task,
      cwd: this.input.workspaceRoot,
      tier: this.input.tier,
      artefactInputs,
      artefactOutputs,
      ...(feedback ? { feedback } : {}),
    });

    if (!this.services.runtimeNames.has(preview.runtimeName)) {
      return {
        ok: false,
        error: `Runtime "${preview.runtimeName}" resolved for phase "${phase.id}" not registered`,
      };
    }

    return { ok: true, plan: { preview, runtimeName: preview.runtimeName } };
  }
}

export interface PhaseInvokerContext {
  readonly runId: string;
  readonly input: EngineRunInput;
  readonly services: EngineServices;
  readonly emit: (event: RunEvent) => void;
}

/**
 * Hands off the planned invocation to the engine-supplied dispatcher.
 * Used to instantiate the runtime + drive `PhaseRunner` directly; that
 * concern moved to whatever the harness wires as `dispatchPhase` (today:
 * an in-process default; under L2: a sandboxed worker per phase).
 */
export class PhaseInvoker {
  constructor(private readonly ctx: PhaseInvokerContext) {}

  async invoke(
    phase: Phase,
    plan: PhaseInvocationPlan,
    iteration: number,
  ): Promise<PhaseRunResult> {
    const runDir = await this.ctx.services.runStore.ensureRunDir(this.ctx.runId);
    return this.ctx.input.dispatchPhase({
      runId: this.ctx.runId,
      runDir,
      iteration,
      phase,
      preview: plan.preview,
      runtimeName: plan.runtimeName,
      emit: this.ctx.emit,
      ...(this.ctx.input.abortSignal ? { abortSignal: this.ctx.input.abortSignal } : {}),
    });
  }
}
