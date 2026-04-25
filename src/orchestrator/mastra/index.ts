import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { Phase, WorkflowManifest } from "../../domain/workflow";
import type { CompiledWorkflow, Engine, EngineRunInput, EngineServices } from "../engine";
import type { RunEvent } from "../events";
import { executePhase, type PhaseExecutorContext } from "../phase-executor";
import { generateRunId, type RunMeta } from "../run-store";
import { createExecutionPlan, type ExecutionPlan } from "../workflow-plan";

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
const GateResult = z.object({ approved: z.boolean().optional() });

type RunCtx = PhaseExecutorContext;

/**
 * Mastra step `bail(result)` ends the workflow cleanly with status
 * "bailed". At runtime it returns an `InnerOutput` sentinel that
 * Mastra unwraps; we type it as the step's output shape so the
 * `execute` function can return it directly. Only called from the
 * step boundary — `executePhase` keeps a plain return shape.
 */
type Bail = (result: { approved: boolean }) => { approved: boolean };

export class MastraEngine implements Engine {
  readonly name = "mastra";

  compile(manifest: WorkflowManifest): CompiledWorkflow {
    return new MastraCompiledWorkflow(manifest, createExecutionPlan(manifest));
  }
}

class MastraCompiledWorkflow implements CompiledWorkflow {
  readonly engineName = "mastra";

  constructor(
    readonly manifest: WorkflowManifest,
    private readonly plan: ExecutionPlan,
  ) {}

  async run(input: EngineRunInput, services: EngineServices): Promise<RunMeta> {
    const runId = generateRunId(input.slug);
    const emit = input.onEvent ?? ((_: RunEvent) => {});
    const meta: RunMeta = {
      runId,
      workflow: this.manifest.name,
      tier: input.tier,
      task: input.task,
      slug: input.slug,
      repo: input.workspaceRoot,
      startedAt: new Date().toISOString(),
      status: "running",
      phases: [],
    };
    await services.runStore.writeMeta(meta);
    emit({ type: "run.started", runId });

    const ctx: RunCtx = {
      runId,
      meta,
      input,
      services,
      emit,
      iterations: new Map(),
      feedback: undefined,
      outcome: undefined,
    };

    const wf = compileMastraWorkflow(this.manifest, this.plan, ctx);
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
      await services.runStore.writeMeta(meta);
      const err = (result as { error?: unknown }).error;
      throw err instanceof Error ? err : new Error(`Workflow ${result.status}`);
    }

    meta.completedAt = new Date().toISOString();
    await services.runStore.writeMeta(meta);
    emit({ type: "run.completed", runId, status: meta.status });
    return meta;
  }
}

function compileMastraWorkflow(manifest: WorkflowManifest, plan: ExecutionPlan, ctx: RunCtx) {
  const phaseStep = (phase: Phase) =>
    createStep({
      id: phase.id,
      inputSchema: GateResult,
      outputSchema: GateResult,
      execute: async ({ bail }) => {
        const result = await executePhase(phase, ctx);
        return ctx.outcome ? (bail as unknown as Bail)(result) : result;
      },
    });

  let wf = createWorkflow({
    id: `ordin-${manifest.name}`,
    inputSchema: GateResult,
    outputSchema: GateResult,
  });

  if (plan.kind === "linear") {
    for (const phase of plan.phases) wf = wf.then(phaseStep(phase));
    return wf.commit();
  }

  for (const phase of plan.beforeLoop) wf = wf.then(phaseStep(phase));

  const loopStep = createStep({
    id: `ordin-${manifest.name}-loop`,
    inputSchema: GateResult,
    outputSchema: GateResult,
    execute: async ({ bail }) => {
      for (const phase of plan.loop) {
        const result = await executePhase(phase, ctx);
        // A non-rejecter halt or runtime failure inside the loop must
        // end the workflow, not just the iteration.
        if (ctx.outcome) return (bail as unknown as Bail)(result);
        if (!result.approved) return result; // rejecter rejected → dountil retries.
      }
      return { approved: true };
    },
  });

  wf = wf.dountil(loopStep, async ({ inputData }: { inputData: z.infer<typeof GateResult> }) => {
    if (inputData.approved === true) return true;
    const used = ctx.iterations.get(plan.rejecter.id) ?? 0;
    if (used >= plan.maxIterations) {
      ctx.outcome = "halted";
      return true;
    }
    return false;
  });

  for (const phase of plan.afterLoop) wf = wf.then(phaseStep(phase));
  return wf.commit();
}
