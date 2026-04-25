import { ArtefactManager } from "../domain/artefact";
import type { ArtefactPointer, Feedback } from "../domain/composer";
import { type Phase, resolveArtefactPath } from "../domain/workflow";
import type { EngineRunInput, EngineServices } from "./engine";
import type { RunEvent } from "./events";
import { type PhaseRunner, summariseInvocation } from "./phase-runner";
import type { RunMeta } from "./run-store";

export type EngineOutcome = "halted" | "failed";

/**
 * Engine-internal context for one phase transaction. The engine builds
 * this once per run; `phaseRunner` is constructed inside the engine
 * (not handed in by the harness), and gate decisions arrive via the
 * `onGateRequested` callback the application supplied on `EngineRunInput`.
 */
export interface PhaseExecutorContext {
  readonly runId: string;
  readonly meta: RunMeta;
  readonly input: EngineRunInput;
  readonly services: EngineServices;
  readonly phaseRunner: PhaseRunner;
  readonly emit: (event: RunEvent) => void;
  readonly iterations: Map<string, number>;
  feedback: Feedback | undefined;
  outcome: EngineOutcome | undefined;
}

export interface PhaseExecutionOutcome {
  readonly approved: boolean;
}

/**
 * Engine-neutral phase transaction:
 * execute runtime phase, persist phase meta, surface a `GateRequest`
 * via the application-supplied callback, and update feedback/outcome
 * for the caller's workflow-control layer. Engine has no `Gate` impl
 * — gate logic lives at the harness layer.
 */
export async function executePhase(
  phase: Phase,
  ctx: PhaseExecutorContext,
): Promise<PhaseExecutionOutcome> {
  const iteration = nextIteration(phase, ctx);
  const artefactInputs = resolveArtefacts(phase.inputs, ctx.input.slug);
  const artefactOutputs = resolveArtefacts(phase.outputs, ctx.input.slug);
  const artefacts = new ArtefactManager(ctx.input.workspaceRoot);

  const missingIn = await artefacts.findMissing(artefactInputs);
  if (missingIn.length > 0) {
    return await failBeforeRuntime(
      phase,
      ctx,
      iteration,
      `Phase "${phase.id}" declared inputs that are missing on disk: ${missingIn
        .map((m) => m.path)
        .join(", ")}`,
    );
  }

  const runDir = await ctx.services.runStore.ensureRunDir(ctx.runId);

  const { meta: phaseMeta, invokeResult } = await ctx.phaseRunner.run({
    phase,
    context: {
      runId: ctx.runId,
      workflow: ctx.input.workflow,
      runDir,
      workspaceRoot: ctx.input.workspaceRoot,
      task: ctx.input.task,
      tier: ctx.input.tier,
      iteration,
      artefactInputs,
      artefactOutputs,
      ...(ctx.feedback ? { feedback: ctx.feedback } : {}),
    },
    emit: ctx.emit,
    ...(ctx.input.abortSignal ? { abortSignal: ctx.input.abortSignal } : {}),
  });

  ctx.meta.phases.push(phaseMeta);
  await ctx.services.runStore.writeMeta(ctx.meta);

  if (phaseMeta.status === "failed") {
    ctx.outcome = "failed";
    return { approved: false };
  }

  const missingOut = await artefacts.findMissing(artefactOutputs);
  if (missingOut.length > 0) {
    const error = `Phase "${phase.id}" declared outputs that were not written: ${missingOut
      .map((m) => m.path)
      .join(", ")}`;
    phaseMeta.status = "failed";
    phaseMeta.error = error;
    await ctx.services.runStore.writeMeta(ctx.meta);
    ctx.emit({
      type: "phase.failed",
      runId: ctx.runId,
      phaseId: phase.id,
      iteration,
      error,
    });
    ctx.outcome = "failed";
    return { approved: false };
  }

  ctx.emit({ type: "gate.requested", runId: ctx.runId, phaseId: phase.id });
  const decision = await ctx.input.onGateRequested({
    runId: ctx.runId,
    phaseId: phase.id,
    gateKind: phase.gate,
    cwd: ctx.input.workspaceRoot,
    artefacts: artefactOutputs,
    summary: summariseInvocation(invokeResult),
  });

  if (decision.status === "approved") {
    phaseMeta.status = "completed";
    phaseMeta.gateDecision = phase.gate === "auto" ? "auto" : "approved";
    if (decision.note) phaseMeta.gateNote = decision.note;
    ctx.feedback = undefined;
    ctx.emit({
      type: "gate.decided",
      runId: ctx.runId,
      phaseId: phase.id,
      decision: phaseMeta.gateDecision,
      ...(decision.note ? { note: decision.note } : {}),
    });
    await ctx.services.runStore.writeMeta(ctx.meta);
    return { approved: true };
  }

  phaseMeta.status = "rejected";
  phaseMeta.gateDecision = "rejected";
  phaseMeta.gateNote = decision.reason;
  ctx.emit({
    type: "gate.decided",
    runId: ctx.runId,
    phaseId: phase.id,
    decision: "rejected",
    reason: decision.reason,
  });
  await ctx.services.runStore.writeMeta(ctx.meta);

  if (!phase.on_reject) {
    ctx.outcome = "halted";
    return { approved: false };
  }

  ctx.feedback = {
    fromPhase: phase.id,
    decision: "rejected",
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
  return { approved: false };
}

function nextIteration(phase: Phase, ctx: PhaseExecutorContext): number {
  const iteration = (ctx.iterations.get(phase.id) ?? 0) + 1;
  ctx.iterations.set(phase.id, iteration);
  return iteration;
}

function resolveArtefacts(
  contracts: Phase["inputs"] | Phase["outputs"],
  slug: string,
): readonly ArtefactPointer[] {
  if (!contracts) return [];
  return contracts.map((contract) => ({
    label: contract.label,
    path: resolveArtefactPath(contract, slug),
    ...(contract.description ? { description: contract.description } : {}),
  }));
}

/**
 * Records a phase failure that happened before the runtime got involved
 * (e.g. missing input artefacts). PhaseMeta has no runtime/model in
 * this case — they're decided inside `PhaseRunner.run()`, which we
 * never reached.
 */
async function failBeforeRuntime(
  phase: Phase,
  ctx: PhaseExecutorContext,
  iteration: number,
  error: string,
): Promise<PhaseExecutionOutcome> {
  const now = new Date().toISOString();
  ctx.meta.phases.push({
    phaseId: phase.id,
    iteration,
    startedAt: now,
    completedAt: now,
    status: "failed",
    error,
  });
  await ctx.services.runStore.writeMeta(ctx.meta);
  ctx.emit({
    type: "phase.failed",
    runId: ctx.runId,
    phaseId: phase.id,
    iteration,
    error,
  });
  ctx.outcome = "failed";
  return { approved: false };
}
