import type { ArtefactPointer, Feedback } from "../domain/composer";
import type { PhasePreparer, PhasePreview } from "../domain/phase-preview";
import type { Phase, WorkflowManifest } from "../domain/workflow";
import type { AgentRuntime } from "../runtimes/types";
import type { EngineRunInput, EngineServices } from "./engine";
import type { RunEvent } from "./events";
import type { PhaseRunner, PhaseRunResult } from "./phase-runner";

export interface PhaseInvocationPlan {
  readonly preview: PhasePreview;
  readonly runtime: AgentRuntime;
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

    const runtime = this.services.runtimes.get(preview.runtimeName);
    if (!runtime) {
      return {
        ok: false,
        error: `Runtime "${preview.runtimeName}" resolved for phase "${phase.id}" not registered`,
      };
    }

    return { ok: true, plan: { preview, runtime } };
  }
}

export interface PhaseInvokerContext {
  readonly runId: string;
  readonly input: EngineRunInput;
  readonly services: EngineServices;
  readonly phaseRunner: PhaseRunner;
  readonly emit: (event: RunEvent) => void;
}

export class PhaseInvoker {
  constructor(private readonly ctx: PhaseInvokerContext) {}

  async invoke(plan: PhaseInvocationPlan, iteration: number): Promise<PhaseRunResult> {
    const runDir = await this.ctx.services.runStore.ensureRunDir(this.ctx.runId);
    return this.ctx.phaseRunner.run({
      preview: plan.preview,
      runtime: plan.runtime,
      context: { runId: this.ctx.runId, runDir, iteration },
      emit: this.ctx.emit,
      ...(this.ctx.input.abortSignal ? { abortSignal: this.ctx.input.abortSignal } : {}),
    });
  }
}
