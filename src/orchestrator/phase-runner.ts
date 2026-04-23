import type { Agent } from "../domain/agent";
import type { ComposedPrompt, SkillHint } from "../domain/composer";
import { Composer } from "../domain/composer";
import type { HarnessConfig } from "../domain/config";
import type { Skill } from "../domain/skill";
import type { Phase } from "../domain/workflow";
import type { Gate } from "../gates/types";
import type { AgentRuntime, InvokeResult } from "../runtimes/types";
import { promoteRuntimeEvent } from "./events";
import type { PhaseExecutionContext, PhaseExecutionRequest } from "./phase-execution";
import type { PhaseMeta } from "./run-store";

export interface PhaseRunnerOptions {
  readonly config: HarnessConfig;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly skills: ReadonlyMap<string, Skill>;
  readonly runtimes: ReadonlyMap<string, AgentRuntime>;
  readonly gateForKind: (kind: Phase["gate"]) => Gate;
}

export class PhaseRunner {
  private readonly composer = new Composer();

  constructor(private readonly opts: PhaseRunnerOptions) {}

  async execute(req: PhaseExecutionRequest): Promise<PhaseMeta> {
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
      abortSignal: req.abortSignal,
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
      return phaseMeta;
    }

    emit({
      type: "phase.completed",
      runId: context.runId,
      phaseId: phase.id,
      iteration: context.iteration,
      tokens: invokeResult.tokens,
      durationMs: invokeResult.durationMs,
    });

    const gate = this.opts.gateForKind(phase.gate);
    emit({ type: "gate.requested", runId: context.runId, phaseId: phase.id });
    const decision = await gate.request({
      runId: context.runId,
      phaseId: phase.id,
      cwd: context.workspaceRoot,
      artefacts: context.artefactOutputs,
      summary: summariseInvocation(invokeResult),
    });

    if (decision.status === "approved") {
      phaseMeta.status = "completed";
      phaseMeta.gateDecision = gate.kind === "auto" ? "auto" : "approved";
      if (decision.note) phaseMeta.gateNote = decision.note;
      emit({
        type: "gate.decided",
        runId: context.runId,
        phaseId: phase.id,
        decision: phaseMeta.gateDecision,
        ...(decision.note ? { note: decision.note } : {}),
      });
      return phaseMeta;
    }

    phaseMeta.status = "rejected";
    phaseMeta.gateDecision = "rejected";
    phaseMeta.gateNote = decision.reason;
    emit({
      type: "gate.decided",
      runId: context.runId,
      phaseId: phase.id,
      decision: "rejected",
      reason: decision.reason,
    });
    return phaseMeta;
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
    context: PhaseExecutionContext,
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
      iterationContext: context.iterationContext,
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

function summariseInvocation(result: InvokeResult): string {
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
