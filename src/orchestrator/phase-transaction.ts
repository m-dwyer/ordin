import { SpanStatusCode } from "@opentelemetry/api";
import type { ArtefactPointer, Feedback } from "../domain/composer";
import { type PhasePreparer, type PhasePreview, resolveArtefacts } from "../domain/phase-preview";
import type { Phase, WorkflowManifest } from "../domain/workflow";
import { ArtefactManager } from "../infrastructure/artefact-manager";
import { withSpan } from "../observability/spans";
import type { EngineRunInput, EngineServices } from "./engine";
import type { RunEvent } from "./events";
import { GateCoordinator } from "./gate-coordinator";
import { diagnoseMissingOutputs } from "./phase-diagnostics";
import type { PhaseRunResult } from "./phase-runner";
import type { PhaseMeta, RunMeta } from "./run-store";

export type EngineOutcome = "halted" | "failed";

/**
 * Engine-internal context for one phase transaction. The engine builds
 * this once per run; `phaseRunner` and `preparer` are constructed
 * inside the engine (not handed in by the harness), and gate decisions
 * arrive via the `onGateRequested` callback the application supplied
 * on `EngineRunInput`.
 */
export interface PhaseTransactionContext {
  readonly runId: string;
  readonly meta: RunMeta;
  readonly manifest: WorkflowManifest;
  readonly input: EngineRunInput;
  readonly services: EngineServices;
  readonly preparer: PhasePreparer;
  readonly emit: (event: RunEvent) => void;
  readonly iterations: Map<string, number>;
  feedback: Feedback | undefined;
  outcome: EngineOutcome | undefined;
}

export interface PhaseExecutionOutcome {
  readonly approved: boolean;
}

interface PhaseInvocationPlan {
  readonly preview: PhasePreview;
  readonly runtimeName: string;
}

type PlanningResult =
  | { readonly ok: true; readonly plan: PhaseInvocationPlan }
  | { readonly ok: false; readonly error: string };

/**
 * One phase, executed as a single transaction. Steps:
 *
 *   1. Bump iteration counter.
 *   2. Resolve declared input/output artefact contracts.
 *   3. Pre-flight: verify all declared inputs exist on disk.
 *   4. Plan the invocation (compose prompt, resolve runtime name).
 *   5. Invoke the runtime via the engine-supplied dispatcher.
 *   6. Post-flight: verify all declared outputs exist on disk.
 *   7. Request a gate decision via `GateCoordinator`.
 *   8. Apply approval/rejection — set feedback/outcome for the engine
 *      to drive its next loop iteration or halt.
 *
 * `execute()` reads as a checklist; the supporting logic (artefact
 * resolution, invocation planning, runtime dispatch, run-meta
 * recording) lives in private methods on this class — all are called
 * from one place and have no second adapter, so they don't earn their
 * own seam. `GateCoordinator` is the single external collaborator
 * because its responsibility is genuinely distinct (status transitions,
 * feedback synthesis, gate-event emission) and a future
 * `LangGraphEngine` may want to swap it for an `interrupt()`-based
 * variant.
 */
class PhaseTransaction {
  private readonly artefacts: ArtefactManager;
  private readonly gate: GateCoordinator;

  constructor(private readonly ctx: PhaseTransactionContext) {
    this.artefacts = new ArtefactManager(ctx.input.workspaceRoot);
    this.gate = new GateCoordinator({
      runId: ctx.runId,
      input: ctx.input,
      emit: ctx.emit,
    });
  }

  async execute(phase: Phase): Promise<PhaseExecutionOutcome> {
    const iteration = this.bumpIteration(phase);
    const inputs = resolveArtefacts(phase.inputs, this.ctx.input.slug);
    const outputs = resolveArtefacts(phase.outputs, this.ctx.input.slug);

    const missingIn = await this.artefacts.findMissing(inputs);
    if (missingIn.length > 0) {
      return await this.failBeforeRuntime(
        phase,
        iteration,
        formatMissing("inputs that are missing on disk", phase, missingIn),
      );
    }

    const planning = this.planInvocation(phase, inputs, outputs);
    if (!planning.ok) {
      return await this.failBeforeRuntime(phase, iteration, planning.error);
    }

    const { meta: phaseMeta, invokeResult, events } = await this.invoke(planning.plan, iteration);
    await this.recordRunResult(phaseMeta);

    if (phaseMeta.status === "failed") {
      this.ctx.outcome = "failed";
      return { approved: false };
    }

    const missingOut = await this.artefacts.findMissing(outputs);
    if (missingOut.length > 0) {
      const summary = formatMissing("outputs that were not written", phase, missingOut);
      const diagnosis = diagnoseMissingOutputs(missingOut, events, phaseMeta.transcriptPath);
      return await this.failAfterRuntime(phase, phaseMeta, iteration, `${summary}\n${diagnosis}`);
    }

    const gateDecision = await this.gate.decide(phase, phaseMeta, invokeResult, outputs);
    await this.writeMeta();

    this.ctx.feedback = gateDecision.feedback;
    this.ctx.outcome = gateDecision.outcome;
    return { approved: gateDecision.approved };
  }

  private bumpIteration(phase: Phase): number {
    const n = (this.ctx.iterations.get(phase.id) ?? 0) + 1;
    this.ctx.iterations.set(phase.id, n);
    return n;
  }

