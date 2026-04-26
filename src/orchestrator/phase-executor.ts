import type { Feedback } from "../domain/composer";
import type { PhasePreparer } from "../domain/phase-preview";
import type { Phase, WorkflowManifest } from "../domain/workflow";
import { withSpan } from "../observability/spans";
import type { EngineRunInput, EngineServices } from "./engine";
import type { RunEvent } from "./events";
import { GateCoordinator } from "./gate-coordinator";
import { formatMissing, PhaseArtefactVerifier } from "./phase-artefacts";
import { PhaseInvocationPlanner, PhaseInvoker } from "./phase-invocation";
import { PhaseRecorder } from "./phase-recorder";
import type { PhaseRunner } from "./phase-runner";
import type { PhaseMeta, RunMeta } from "./run-store";

export type EngineOutcome = "halted" | "failed";

/**
 * Engine-internal context for one phase transaction. The engine builds
 * this once per run; `phaseRunner` and `preparer` are constructed
 * inside the engine (not handed in by the harness), and gate decisions
 * arrive via the `onGateRequested` callback the application supplied
 * on `EngineRunInput`.
 */
export interface PhaseExecutorContext {
  readonly runId: string;
  readonly meta: RunMeta;
  readonly manifest: WorkflowManifest;
  readonly input: EngineRunInput;
  readonly services: EngineServices;
  readonly phaseRunner: PhaseRunner;
  readonly preparer: PhasePreparer;
  readonly emit: (event: RunEvent) => void;
  readonly iterations: Map<string, number>;
  feedback: Feedback | undefined;
  outcome: EngineOutcome | undefined;
}

export interface PhaseExecutionOutcome {
  readonly approved: boolean;
}

/**
 * One phase, executed as a single transaction. Steps:
 *
 *   1. Bump iteration counter.
 *   2. Resolve declared input/output artefact contracts.
 *   3. Pre-flight: verify all declared inputs exist on disk.
 *   4. Prepare the phase (compose prompt, resolve runtime name).
 *   5. Invoke the runtime via PhaseRunner.
 *   6. Post-flight: verify all declared outputs exist on disk.
 *   7. Request a gate decision via the engine's `onGateRequested`.
 *   8. Apply approval/rejection — set feedback/outcome for the engine
 *      to drive its next loop iteration or halt.
 *
 * Each step is a private method named after what it does. `execute()`
 * reads as a checklist.
 */
class PhaseTransaction {
  private readonly artefacts: PhaseArtefactVerifier;
  private readonly invocationPlanner: PhaseInvocationPlanner;
  private readonly invoker: PhaseInvoker;
  private readonly gateCoordinator: GateCoordinator;
  private readonly recorder: PhaseRecorder;

  constructor(private readonly ctx: PhaseExecutorContext) {
    this.artefacts = new PhaseArtefactVerifier(ctx.input.workspaceRoot);
    this.invocationPlanner = new PhaseInvocationPlanner(ctx.input, ctx.services, ctx.preparer);
    this.invoker = new PhaseInvoker({
      runId: ctx.runId,
      input: ctx.input,
      services: ctx.services,
      phaseRunner: ctx.phaseRunner,
      emit: ctx.emit,
    });
    this.gateCoordinator = new GateCoordinator({
      runId: ctx.runId,
      input: ctx.input,
      emit: ctx.emit,
    });
    this.recorder = new PhaseRecorder({
      runId: ctx.runId,
      meta: ctx.meta,
      runStore: ctx.services.runStore,
      emit: ctx.emit,
    });
  }

  async execute(phase: Phase): Promise<PhaseExecutionOutcome> {
    const iteration = this.bumpIteration(phase);
    const { inputs, outputs } = this.artefacts.resolve(phase, this.ctx.input.slug);

    const missingIn = await this.artefacts.findMissing(inputs);
    if (missingIn.length > 0) {
      return await this.failBeforeRuntime(
        phase,
        iteration,
        formatMissing("inputs that are missing on disk", phase, missingIn),
      );
    }

    const invocation = this.invocationPlanner.plan(
      this.ctx.manifest,
      phase,
      inputs,
      outputs,
      this.ctx.feedback,
    );
    if (!invocation.ok) {
      return await this.failBeforeRuntime(phase, iteration, invocation.error);
    }

    const { meta: phaseMeta, invokeResult } = await this.invoker.invoke(invocation.plan, iteration);
    await this.recorder.recordRunResult(phaseMeta);

    if (phaseMeta.status === "failed") {
      this.ctx.outcome = "failed";
      return { approved: false };
    }

    const missingOut = await this.artefacts.findMissing(outputs);
    if (missingOut.length > 0) {
      return await this.failAfterRuntime(
        phase,
        phaseMeta,
        iteration,
        formatMissing("outputs that were not written", phase, missingOut),
      );
    }

    const gateDecision = await this.gateCoordinator.decide(phase, phaseMeta, invokeResult, outputs);
    await this.recorder.write();

    this.ctx.feedback = gateDecision.feedback;
    this.ctx.outcome = gateDecision.outcome;
    return { approved: gateDecision.approved };
  }

  private bumpIteration(phase: Phase): number {
    const n = (this.ctx.iterations.get(phase.id) ?? 0) + 1;
    this.ctx.iterations.set(phase.id, n);
    return n;
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
    await this.recorder.recordPreRuntimeFailure(phase, iteration, error);
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
    await this.recorder.recordPostRuntimeFailure(phase, phaseMeta, iteration, error);
    this.ctx.outcome = "failed";
    return { approved: false };
  }
}

/**
 * Engine-neutral phase transaction entry point. Engines call this
 * once per phase step with their per-run context.
 */
export async function executePhase(
  phase: Phase,
  ctx: PhaseExecutorContext,
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
      span.setAttribute("ordin.approved", result.approved);
      if (ctx.outcome) span.setAttribute("ordin.outcome", ctx.outcome);
      span.setAttribute(
        "langfuse.observation.output",
        ctx.outcome ? `outcome=${ctx.outcome}` : `approved=${result.approved}`,
      );
      return result;
    },
  );
}
