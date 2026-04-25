import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { ArtefactPointer, Feedback } from "../../domain/composer";
import { type Phase, resolveArtefactPath, type Workflow } from "../../domain/workflow";
import type { Engine, EngineRunInput, EngineServices } from "../engine";
import type { RunEvent } from "../events";
import { summariseInvocation } from "../phase-runner";
import { generateRunId, type RunMeta } from "../run-store";

/**
 * Mastra-backed engine. Each phase is a `createStep`; a single
 * `on_reject` back-edge compiles as one compound loop step (running
 * the `[goto..rejecter]` segment in order) wrapped in `.dountil()`.
 *
 * v1 constraints (throw at compile time):
 *   • At most one phase may declare `on_reject`.
 *   • `on_reject.goto` must target an earlier phase.
 *
 * Mastra step input/output is a minimal `{ approved? }` discriminator
 * — real per-run state lives in a closure-captured `RunCtx` so it
 * doesn't leak into Mastra's persisted workflow state.
 */
const Gate = z.object({ approved: z.boolean().optional() });

interface RunCtx {
  readonly runId: string;
  readonly meta: RunMeta;
  readonly input: EngineRunInput;
  readonly services: EngineServices;
  readonly emit: (event: RunEvent) => void;
  readonly iter: Map<string, number>;
  feedback: Feedback | undefined;
  /**
   * Set to "halted" / "failed" by a step before it calls Mastra's
   * `bail()` to end the workflow. Mastra ends the workflow cleanly
   * (status "bailed"), so the engine reads halt vs. fail intent from
   * this flag rather than inspecting the bail payload.
   */
  outcome: "halted" | "failed" | undefined;
}

/**
 * Mastra step `bail(result)` ends the workflow cleanly with status
 * "bailed". At runtime it returns an `InnerOutput` sentinel that
 * Mastra unwraps; we type it as the step's output shape so the
 * `execute` function can return it directly. Only called from the
 * step boundary — `runOnePhase` keeps a plain return shape.
 */
type Bail = (result: { approved: boolean }) => { approved: boolean };

export class MastraEngine implements Engine {
  constructor(private readonly services: EngineServices) {}

  async run(input: EngineRunInput): Promise<RunMeta> {
    const runId = generateRunId(input.slug);
    const emit = input.onEvent ?? ((_: RunEvent) => {});
    const meta: RunMeta = {
      runId,
      workflow: input.workflow.name,
      tier: input.tier,
      task: input.task,
      slug: input.slug,
      repo: input.workspaceRoot,
      startedAt: new Date().toISOString(),
      status: "running",
      phases: [],
    };
    await this.services.runStore.writeMeta(meta);
    emit({ type: "run.started", runId });

    const ctx: RunCtx = {
      runId,
      meta,
      input,
      services: this.services,
      emit,
      iter: new Map(),
      feedback: undefined,
      outcome: undefined,
    };

    const wf = compile(input.workflow, ctx);
    const run = await wf.createRun();
    const result = await run.start({ inputData: {} });

    if (ctx.outcome) {
      // A step set the outcome before bailing — `result.status` will
      // be "bailed" for halt/fail; ctx carries the intent.
      meta.status = ctx.outcome;
    } else if (result.status === "success") {
      meta.status = "completed";
    } else {
      // Mastra returned failed/suspended/tripwire and no step set
      // ctx.outcome — treat as a real engine error.
      meta.completedAt = new Date().toISOString();
      meta.status = "failed";
      await this.services.runStore.writeMeta(meta);
      const err = (result as { error?: unknown }).error;
      throw err instanceof Error ? err : new Error(`Workflow ${result.status}`);
    }

    meta.completedAt = new Date().toISOString();
    await this.services.runStore.writeMeta(meta);
    emit({ type: "run.completed", runId, status: meta.status });
    return meta;
  }
}

