import { SpanStatusCode } from "@opentelemetry/api";
import type { Phase } from "../domain/workflow";
import { withSpan } from "../observability/spans";
import {
  type PhaseExecutionOutcome,
  PhaseTransaction,
  type PhaseTransactionContext,
} from "./phase-transaction";
import type { RunMeta } from "./run-store";

/**
 * Engine-neutral per-phase service (CONTEXT.md: Phase Runner). Engines
 * compile workflow topology and decide *when* to run a phase; the
 * runner owns *what happens* inside one phase invocation — the
 * resolve → preflight → invoke → postflight → gate → record checklist
 * wrapped in an OTel span. A future LangGraphEngine swaps the topology
 * compiler but reuses this runner; the per-phase transaction does not
 * vary with the engine.
 */
export class PhaseRunner {
  constructor(private readonly ctx: PhaseTransactionContext) {}

  runPhase(phase: Phase): Promise<PhaseExecutionOutcome> {
    const ctx = this.ctx;
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
