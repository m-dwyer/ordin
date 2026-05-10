import { deriveToolPolicy } from "../broker/client/tool-authority";
import type { BrokerClient } from "../broker/client/types";
import type { BrokerDispatch } from "../broker/dispatch";
import type { PhaseDispatchRequest } from "../orchestrator/engine";
import { PhaseRunner, type PhaseRunResult, type RuntimeInvoke } from "../orchestrator/phase-runner";
import type { Sandbox } from "../sandbox/types";
import { buildRuntime } from "../worker/runtimes/registry";
import { prepareWorkerDispatch } from "./worker-dispatch";

/**
 * Resolves an `invoke` for one phase request. The seam is intentionally
 * tight — the dispatcher owns the rest of the per-phase scaffolding
 * (broker ACL registration, PhaseRunner construction). Two impls cover
 * the only two strategies that exist:
 *
 *   - `InProcessInvokeSource`: passthrough mode runs the runtime in the
 *     parent process; the worker env never enters the harness lifetime.
 *   - `SandboxedInvokeSource`: broker / srt modes spawn a subprocess
 *     per phase via `prepareWorkerDispatch`.
 */
export interface WorkerInvokeSource {
  prepare(req: PhaseDispatchRequest): Promise<RuntimeInvoke>;
}

/**
 * Per-run runtime context shared by both invoke sources. `runtimeConfigFor`
 * is a thunk so claude-cli's `bin` resolution stays a runtime concern.
 */
export interface RuntimeContext {
  readonly harnessRoot: string;
  readonly workflowName: string;
  readonly runsDir: string;
  readonly scriptPath: string | undefined;
  readonly runtimeConfigFor: (name: string) => unknown;
}

export class InProcessInvokeSource implements WorkerInvokeSource {
  constructor(
    private readonly ctx: RuntimeContext,
    private readonly broker: BrokerClient,
  ) {}

  async prepare(req: PhaseDispatchRequest): Promise<RuntimeInvoke> {
    const runtime = await buildRuntime(
      req.runtimeName,
      this.ctx.runtimeConfigFor(req.runtimeName),
      {
        harnessRoot: this.ctx.harnessRoot,
        workflowName: this.ctx.workflowName,
        runsDir: this.ctx.runsDir,
        ...(this.ctx.scriptPath ? { scriptPath: this.ctx.scriptPath } : {}),
        broker: this.broker,
      },
    );
    return (invokeReq) => runtime.invoke(invokeReq);
  }
}

export class SandboxedInvokeSource implements WorkerInvokeSource {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly ctx: RuntimeContext,
    private readonly workerEnv: NodeJS.ProcessEnv,
  ) {}

  async prepare(req: PhaseDispatchRequest): Promise<RuntimeInvoke> {
    const worker = await prepareWorkerDispatch(this.sandbox, req, {
      harnessRoot: this.ctx.harnessRoot,
      workflowName: this.ctx.workflowName,
      ...(this.ctx.scriptPath ? { scriptPath: this.ctx.scriptPath } : {}),
      runsDir: this.ctx.runsDir,
      workerEnv: this.workerEnv,
      runtimeConfigFor: this.ctx.runtimeConfigFor,
    });
    return worker.invoke;
  }
}

/**
 * One phase invocation. Resolves an `invoke` from the source, registers
 * the phase ACL with broker dispatch, runs the phase, and releases the
 * ACL whether the run succeeds or throws. The strategy split lives one
 * level down (`WorkerInvokeSource`); this class keeps the scaffolding
 * in one place so it can't drift between strategies.
 */
export class PhaseDispatcher {
  constructor(
    private readonly source: WorkerInvokeSource,
    private readonly brokerDispatch: BrokerDispatch,
  ) {}

  async dispatch(req: PhaseDispatchRequest): Promise<PhaseRunResult> {
    const invoke = await this.source.prepare(req);
    const { runId, preview } = req;
    const { phaseId } = preview.prompt;
    const policy = deriveToolPolicy({
      allowedTools: preview.prompt.tools,
      hasSkills: preview.prompt.skills.length > 0,
    });
    this.brokerDispatch.registerPhase(runId, phaseId, policy);
    try {
      return await new PhaseRunner().run({
        preview,
        runtimeName: req.runtimeName,
        context: { runId, runDir: req.runDir, iteration: req.iteration },
        emit: req.emit,
        invoke,
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
      });
    } finally {
      this.brokerDispatch.releasePhase(runId, phaseId);
    }
  }
}
