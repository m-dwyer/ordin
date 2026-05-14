import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { PhasePreparer, type PhasePreview, resolveArtefacts } from "../domain/phase-preview";
import type { Phase, WorkflowManifest } from "../domain/workflow";
import { withSpan } from "../observability/spans";
import type {
  Engine,
  EngineResumeInput,
  EngineRunInput,
  EngineServices,
  GateRequest,
  PreviewInput,
  PreviewServices,
  RunHandle,
  WorkflowProgram,
} from "./engine";
import { EventBus } from "./event-bus";
import type { RunEvent } from "./events";
import { PhaseRunner } from "./phase-runner";
import type { PhaseTransactionContext } from "./phase-transaction";
import {
  createInitialRunMeta,
  generateRunId,
  type PendingGateMarker,
  type RunMeta,
} from "./run-store";
import { compileWorkflowPlan, type ExecutionPlan, nextPhase } from "./workflow-plan";

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

type RunCtx = PhaseTransactionContext;

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

  compile(manifest: WorkflowManifest): WorkflowProgram {
    return {
      manifest,
      plan: compileWorkflowPlan(manifest),
    };
  }

  async start(
    program: WorkflowProgram,
    input: EngineRunInput,
    services: EngineServices,
  ): Promise<RunHandle> {
    const runId = generateRunId(input.slug);
    const bus = new EventBus<RunEvent>();
    const emit = (ev: RunEvent): void => {
      bus.emit(ev);
      input.onEvent?.(ev);
    };
    const meta: RunMeta = createInitialRunMeta({
      runId,
      workflow: program.manifest.name,
      bundle: services.bundle,
      tier: input.tier,
      task: input.task,
      slug: input.slug,
      repo: input.workspaceRoot,
      ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
      ...(input.onlyPhases ? { onlyPhases: input.onlyPhases } : {}),
      ...(input.startAt ? { startAt: input.startAt } : {}),
    });
    await services.runStore.writeMeta(meta);
    emit({ type: "run.started", runId });

    // `ctx` is hoisted out of the span closure so the returned handle's
    // pendingGate() can read the engine's live gate state. PhaseTransaction
    // sets ctx.pendingGate before awaiting input.onGateRequested and
    // clears it after — the handle is the engine-side surface of that.
    const preparer = new PhasePreparer();
    const ctx: RunCtx = {
      runId,
      meta,
      manifest: program.manifest,
      input,
      services,
      preparer,
      emit,
      iterations: new Map(),
      feedback: undefined,
      outcome: undefined,
      pendingGate: undefined,
    };

    const completion = withSpan(
      "ordin.run",
      {
        "ordin.run_id": runId,
        "ordin.workflow": program.manifest.name,
        "ordin.bundle.name": services.bundle.name,
        "ordin.bundle.version": services.bundle.version,
        "ordin.bundle.hash": services.bundle.hash,
        "ordin.tier": input.tier,
        "ordin.slug": input.slug,
        "ordin.task": input.task.slice(0, 256),
        "ordin.engine": this.name,
        "langfuse.trace.name": input.slug,
        "langfuse.trace.input": input.task,
        "langfuse.session.id": runId,
      },
      async (span) => {
        try {
          const wf = compileMastraWorkflow(program.manifest, program.plan, ctx);
          const run = await wf.createRun();
          const result = await run.start({ inputData: {} });

          if (ctx.outcome) {
            // A step set the outcome before bailing — `result.status` will
            // be "bailed" for halt/fail; ctx carries the intent.
            meta.status = ctx.outcome;
          } else if (result.status === "success") {
            meta.status = "completed";
          } else if (input.abortSignal?.aborted) {
            // User aborted (Ctrl-C). Leave the run resumable — don't
            // flip status to "failed" or set completedAt. inFlight stays
            // pointing at whatever phase was in flight, which is exactly
            // what the resume planner wants.
            throw new RunAbortedError(input.task);
          } else {
            // Mastra returned failed/suspended/tripwire and no step set
            // ctx.outcome — treat as a real engine error.
            meta.completedAt = new Date().toISOString();
            meta.status = "failed";
            await services.runStore.writeMeta(meta);
            throw extractFailureError(result);
          }

          meta.completedAt = new Date().toISOString();
          await services.runStore.writeMeta(meta);
          emit({ type: "run.completed", runId, status: meta.status });
          span.setAttribute("ordin.status", meta.status);
          span.setAttribute("langfuse.trace.output", summariseRunOutput(meta));
          return meta;
        } finally {
          bus.close();
        }
      },
    );

    return {
      runId,
      events: bus.subscribe(),
      awaitCompletion: () => completion,
      pendingGate: (): GateRequest | undefined => ctx.pendingGate,
    };
  }

  async resume(
    program: WorkflowProgram,
    meta: RunMeta,
    input: EngineResumeInput,
    services: EngineServices,
  ): Promise<RunHandle> {
    const runId = meta.runId;
    const bus = new EventBus<RunEvent>();
    const emit = (ev: RunEvent): void => {
      bus.emit(ev);
      input.onEvent?.(ev);
    };
    // Synthesise EngineRunInput from meta + transport callbacks so
    // PhaseTransaction (which reads task/slug/workspaceRoot/tier/etc.
    // off ctx.input) doesn't need a resume-specific code path.
    const synthInput: EngineRunInput = {
      task: meta.task,
      slug: meta.slug,
      workspaceRoot: meta.repo,
      tier: meta.tier,
      sandboxMode: meta.sandboxMode,
      startAt: undefined,
      onlyPhases: undefined,
      onEvent: input.onEvent,
      onGateRequested: input.onGateRequested,
      dispatchPhase: input.dispatchPhase,
      abortSignal: input.abortSignal,
    };
    const preparer = new PhasePreparer();
    const ctx: RunCtx = {
      runId,
      meta,
      manifest: program.manifest,
      input: synthInput,
      services,
      preparer,
      emit,
      iterations: new Map(),
      feedback: undefined,
      outcome: undefined,
      pendingGate: undefined,
    };
    emit({ type: "run.started", runId });

    const completion = withSpan(
      "ordin.run",
      {
        "ordin.run_id": runId,
        "ordin.workflow": program.manifest.name,
        "ordin.bundle.name": services.bundle.name,
        "ordin.bundle.version": services.bundle.version,
        "ordin.bundle.hash": services.bundle.hash,
        "ordin.tier": meta.tier,
        "ordin.slug": meta.slug,
        "ordin.task": meta.task.slice(0, 256),
        "ordin.engine": this.name,
        "ordin.resumed": true,
        "langfuse.trace.name": meta.slug,
        "langfuse.trace.input": meta.task,
        "langfuse.session.id": runId,
      },
      async (span) => {
        try {
          if (meta.pendingGate) {
            const halted = await this.replayPendingGate(ctx, meta.pendingGate);
            if (halted) meta.status = "halted";
          }

          if (meta.status === "running") {
            const next = nextPhase(program.plan, meta);
            if (!next) {
              meta.status = "completed";
            } else {
              // Clear the stale in-flight marker (if any) before re-entering
              // the phase. recordRunResult would do this on the next phase
              // boundary anyway, but doing it here keeps meta tidy on disk
              // for any external observer between now and that point.
              meta.inFlight = null;
              await services.runStore.writeMeta(meta);

              const slicedManifest = program.manifest.startingAt(next);
              const slicedPlan = compileWorkflowPlan(slicedManifest);
              const wf = compileMastraWorkflow(slicedManifest, slicedPlan, ctx);
              const run = await wf.createRun();
              const result = await run.start({ inputData: {} });

              if (ctx.outcome) {
                meta.status = ctx.outcome;
              } else if (result.status === "success") {
                meta.status = "completed";
              } else if (input.abortSignal?.aborted) {
                throw new RunAbortedError(meta.task);
              } else {
                meta.status = "failed";
                meta.completedAt = new Date().toISOString();
                await services.runStore.writeMeta(meta);
                throw extractFailureError(result);
              }
            }
          }

          meta.completedAt = meta.completedAt ?? new Date().toISOString();
          await services.runStore.writeMeta(meta);
          emit({ type: "run.completed", runId, status: meta.status });
          span.setAttribute("ordin.status", meta.status);
          span.setAttribute("langfuse.trace.output", summariseRunOutput(meta));
          return meta;
        } finally {
          bus.close();
        }
      },
    );

    return {
      runId,
      events: bus.subscribe(),
      awaitCompletion: () => completion,
      pendingGate: (): GateRequest | undefined => ctx.pendingGate,
    };
  }

  /**
   * Replay a buffered gate request from a prior run that died awaiting
   * a decision. The PhaseMeta entry already exists (the prior process
   * wrote it before requesting the gate); we mutate it in place with
   * the new decision and emit the same event sequence a fresh gate
   * would. v1: a rejection halts the run rather than entering loop
   * retry — the machinery for loop replay exists in PhaseTransaction
   * but isn't wired through resume yet.
   */
  private async replayPendingGate(ctx: RunCtx, marker: PendingGateMarker): Promise<boolean> {
    const phase = ctx.manifest.findPhase(marker.phaseId);
    const phaseMeta = [...ctx.meta.phases].reverse().find((p) => p.phaseId === marker.phaseId);
    if (!phaseMeta) {
      throw new Error(
        `Resume: meta.pendingGate references phase "${marker.phaseId}" with no PhaseMeta entry`,
      );
    }
    const outputs = resolveArtefacts(phase.outputs, ctx.input.slug);
    const request: GateRequest = {
      runId: ctx.runId,
      phaseId: phase.id,
      gateKind: phase.gate,
      cwd: ctx.input.workspaceRoot,
      artefacts: outputs,
      summary: "Resumed from a prior session — gate decision pending.",
    };
    ctx.pendingGate = request;
    ctx.emit({ type: "gate.requested", runId: ctx.runId, phaseId: phase.id });
    const decision = await ctx.input.onGateRequested(request);
    ctx.pendingGate = undefined;
    ctx.meta.pendingGate = null;

    if (decision.status === "approved") {
      phaseMeta.status = "completed";
      phaseMeta.gateDecision = phase.gate === "auto" ? "auto" : "approved";
      if (decision.note) phaseMeta.gateNote = decision.note;
      await ctx.services.runStore.writeMeta(ctx.meta);
      ctx.emit({
        type: "gate.decided",
        runId: ctx.runId,
        phaseId: phase.id,
        decision: phaseMeta.gateDecision,
        ...(decision.note ? { note: decision.note } : {}),
      });
      ctx.emit({
        type: "phase.completed",
        runId: ctx.runId,
        phaseId: phase.id,
        iteration: phaseMeta.iteration,
        tokens: phaseMeta.tokens ?? {
          input: 0,
          output: 0,
          cacheReadInput: 0,
          cacheCreationInput: 0,
          totalInput: 0,
        },
        durationMs: phaseMeta.durationMs ?? 0,
      });
      return false;
    }

    phaseMeta.status = "rejected";
    phaseMeta.gateDecision = "rejected";
    phaseMeta.gateNote = decision.reason;
    await ctx.services.runStore.writeMeta(ctx.meta);
    ctx.emit({
      type: "gate.decided",
      runId: ctx.runId,
      phaseId: phase.id,
      decision: "rejected",
      reason: decision.reason,
    });
    ctx.outcome = "halted";
    return true;
  }

  async run(
    program: WorkflowProgram,
    input: EngineRunInput,
    services: EngineServices,
  ): Promise<RunMeta> {
    const handle = await this.start(program, input, services);
    return handle.awaitCompletion();
  }

  async preview(
    program: WorkflowProgram,
    input: PreviewInput,
    services: PreviewServices,
  ): Promise<readonly PhasePreview[]> {
    const preparer = new PhasePreparer();
    return program.manifest.phases.map((phase) => {
      const agent = services.agents.get(phase.agent);
      if (!agent) {
        throw new Error(`Agent "${phase.agent}" declared by phase "${phase.id}" not loaded`);
      }
      return preparer.prepare({
        phase,
        agent,
        workflow: program.manifest,
        config: services.config,
        task: input.task,
        cwd: input.workspaceRoot,
        tier: input.tier,
        artefactInputs: resolveArtefacts(phase.inputs, input.slug),
        artefactOutputs: resolveArtefacts(phase.outputs, input.slug),
      });
    });
  }
}

