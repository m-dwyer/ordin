import type { ArtefactPointer, Feedback } from "../domain/composer";
import { type PhasePreparer, type PhasePreview, resolveArtefacts } from "../domain/phase-preview";
import type { Phase } from "../domain/workflow";
import { ArtefactManager } from "../infrastructure/artefact-manager";
import type { AgentRuntime } from "../runtimes/types";
import type { EngineRunInput, EngineServices } from "./engine";
import type { RunEvent } from "./events";
import { type PhaseRunner, type PhaseRunResult, summariseInvocation } from "./phase-runner";
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
  private readonly artefacts: ArtefactManager;

  constructor(private readonly ctx: PhaseExecutorContext) {
    this.artefacts = new ArtefactManager(ctx.input.workspaceRoot);
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

    const preview = this.preparePhase(phase, inputs, outputs);
    if (!preview) {
      return await this.failBeforeRuntime(
        phase,
        iteration,
        `Agent "${phase.agent}" declared by phase "${phase.id}" not loaded`,
      );
    }

    const runtime = this.ctx.services.runtimes.get(preview.runtimeName);
    if (!runtime) {
      return await this.failBeforeRuntime(
        phase,
        iteration,
        `Runtime "${preview.runtimeName}" resolved for phase "${phase.id}" not registered`,
      );
    }

    const runDir = await this.ctx.services.runStore.ensureRunDir(this.ctx.runId);
    const { meta: phaseMeta, invokeResult } = await this.invoke(
      preview,
      runtime,
      iteration,
      runDir,
    );
    this.ctx.meta.phases.push(phaseMeta);
    await this.ctx.services.runStore.writeMeta(this.ctx.meta);

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

    return await this.handleGate(phase, phaseMeta, invokeResult, outputs);
  }

  private bumpIteration(phase: Phase): number {
    const n = (this.ctx.iterations.get(phase.id) ?? 0) + 1;
    this.ctx.iterations.set(phase.id, n);
    return n;
  }

  private preparePhase(
    phase: Phase,
    artefactInputs: readonly ArtefactPointer[],
    artefactOutputs: readonly ArtefactPointer[],
  ): PhasePreview | undefined {
    const agent = this.ctx.services.agents.get(phase.agent);
    if (!agent) return undefined;
    return this.ctx.preparer.prepare({
      phase,
      agent,
      workflow: this.ctx.input.workflow,
      config: this.ctx.services.config,
      task: this.ctx.input.task,
      cwd: this.ctx.input.workspaceRoot,
      tier: this.ctx.input.tier,
      artefactInputs,
      artefactOutputs,
      ...(this.ctx.feedback ? { feedback: this.ctx.feedback } : {}),
    });
  }

  private async invoke(
    preview: PhasePreview,
    runtime: AgentRuntime,
    iteration: number,
    runDir: string,
  ): Promise<PhaseRunResult> {
    return this.ctx.phaseRunner.run({
      preview,
      runtime,
      context: { runId: this.ctx.runId, runDir, iteration },
      emit: this.ctx.emit,
      ...(this.ctx.input.abortSignal ? { abortSignal: this.ctx.input.abortSignal } : {}),
    });
  }

  private async handleGate(
    phase: Phase,
    phaseMeta: PhaseMeta,
    invokeResult: Parameters<typeof summariseInvocation>[0],
    outputs: readonly ArtefactPointer[],
  ): Promise<PhaseExecutionOutcome> {
    this.ctx.emit({ type: "gate.requested", runId: this.ctx.runId, phaseId: phase.id });
    const decision = await this.ctx.input.onGateRequested({
      runId: this.ctx.runId,
      phaseId: phase.id,
      gateKind: phase.gate,
      cwd: this.ctx.input.workspaceRoot,
      artefacts: outputs,
      summary: summariseInvocation(invokeResult),
    });

    if (decision.status === "approved") {
      phaseMeta.status = "completed";
      phaseMeta.gateDecision = phase.gate === "auto" ? "auto" : "approved";
      if (decision.note) phaseMeta.gateNote = decision.note;
      this.ctx.feedback = undefined;
      this.ctx.emit({
        type: "gate.decided",
        runId: this.ctx.runId,
        phaseId: phase.id,
        decision: phaseMeta.gateDecision,
        ...(decision.note ? { note: decision.note } : {}),
      });
      this.ctx.emit({
        type: "phase.completed",
        runId: this.ctx.runId,
        phaseId: phase.id,
        iteration: phaseMeta.iteration,
        tokens: invokeResult.tokens,
        durationMs: invokeResult.durationMs,
      });
      await this.ctx.services.runStore.writeMeta(this.ctx.meta);
      return { approved: true };
    }

    phaseMeta.status = "rejected";
    phaseMeta.gateDecision = "rejected";
    phaseMeta.gateNote = decision.reason;
    this.ctx.emit({
      type: "gate.decided",
      runId: this.ctx.runId,
      phaseId: phase.id,
      decision: "rejected",
      reason: decision.reason,
    });
    await this.ctx.services.runStore.writeMeta(this.ctx.meta);

    if (!phase.on_reject) {
      this.ctx.outcome = "halted";
      return { approved: false };
    }

    this.ctx.feedback = {
      fromPhase: phase.id,
      decision: "rejected",
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
    return { approved: false };
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
    await this.ctx.services.runStore.writeMeta(this.ctx.meta);
    this.ctx.emit({
      type: "phase.failed",
      runId: this.ctx.runId,
      phaseId: phase.id,
      iteration,
      error,
    });
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
    await this.ctx.services.runStore.writeMeta(this.ctx.meta);
    this.ctx.emit({
      type: "phase.failed",
      runId: this.ctx.runId,
      phaseId: phase.id,
      iteration,
      error,
    });
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
  return new PhaseTransaction(ctx).execute(phase);
}

function formatMissing(suffix: string, phase: Phase, missing: readonly ArtefactPointer[]): string {
  return `Phase "${phase.id}" declared ${suffix}: ${missing.map((m) => m.path).join(", ")}`;
}
