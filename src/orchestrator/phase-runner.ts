import type { PhasePreview } from "../domain/phase-preview";
import type { Phase } from "../domain/workflow";
import type { AgentRuntime, InvokeResult } from "../runtimes/types";
import { promoteRuntimeEvent, type RunEvent } from "./events";
import type { PhaseMeta } from "./run-store";

/**
 * `PhaseRunner` invokes one prepared phase: takes a `PhasePreview`
 * plus the chosen `AgentRuntime` plus per-run execution context,
 * dispatches the prompt to the runtime, and collects the result. It
 * emits `phase.started` / `phase.runtime.completed` / `phase.failed`
 * lifecycle events plus the runtime's observation stream, tagged with
 * runId + phaseId. The full `phase.completed` event is emitted by the
 * phase transaction after output verification and gate approval.
 *
 * Stateless on purpose. The runtime registry lives one layer up
 * (`PhaseTransaction` reads it from `EngineServices`) — `PhaseRunner`
 * just receives the chosen runtime per call. Composition is also not
 * this class's concern; that lives in `PhasePreparer` so dry-run and
 * real-run share one path. Gates live above the engine entirely.
 */
export interface PhaseExecutionContext {
  readonly runId: string;
  readonly runDir: string;
  readonly iteration: number;
}

export interface PhaseExecutionRequest {
  readonly preview: PhasePreview;
  readonly runtime: AgentRuntime;
  readonly context: PhaseExecutionContext;
  readonly emit: (event: RunEvent) => void;
  readonly abortSignal?: AbortSignal;
}

export interface PhaseRunResult {
  readonly meta: PhaseMeta;
  readonly invokeResult: InvokeResult;
}

export class PhaseRunner {
  async run(req: PhaseExecutionRequest): Promise<PhaseRunResult> {
    const { preview, runtime, context, emit } = req;

    const phaseMeta: PhaseMeta = {
      phaseId: preview.phase.id,
      iteration: context.iteration,
      startedAt: new Date().toISOString(),
      status: "running",
      runtime: runtime.name,
      model: preview.prompt.model,
    };

    emit({
      type: "phase.started",
      runId: context.runId,
      phaseId: preview.phase.id,
      iteration: context.iteration,
      model: preview.prompt.model,
      runtime: runtime.name,
    });

    const invokeResult = await runtime.invoke({
      runId: context.runId,
      runDir: context.runDir,
      prompt: preview.prompt,
      onEvent: (event) => emit(promoteRuntimeEvent(event, context.runId, preview.phase.id)),
      ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    });

    this.applyInvokeResult(phaseMeta, invokeResult);

    if (invokeResult.status === "failed") {
      phaseMeta.status = "failed";
      phaseMeta.error = invokeResult.error ?? `exit ${invokeResult.exitCode}`;
      emit({
        type: "phase.failed",
        runId: context.runId,
        phaseId: preview.phase.id,
        iteration: context.iteration,
        error: phaseMeta.error,
      });
      return { meta: phaseMeta, invokeResult };
    }

    emit({
      type: "phase.runtime.completed",
      runId: context.runId,
      phaseId: preview.phase.id,
      iteration: context.iteration,
      tokens: invokeResult.tokens,
      durationMs: invokeResult.durationMs,
    });
    return { meta: phaseMeta, invokeResult };
  }

  private applyInvokeResult(phaseMeta: PhaseMeta, invokeResult: InvokeResult): void {
    phaseMeta.completedAt = new Date().toISOString();
    phaseMeta.tokens = invokeResult.tokens;
    phaseMeta.durationMs = invokeResult.durationMs;
    phaseMeta.exitCode = invokeResult.exitCode;
    phaseMeta.transcriptPath = invokeResult.transcriptPath;
  }
}

export function summariseInvocation(result: InvokeResult): string {
  const parts = [
    `duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `in: ${result.tokens.input.toLocaleString()} tok`,
    `out: ${result.tokens.output.toLocaleString()} tok`,
  ];
  if (result.tokens.cacheReadInput > 0) {
    parts.push(`cache-read: ${result.tokens.cacheReadInput.toLocaleString()} tok`);
  }
  return parts.join("  |  ");
}

// Re-exported for engines/executors that previously named these.
export type { Phase };
