import type { ArtefactPointer, Feedback } from "../domain/composer";
import { type Phase, resolveArtefactPath } from "../domain/workflow";
import type { EngineRunInput, EngineServices } from "./engine";
import type { RunEvent } from "./events";
import { summariseInvocation } from "./phase-runner";
import type { RunMeta } from "./run-store";

export type EngineOutcome = "halted" | "failed";

export interface PhaseExecutorContext {
  readonly runId: string;
  readonly meta: RunMeta;
  readonly input: EngineRunInput;
  readonly services: EngineServices;
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
 * execute runtime phase, persist phase meta, request gate, and update
 * feedback/outcome for the caller's workflow-control layer.
 */
export async function executePhase(
  phase: Phase,
  ctx: PhaseExecutorContext,
): Promise<PhaseExecutionOutcome> {
  const iteration = nextIteration(phase, ctx);
  const runDir = await ctx.services.runStore.ensureRunDir(ctx.runId);
  const artefactOutputs = resolveArtefacts(phase.outputs, ctx.input.slug);

  const { meta: phaseMeta, invokeResult } = await ctx.services.phaseRunner.run({
    phase,
    context: {
      runId: ctx.runId,
      workflow: ctx.input.workflow,
      runDir,
      workspaceRoot: ctx.input.workspaceRoot,
      task: ctx.input.task,
      tier: ctx.input.tier,
      iteration,
      artefactInputs: resolveArtefacts(phase.inputs, ctx.input.slug),
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

  const gate = ctx.services.gateFor(phase);
  ctx.emit({ type: "gate.requested", runId: ctx.runId, phaseId: phase.id });
  const decision = await gate.request({
    runId: ctx.runId,
    phaseId: phase.id,
    cwd: ctx.input.workspaceRoot,
    artefacts: artefactOutputs,
    summary: summariseInvocation(invokeResult),
  });

  if (decision.status === "approved") {
    phaseMeta.status = "completed";
    phaseMeta.gateDecision = gate.kind === "auto" ? "auto" : "approved";
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