/**
 * Thrown when a run was interrupted by a cooperative abort (Ctrl-C
 * routed through `input.abortSignal`). The engine treats this as a
 * "leave it resumable" signal: no `status: "failed"` write, no
 * `completedAt`. Distinguishes the abort path from real workflow
 * failures so resume can pick up from the in-flight phase.
 */
export class RunAbortedError extends Error {
  constructor(task: string) {
    super(`Run aborted by user (task: ${task.slice(0, 80)})`);
    this.name = "RunAbortedError";
  }
}

// Mastra's runtime shape diverges from its types: `result.error` comes
// back as a plain object (no prototype, no stack) after the durable-
// operation pipeline serialises/deserialises it. The real `Error`
// instance lives on `result.steps[<failedStep>].error`. Prefer that;
// fall back to enriching from the top-level `.message` if no failed
// step is reachable (suspended/tripwire/etc.).
function extractFailureError(result: unknown): Error {
  const r = result as { status: string; error?: unknown; steps?: Record<string, unknown> };
  for (const stepResult of Object.values(r.steps ?? {})) {
    const step = stepResult as { status?: string; error?: unknown };
    if (step.status === "failed" && step.error instanceof Error) return step.error;
  }
  const topMsg =
    r.error && typeof r.error === "object" && "message" in r.error
      ? String((r.error as { message: unknown }).message)
      : undefined;
  return new Error(`Workflow ${r.status}${topMsg ? `: ${topMsg}` : ""}`);
}

function summariseRunOutput(meta: RunMeta): string {
  const phases = meta.phases
    .map((p) => `${p.phaseId}:${p.status}${p.iteration > 1 ? `(x${p.iteration})` : ""}`)
    .join(", ");
  return `${meta.status} — ${phases || "no phases"}`;
}

function compileMastraWorkflow(manifest: WorkflowManifest, plan: ExecutionPlan, ctx: RunCtx) {
  const runner = new PhaseRunner(ctx);
  const phaseStep = (phase: Phase) =>
    createStep({
      id: phase.id,
      inputSchema: GateResult,
      outputSchema: GateResult,
      execute: async ({ bail }) => {
        const result = await runner.runPhase(phase);
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
        const result = await runner.runPhase(phase);
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
