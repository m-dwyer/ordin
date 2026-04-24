import type { Feedback } from "../domain/composer";
import type { Phase } from "../domain/workflow";
import type { Engine, EngineRunInput, EngineServices } from "./engine";
import type { RunEvent } from "./events";
import type { PhaseExecutionContext } from "./phase-execution";
import { summariseInvocation } from "./phase-runner";
import { generateRunId, type PhaseMeta, type RunMeta } from "./run-store";

/**
 * Sequential state-machine engine.
 *
 * Walks phases in declared order. After each phase, the engine calls
 * the resolved `Gate` and dispatches on the decision:
 *
 *   • approve  → advance to next phase
 *   • reject   → if the current phase has `on_reject.goto`, restart
 *                that phase with a structured `Feedback` (bounded by
 *                `max_iterations`); otherwise halt.
 *
 * Also the merging point for events: `PhaseRunner` emits lifecycle +
 * runtime-tagged events into the unified `RunEvent` stream; this
 * engine adds its own `gate.*` and `run.*` events around them.
 *
 * `MastraEngine` (Phase 11) is an alternative `Engine` implementation
 * with the same services; domain, runtimes, gates stay unchanged.
 */
export class SequentialEngine implements Engine {
  constructor(private readonly services: EngineServices) {}

  async run(input: EngineRunInput): Promise<RunMeta> {
    const { phaseRunner, gateFor, runStore } = this.services;
    const { workflow } = input;
    const runId = generateRunId(input.slug);
    const emit = input.onEvent ?? (() => {});

    const meta: RunMeta = {
      runId,
      workflow: workflow.name,
      tier: input.tier,
      task: input.task,
      slug: input.slug,
      repo: input.workspaceRoot,
      startedAt: new Date().toISOString(),
      status: "running",
      phases: [],
    };
    await runStore.writeMeta(meta);
    emit({ type: "run.started", runId });

    const iterationCount = new Map<string, number>();
    let cursor: Phase | undefined = workflow.firstPhase();
    let feedback: Feedback | undefined;

    while (cursor) {
      const currentPhase: Phase = cursor;
      const iter = (iterationCount.get(currentPhase.id) ?? 0) + 1;
      iterationCount.set(currentPhase.id, iter);
      const context = this.buildPhaseContext(runId, currentPhase, input, iter, feedback);

      const { meta: phaseMeta, invokeResult } = await phaseRunner.run({
        phase: currentPhase,
        context,
        emit,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      meta.phases.push(phaseMeta);
      await runStore.writeMeta(meta);

      if (phaseMeta.status === "failed") {
        meta.status = "failed";
        break;
      }

      const gate = gateFor(currentPhase);
      emit({ type: "gate.requested", runId, phaseId: currentPhase.id });
      const decision = await gate.request({
        runId,
        phaseId: currentPhase.id,
        cwd: input.workspaceRoot,
        artefacts: context.artefactOutputs,
        summary: summariseInvocation(invokeResult),
      });

      if (decision.status === "approved") {
        phaseMeta.status = "completed";
        phaseMeta.gateDecision = gate.kind === "auto" ? "auto" : "approved";
        if (decision.note) phaseMeta.gateNote = decision.note;
        emit({
          type: "gate.decided",
          runId,
          phaseId: currentPhase.id,
          decision: phaseMeta.gateDecision,
          ...(decision.note ? { note: decision.note } : {}),
        });
        await runStore.writeMeta(meta);
        feedback = undefined;
        cursor = workflow.nextPhase(currentPhase.id);
        continue;
      }

      // Rejected.
      phaseMeta.status = "rejected";
      phaseMeta.gateDecision = "rejected";
      phaseMeta.gateNote = decision.reason;
      emit({
        type: "gate.decided",
        runId,
        phaseId: currentPhase.id,
        decision: "rejected",
        reason: decision.reason,
      });
      await runStore.writeMeta(meta);

      const target = this.resolveRejection(currentPhase, iterationCount, workflow);
      if (!target) {
        meta.status = "halted";
        break;
      }
      feedback = {
        fromPhase: currentPhase.id,
        decision: "rejected",
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
      cursor = target;
    }

    if (meta.status === "running") meta.status = "completed";
    meta.completedAt = new Date().toISOString();
    await runStore.writeMeta(meta);
    emit({ type: "run.completed", runId, status: meta.status });
    return meta;
  }

  private buildPhaseContext(
    runId: string,
    phase: Phase,
    input: EngineRunInput,
    iteration: number,
    feedback: Feedback | undefined,
  ): PhaseExecutionContext {
    return {
      runId,
      workspaceRoot: input.workspaceRoot,
      task: input.task,
      tier: input.tier,
      iteration,
      artefactInputs: input.artefactInputs?.get(phase.id) ?? [],
      artefactOutputs: input.artefactOutputs?.get(phase.id) ?? [],
      ...(feedback ? { feedback } : {}),
    };
  }

  private resolveRejection(
    phase: Phase,
    iterationCount: ReadonlyMap<string, number>,
    workflow: EngineRunInput["workflow"],
  ): Phase | undefined {
    if (!phase.on_reject) return undefined;
    const target = workflow.findPhase(phase.on_reject.goto);
    const used = iterationCount.get(target.id) ?? 0;
    if (used >= phase.on_reject.max_iterations) return undefined;
    return target;
  }
}

// Type aliases for the values PhaseMeta carries forward unchanged.
export type { PhaseMeta, RunEvent };