  private planInvocation(
    phase: Phase,
    artefactInputs: readonly ArtefactPointer[],
    artefactOutputs: readonly ArtefactPointer[],
  ): PlanningResult {
    const agent = this.ctx.services.agents.get(phase.agent);
    if (!agent) {
      return {
        ok: false,
        error: `Agent "${phase.agent}" declared by phase "${phase.id}" not loaded`,
      };
    }

    const preview = this.ctx.preparer.prepare({
      phase,
      agent,
      workflow: this.ctx.manifest,
      config: this.ctx.services.config,
      task: this.ctx.input.task,
      cwd: this.ctx.input.workspaceRoot,
      tier: this.ctx.input.tier,
      artefactInputs,
      artefactOutputs,
      ...(this.ctx.feedback ? { feedback: this.ctx.feedback } : {}),
    });

    if (!this.ctx.services.runtimeNames.has(preview.runtimeName)) {
      return {
        ok: false,
        error: `Runtime "${preview.runtimeName}" resolved for phase "${phase.id}" not registered`,
      };
    }

    return { ok: true, plan: { preview, runtimeName: preview.runtimeName } };
  }

  private async invoke(plan: PhaseInvocationPlan, iteration: number): Promise<PhaseRunResult> {
    const runDir = await this.ctx.services.runStore.ensureRunDir(this.ctx.runId);
    return this.ctx.input.dispatchPhase({
      runId: this.ctx.runId,
      runDir,
      iteration,
      preview: plan.preview,
      runtimeName: plan.runtimeName,
      emit: this.ctx.emit,
      ...(this.ctx.input.abortSignal ? { abortSignal: this.ctx.input.abortSignal } : {}),
    });
  }

  private async recordRunResult(phaseMeta: PhaseMeta): Promise<void> {
    this.ctx.meta.phases.push(phaseMeta);
    await this.writeMeta();
  }

  private writeMeta(): Promise<void> {
    return this.ctx.services.runStore.writeMeta(this.ctx.meta);
  }

  /**
   * Records a phase failure that happened before the runtime got
   * involved (missing input artefacts, agent lookup miss). PhaseMeta
   * has no runtime/model in this case — they're decided inside
   * `PhaseRunner.run()`, which we never reached.
   */
  private async failBeforeRuntime(
    phase: Phase,
    iteration: number,
    error: string,
  ): Promise<PhaseExecutionOutcome> {
    const now = new Date().toISOString();
    this.ctx.meta.phases.push({
      phaseId: phase.id,
      iteration,
      startedAt: now,
      completedAt: now,
      status: "failed",
      error,
    });
    await this.writeMeta();
    this.emitFailure(phase, iteration, error);
    this.ctx.outcome = "failed";
    return { approved: false };
  }

  /**
   * Records a phase failure detected after the runtime returned ok
   * (declared outputs missing). PhaseMeta is already in the run state,
   * so mutate it in place and emit the final phase failure.
   */
  private async failAfterRuntime(
    phase: Phase,
    phaseMeta: PhaseMeta,
    iteration: number,
    error: string,
  ): Promise<PhaseExecutionOutcome> {
    phaseMeta.status = "failed";
    phaseMeta.error = error;
    await this.writeMeta();
    this.emitFailure(phase, iteration, error);
    this.ctx.outcome = "failed";
    return { approved: false };
  }

  private emitFailure(phase: Phase, iteration: number, error: string): void {
    this.ctx.emit({
      type: "phase.failed",
      runId: this.ctx.runId,
      phaseId: phase.id,
      iteration,
      error,
    });
  }
}

function formatMissing(suffix: string, phase: Phase, missing: readonly ArtefactPointer[]): string {
  return `Phase "${phase.id}" declared ${suffix}: ${missing.map((m) => m.path).join(", ")}`;
}

/**
 * Engine-neutral phase transaction entry point. Engines call this
 * once per phase step with their per-run context.
 */
export async function executePhase(
  phase: Phase,
  ctx: PhaseTransactionContext,
): Promise<PhaseExecutionOutcome> {
  const iteration = (ctx.iterations.get(phase.id) ?? 0) + 1;
  return withSpan(
    `ordin.phase.${phase.id}`,
    {
      "ordin.run_id": ctx.runId,
      "ordin.phase_id": phase.id,
      "ordin.agent": phase.agent,
      "ordin.iteration": iteration,
      "langfuse.observation.input": `phase=${phase.id} agent=${phase.agent} iteration=${iteration}\n${ctx.input.task}`,
    },
    async (span) => {
      const result = await new PhaseTransaction(ctx).execute(phase);
      const failure = phaseFailure(ctx.meta, phase.id, iteration);
      span.setAttribute("ordin.approved", result.approved);
      if (ctx.outcome) span.setAttribute("ordin.outcome", ctx.outcome);
      if (failure) {
        span.setAttribute("ordin.error", failure);
        span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
      }
      span.setAttribute(
        "langfuse.observation.output",
        phaseOutput(result.approved, ctx.outcome, failure),
      );
      return result;
    },
  );
}

function phaseFailure(meta: RunMeta, phaseId: string, iteration: number): string | undefined {
  return meta.phases.find((p) => p.phaseId === phaseId && p.iteration === iteration)?.error;
}

function phaseOutput(
  approved: boolean,
  outcome: PhaseTransactionContext["outcome"],
  failure: string | undefined,
): string {
  if (failure) return `outcome=${outcome ?? "failed"}\nerror=${failure}`;
  if (outcome) return `outcome=${outcome}`;
  return `approved=${approved}`;
}