function compile(workflow: Workflow, ctx: RunCtx) {
  const phases = workflow.phases;
  const rejecters = phases.filter((p) => p.on_reject);
  if (rejecters.length > 1) {
    throw new Error(
      `MastraEngine supports at most one on_reject per workflow; "${workflow.name}" has ${rejecters.length}`,
    );
  }
  const rejecter = rejecters[0];
  const rejecterIdx = rejecter ? phases.indexOf(rejecter) : -1;
  const targetIdx = rejecter ? phases.findIndex((p) => p.id === rejecter.on_reject?.goto) : -1;
  if (rejecter && (targetIdx < 0 || targetIdx >= rejecterIdx)) {
    throw new Error(
      `on_reject.goto must target an earlier phase (phase "${rejecter.id}" → "${rejecter.on_reject?.goto}")`,
    );
  }

  const phaseStep = (phase: Phase) =>
    createStep({
      id: phase.id,
      inputSchema: Gate,
      outputSchema: Gate,
      execute: async ({ bail }) => {
        const result = await runOnePhase(phase, ctx);
        return ctx.outcome ? (bail as unknown as Bail)(result) : result;
      },
    });

  let wf = createWorkflow({
    id: `ordin-${workflow.name}`,
    inputSchema: Gate,
    outputSchema: Gate,
  });

  if (!rejecter) {
    for (const p of phases) wf = wf.then(phaseStep(p));
    return wf.commit();
  }

  for (let i = 0; i < targetIdx; i++) wf = wf.then(phaseStep(phases[i] as Phase));

  const loopSegment = phases.slice(targetIdx, rejecterIdx + 1);
  const loopStep = createStep({
    id: `ordin-${workflow.name}-loop`,
    inputSchema: Gate,
    outputSchema: Gate,
    execute: async ({ bail }) => {
      for (const phase of loopSegment) {
        const result = await runOnePhase(phase, ctx);
        // A non-rejecter halt or runtime failure inside the loop must
        // end the workflow, not just the iteration.
        if (ctx.outcome) return (bail as unknown as Bail)(result);
        if (!result.approved) return result; // rejecter rejected → dountil retries.
      }
      return { approved: true };
    },
  });
  const maxIter = rejecter.on_reject?.max_iterations ?? 1;
  wf = wf.dountil(loopStep, async ({ inputData }: { inputData: z.infer<typeof Gate> }) => {
    if (inputData.approved === true) return true;
    const used = ctx.iter.get(rejecter.id) ?? 0;
    if (used >= maxIter) {
      ctx.outcome = "halted";
      return true;
    }
    return false;
  });

  for (let i = rejecterIdx + 1; i < phases.length; i++) {
    wf = wf.then(phaseStep(phases[i] as Phase));
  }
  return wf.commit();
}

async function runOnePhase(phase: Phase, ctx: RunCtx): Promise<{ approved: boolean }> {
  const iter = (ctx.iter.get(phase.id) ?? 0) + 1;
  ctx.iter.set(phase.id, iter);

  const artefactInputs = resolveArtefacts(phase.inputs, ctx.input.slug);
  const artefactOutputs = resolveArtefacts(phase.outputs, ctx.input.slug);

  const { meta: phaseMeta, invokeResult } = await ctx.services.phaseRunner.run({
    phase,
    context: {
      runId: ctx.runId,
      workspaceRoot: ctx.input.workspaceRoot,
      task: ctx.input.task,
      tier: ctx.input.tier,
      iteration: iter,
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
    ctx.emit({
      type: "gate.decided",
      runId: ctx.runId,
      phaseId: phase.id,
      decision: phaseMeta.gateDecision,
      ...(decision.note ? { note: decision.note } : {}),
    });
    await ctx.services.runStore.writeMeta(ctx.meta);
    ctx.feedback = undefined;
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

function resolveArtefacts(
  contracts: Phase["inputs"] | Phase["outputs"],
  slug: string,
): readonly ArtefactPointer[] {
  if (!contracts) return [];
  return contracts.map((c) => ({
    label: c.label,
    path: resolveArtefactPath(c, slug),
    ...(c.description ? { description: c.description } : {}),
  }));
}
