import type { Agent } from "../domain/agent";
import type { ArtefactPointer, ComposedPrompt, SkillHint } from "../domain/composer";
import { Composer } from "../domain/composer";
import type { HarnessConfig } from "../domain/config";
import type { Skill } from "../domain/skill";
import type { Phase, Workflow } from "../domain/workflow";
import type { Gate } from "../gates/types";
import type { AgentRuntime, InvokeResult } from "../runtimes/types";
import { promoteRuntimeEvent, type RunEvent } from "./events";
import { generateRunId, type PhaseMeta, type RunMeta, type RunStore } from "./run-store";

/**
 * Sequential orchestrator — Stage 1 state machine.
 *
 * Runs phases in order. At each gate:
 *   • approve  → advance to next phase
 *   • reject   → if phase has `on_reject.goto`, restart that phase with
 *                the rejection reason as iteration context (bounded by
 *                max_iterations); otherwise halt.
 *
 * Also the merging point for events: runtime-local RuntimeEvents get
 * tagged with runId + phaseId and emitted into the unified RunEvent stream
 * alongside our own lifecycle events.
 *
 * The LangGraph swap in Phase 11 replaces this module. Domain, runtimes,
 * and gates stay unchanged.
 */
export interface OrchestratorOptions {
  readonly workflow: Workflow;
  readonly config: HarnessConfig;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly skills: ReadonlyMap<string, Skill>;
  readonly runtimes: ReadonlyMap<string, AgentRuntime>;
  readonly gateForKind: (kind: Phase["gate"]) => Gate;
  readonly runStore: RunStore;
}

export interface RunInput {
  readonly task: string;
  readonly slug: string;
  readonly repo: string;
  readonly tier: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  readonly artefactInputs?: readonly ArtefactPointer[];
  readonly artefactOutputs?: ReadonlyMap<string, readonly ArtefactPointer[]>;
  readonly abortSignal?: AbortSignal;
}

export class SequentialOrchestrator {
  private readonly composer = new Composer();

  constructor(private readonly opts: OrchestratorOptions) {}

  async run(input: RunInput): Promise<RunMeta> {
    const runId = generateRunId(input.slug);
    const emit = input.onEvent ?? (() => {});

    const meta: RunMeta = {
      runId,
      workflow: this.opts.workflow.name,
      tier: input.tier,
      task: input.task,
      slug: input.slug,
      repo: input.repo,
      startedAt: new Date().toISOString(),
      status: "running",
      phases: [],
    };
    await this.opts.runStore.writeMeta(meta);
    emit({ type: "run.started", runId });

    const iterationCount = new Map<string, number>();
    let cursor: Phase | undefined = this.opts.workflow.firstPhase();
    let iterationContext: string | undefined;

    while (cursor) {
      const currentPhase: Phase = cursor;
      const iter = (iterationCount.get(currentPhase.id) ?? 0) + 1;
      iterationCount.set(currentPhase.id, iter);

      const phaseMeta = await this.runPhase(
        currentPhase,
        input,
        meta,
        iter,
        iterationContext,
        emit,
      );
      meta.phases.push(phaseMeta);
      await this.opts.runStore.writeMeta(meta);

      if (phaseMeta.status === "failed") {
        meta.status = "failed";
        break;
      }

      if (phaseMeta.gateDecision === "rejected") {
        const target = this.resolveRejection(currentPhase, iterationCount);
        if (!target) {
          meta.status = "halted";
          break;
        }
        iterationContext = phaseMeta.gateNote
          ? `Rejection from ${currentPhase.id}: ${phaseMeta.gateNote}`
          : `Rejection from ${currentPhase.id}`;
        cursor = target;
        continue;
      }

      iterationContext = undefined;
      cursor = this.opts.workflow.nextPhase(currentPhase.id);
    }

    if (meta.status === "running") meta.status = "completed";
    meta.completedAt = new Date().toISOString();
    await this.opts.runStore.writeMeta(meta);
    emit({ type: "run.completed", runId, status: meta.status });
    return meta;
  }

