import type { Agent } from "../domain/agent";
import type { ComposedPrompt, SkillHint } from "../domain/composer";
import { Composer } from "../domain/composer";
import type { HarnessConfig } from "../domain/config";
import type { Skill } from "../domain/skill";
import type { Phase } from "../domain/workflow";
import type { AgentRuntime, InvokeResult } from "../runtimes/types";
import { promoteRuntimeEvent } from "./events";
import type { PhaseExecutionRequest } from "./phase-execution";
import type { PhaseMeta } from "./run-store";

/**
 * `PhaseRunner` executes one phase: compose prompt → invoke runtime →
 * collect result. It emits `phase.started` / `phase.completed` /
 * `phase.failed` lifecycle events plus the runtime's observation
 * stream, tagged with runId + phaseId.
 *
 * Gates are deliberately NOT this class's concern — the engine calls
 * the gate after receiving the phase result and decides what happens
 * on rejection. Keeps PhaseRunner gate-agnostic so `MastraEngine`,
 * `SequentialEngine`, and future engines can wire gating differently.
 */
export interface PhaseRunnerOptions {
  readonly config: HarnessConfig;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly skills: ReadonlyMap<string, Skill>;
  readonly runtimes: ReadonlyMap<string, AgentRuntime>;
}

export interface PhaseRunResult {
  readonly meta: PhaseMeta;
  readonly invokeResult: InvokeResult;
}

export class PhaseRunner {
  private readonly composer = new Composer();

  constructor(private readonly opts: PhaseRunnerOptions) {}

  async run(req: PhaseExecutionRequest): Promise<PhaseRunResult> {
    const { context, emit, phase } = req;
    const agent = this.agentFor(phase);
    const runtime = this.runtimeFor(phase);
    const prompt = this.composePrompt(phase, context, agent);

    const phaseMeta: PhaseMeta = {
      phaseId: phase.id,
      iteration: context.iteration,
      startedAt: new Date().toISOString(),
      status: "running",
      runtime: runtime.name,
      model: prompt.model,
    };

    emit({
      type: "phase.started",
      runId: context.runId,
      phaseId: phase.id,
      iteration: context.iteration,
      model: prompt.model,
      runtime: runtime.name,
    });

    const invokeResult = await runtime.invoke({
      runId: context.runId,
      prompt,
      onEvent: (event) => emit(promoteRuntimeEvent(event, context.runId, phase.id)),
      ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    });

    this.applyInvokeResult(phaseMeta, invokeResult);

    if (invokeResult.status === "failed") {
      phaseMeta.status = "failed";
      phaseMeta.error = invokeResult.error ?? `exit ${invokeResult.exitCode}`;
      emit({
        type: "phase.failed",
        runId: context.runId,
        phaseId: phase.id,
        iteration: context.iteration,
        error: phaseMeta.error,
      });
      return { meta: phaseMeta, invokeResult };
    }

    emit({
      type: "phase.completed",
      runId: context.runId,
      phaseId: phase.id,
      iteration: context.iteration,
      tokens: invokeResult.tokens,
      durationMs: invokeResult.durationMs,
    });
    return { meta: phaseMeta, invokeResult };
  }

  private agentFor(phase: Phase): Agent {
    const agent = this.opts.agents.get(phase.agent);
    if (!agent) {
      throw new Error(`Agent "${phase.agent}" declared by phase "${phase.id}" not loaded`);
    }
    return agent;
  }

  private runtimeFor(phase: Phase): AgentRuntime {
    const runtime = this.opts.runtimes.get(phase.runtime);
    if (!runtime) {
      throw new Error(`Runtime "${phase.runtime}" declared by phase "${phase.id}" not registered`);
    }
    return runtime;
  }

  private composePrompt(
    phase: Phase,
    context: PhaseExecutionRequest["context"],
    agent: Agent,
  ): ComposedPrompt {
    const defaults = this.opts.config.resolveDefaults(phase.id, context.tier);
    return this.composer.compose({
      phase,
      agent,
      defaults,
      task: context.task,
      cwd: context.workspaceRoot,
      tier: context.tier,
      artefactInputs: context.artefactInputs,
      artefactOutputs: context.artefactOutputs,
      skills: [...this.opts.skills.values()].map<SkillHint>((s) => ({
        name: s.name,
        description: s.description,
      })),
      ...(context.feedback ? { feedback: context.feedback } : {}),
    });
  }

  private applyInvokeResult(phaseMeta: PhaseMeta, invokeResult: InvokeResult): void {
    phaseMeta.completedAt = new Date().toISOString();
    phaseMeta.tokens = invokeResult.tokens;
    phaseMeta.durationMs = invokeResult.durationMs;
    phaseMeta.exitCode = invokeResult.exitCode;
    phaseMeta.transcriptPath = invokeResult.transcriptPath;
  }
}

export function summariseInvocation(result: InvokeResult): string {
  const parts = [
    `duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `in: ${result.tokens.input.toLocaleString()} tok`,
    `out: ${result.tokens.output.toLocaleString()} tok`,
  ];
  if (result.tokens.cacheReadInput > 0) {
    parts.push(`cache-read: ${result.tokens.cacheReadInput.toLocaleString()} tok`);
  }
  return parts.join("  |  ");
}
