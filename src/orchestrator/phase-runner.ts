import type { PhasePreview } from "../domain/phase-preview";
import type { Phase } from "../domain/workflow";
import type { AgentRuntime, InvokeRequest, InvokeResult } from "../worker/runtimes/types";
import type { RunEvent } from "./events";
import type { PhaseMeta } from "./run-store";
import { promoteRuntimeEvent } from "./runtime-events";

/**
 * Drives a single phase invocation parent-side: emits the phase
 * lifecycle (`phase.started` / `phase.runtime.completed` / `phase.failed`),
 * tags raw `RuntimeEvent`s with run + phase identity, and assembles the
 * `PhaseMeta`. The actual `runtime.invoke()` call is supplied as a
 * function so the same lifecycle code path covers two callers:
 *
 *   - `HarnessRuntime.dispatchPhase` — invoke = "spawn the sandboxed
 *     worker, stream JSONL events from its stdout, read the result file
 *     it writes on exit".
 *   - in-process tests / fixtures — invoke = "call `runtime.invoke()`
 *     directly in this process".
 *
 * Phase B (sandboxing roadmap) moved this from `src/worker/` to here so
 * lifecycle bookkeeping is parent-side and the worker stays as close as
 * possible to "the runtime adapter and nothing else".
 */
export interface PhaseExecutionContext {
  readonly runId: string;
  readonly runDir: string;
  readonly iteration: number;
}

export type RuntimeInvoke = (req: InvokeRequest) => Promise<InvokeResult>;

export interface PhaseExecutionRequest {
  readonly preview: PhasePreview;
  readonly runtimeName: string;
  readonly invoke: RuntimeInvoke;
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
    const { preview, runtimeName, invoke, context, emit } = req;

    const phaseMeta: PhaseMeta = {
      phaseId: preview.phase.id,
      iteration: context.iteration,
      startedAt: new Date().toISOString(),
      status: "running",
      runtime: runtimeName,
      model: preview.prompt.model,
    };

    emit({
      type: "phase.started",
      runId: context.runId,
      phaseId: preview.phase.id,
      iteration: context.iteration,
      model: preview.prompt.model,
      runtime: runtimeName,
    });

    const invokeResult = await invoke({
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

/**
 * Convenience for in-process callers (tests, eval suite): wrap an
 * `AgentRuntime` instance as the `invoke` callback the runner expects.
 */
export function invokeWithRuntime(runtime: AgentRuntime): RuntimeInvoke {
  return (req) => runtime.invoke(req);
}

export type { Phase };