  private async runPhase(
    phase: Phase,
    input: RunInput,
    meta: RunMeta,
    iteration: number,
    iterationContext: string | undefined,
    emit: (event: RunEvent) => void,
  ): Promise<PhaseMeta> {
    const agent = this.opts.agents.get(phase.agent);
    if (!agent) {
      throw new Error(`Agent "${phase.agent}" declared by phase "${phase.id}" not loaded`);
    }
    const runtime = this.opts.runtimes.get(phase.runtime);
    if (!runtime) {
      throw new Error(`Runtime "${phase.runtime}" declared by phase "${phase.id}" not registered`);
    }
    const defaults = this.opts.config.resolveDefaults(phase.id, input.tier);

    const prompt: ComposedPrompt = this.composer.compose({
      phase,
      agent,
      defaults,
      task: input.task,
      cwd: input.repo,
      tier: input.tier,
      artefactInputs: input.artefactInputs,
      artefactOutputs: input.artefactOutputs?.get(phase.id),
      skills: [...this.opts.skills.values()].map<SkillHint>((s) => ({
        name: s.name,
        description: s.description,
      })),
      iterationContext,
    });

    const phaseMeta: PhaseMeta = {
      phaseId: phase.id,
      iteration,
      startedAt: new Date().toISOString(),
      status: "running",
      runtime: runtime.name,
      model: prompt.model,
    };

    emit({
      type: "phase.started",
      runId: meta.runId,
      phaseId: phase.id,
      iteration,
      model: prompt.model,
      runtime: runtime.name,
    });

    const invokeResult: InvokeResult = await runtime.invoke({
      runId: meta.runId,
      prompt,
      onEvent: (event) => emit(promoteRuntimeEvent(event, meta.runId, phase.id)),
      abortSignal: input.abortSignal,
    });

    phaseMeta.completedAt = new Date().toISOString();
    phaseMeta.tokens = invokeResult.tokens;
    phaseMeta.durationMs = invokeResult.durationMs;
    phaseMeta.exitCode = invokeResult.exitCode;
    phaseMeta.transcriptPath = invokeResult.transcriptPath;

    if (invokeResult.status === "failed") {
      phaseMeta.status = "failed";
      phaseMeta.error = invokeResult.error ?? `exit ${invokeResult.exitCode}`;
      emit({
        type: "phase.failed",
        runId: meta.runId,
        phaseId: phase.id,
        iteration,
        error: phaseMeta.error,
      });
      return phaseMeta;
    }

    emit({
      type: "phase.completed",
      runId: meta.runId,
      phaseId: phase.id,
      iteration,
      tokens: invokeResult.tokens,
      durationMs: invokeResult.durationMs,
    });

    const gate = this.opts.gateForKind(phase.gate);
    emit({ type: "gate.requested", runId: meta.runId, phaseId: phase.id });
    const decision = await gate.request({
      runId: meta.runId,
      phaseId: phase.id,
      cwd: input.repo,
      artefacts: input.artefactOutputs?.get(phase.id) ?? [],
      summary: summariseInvocation(invokeResult),
    });

    if (decision.status === "approved") {
      phaseMeta.status = "completed";
      phaseMeta.gateDecision = gate.kind === "auto" ? "auto" : "approved";
      if (decision.note) phaseMeta.gateNote = decision.note;
      emit({
        type: "gate.decided",
        runId: meta.runId,
        phaseId: phase.id,
        decision: phaseMeta.gateDecision,
        ...(decision.note ? { note: decision.note } : {}),
      });
    } else {
      phaseMeta.status = "rejected";
      phaseMeta.gateDecision = "rejected";
      phaseMeta.gateNote = decision.reason;
      emit({
        type: "gate.decided",
        runId: meta.runId,
        phaseId: phase.id,
        decision: "rejected",
        reason: decision.reason,
      });
    }
    return phaseMeta;
  }

  private resolveRejection(
    phase: Phase,
    iterationCount: ReadonlyMap<string, number>,
  ): Phase | undefined {
    if (!phase.on_reject) return undefined;
    const target = this.opts.workflow.findPhase(phase.on_reject.goto);
    const used = iterationCount.get(target.id) ?? 0;
    if (used >= phase.on_reject.max_iterations) return undefined;
    return target;
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
