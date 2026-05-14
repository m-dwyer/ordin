import { GateResolver } from "../gates/dispatch";
import type { EngineResumeInput } from "../orchestrator/engine";
import type { RunEvent } from "../orchestrator/events";
import type { RunMeta } from "../orchestrator/run-store";
import type { DefaultHarnessStateLoader } from "./default-harness-state-loader";
import type { RunExecutionFactory } from "./run-execution";
import { engineServices, handleGateRequest } from "./start-run";

export interface ResumeRunInput {
  readonly runId: string;
  readonly onEvent?: (event: RunEvent) => void;
  readonly gateResolver?: GateResolver;
  readonly abortSignal?: AbortSignal;
}

/**
 * Thrown when `ordin resume` is called against a run whose meta is
 * already in a terminal state (`completed`, `failed`, `halted`). The
 * plan's failure-modes section calls this out explicitly: don't retry
 * a terminated run, surface the prior status, and let the user start
 * fresh if needed.
 */
export class TerminalRunError extends Error {
  constructor(
    readonly runId: string,
    readonly status: RunMeta["status"],
  ) {
    super(
      `Run ${runId} already terminated with status "${status}". Inspect with 'ordin status ${runId}' or start a fresh run.`,
    );
    this.name = "TerminalRunError";
  }
}

/**
 * Resume an interrupted run from its persisted RunMeta. Bundle, slug,
 * task, workspace, tier, and sandbox mode are all read from `meta` —
 * resume can't change a run's identity. Engine semantics: re-enter at
 * `meta.pendingGate` (replay) → `meta.inFlight` (re-run that phase) →
 * `nextPhase(plan, meta)` (continue from the next undone phase).
 */
export class ResumeRunUseCase {
  constructor(
    private readonly loader: DefaultHarnessStateLoader,
    private readonly factory: RunExecutionFactory,
  ) {}

  async execute(input: ResumeRunInput): Promise<RunMeta> {
    const state = await this.loader.load();
    const meta = await state.runStore.readMeta(input.runId);
    if (meta.status !== "running") {
      throw new TerminalRunError(meta.runId, meta.status);
    }
    const program = state.engine.compile(state.workflow);
    const execution = await this.factory.prepare({
      root: this.loader.root,
      bundleName: this.loader.bundleName,
      config: state.config,
      workspaceRoot: meta.repo,
      projectName: undefined,
      onEvent: input.onEvent,
      bundleScriptPath: state.bundle.scriptPath,
    });
    const gateResolver = input.gateResolver ?? new GateResolver();
    try {
      await execution.enter();
      const resumeInput: EngineResumeInput = {
        onGateRequested: (request) => handleGateRequest(gateResolver, request),
        onEvent: execution.onEvent(),
        dispatchPhase: execution.dispatchPhase(),
        abortSignal: input.abortSignal,
      };
      const handle = await state.engine.resume(program, meta, resumeInput, engineServices(state));
      return await handle.awaitCompletion();
    } finally {
      await execution.dispose();
    }
  }
}
