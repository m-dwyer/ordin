import type { Agent } from "../domain/agent";
import type { ArtefactPointer } from "../domain/composer";
import type { HarnessConfig } from "../domain/config";
import type { Skill } from "../domain/skill";
import type { Phase, Workflow } from "../domain/workflow";
import type { Gate } from "../gates/types";
import type { AgentRuntime } from "../runtimes/types";
import type { RunEvent } from "./events";
import type { PhaseExecutionContext } from "./phase-execution";
import { PhaseRunner } from "./phase-runner";
import { generateRunId, type RunMeta, type RunStore } from "./run-store";

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
  readonly workspaceRoot: string;
  readonly tier: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  readonly artefactInputs?: ReadonlyMap<string, readonly ArtefactPointer[]>;
  readonly artefactOutputs?: ReadonlyMap<string, readonly ArtefactPointer[]>;
  readonly abortSignal?: AbortSignal;
}

export class SequentialOrchestrator {
  private readonly phaseRunner: PhaseRunner;

  constructor(private readonly opts: OrchestratorOptions) {
    this.phaseRunner = new PhaseRunner(opts);
  }

  async run(input: RunInput): Promise<RunMeta> {
    const runId = generateRunId(input.slug);
    const emit = input.onEvent ?? (() => {});

    const meta: RunMeta = {
      runId,
      workflow: this.opts.workflow.name,
      tier: input.tier,
      task: input.task,
      slug: input.slug,
      repo: input.workspaceRoot,
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
      const context = this.buildPhaseContext(runId, currentPhase, input, iter, iterationContext);

      const phaseMeta = await this.phaseRunner.execute({
        phase: currentPhase,
        context,
        emit,
        abortSignal: input.abortSignal,
      });
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

  private buildPhaseContext(
    runId: string,
    phase: Phase,
    input: RunInput,
    iteration: number,
    iterationContext: string | undefined,
  ): PhaseExecutionContext {
    // Keep per-phase execution state data-only so a future graph
    // orchestrator can checkpoint/resume it cleanly.
    return {
      runId,
      workspaceRoot: input.workspaceRoot,
      task: input.task,
      tier: input.tier,
      iteration,
      artefactInputs: input.artefactInputs?.get(phase.id) ?? [],
      artefactOutputs: input.artefactOutputs?.get(phase.id) ?? [],
      ...(iterationContext ? { iterationContext } : {}),
    };
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
