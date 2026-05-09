import type { HarnessConfig, SandboxMode } from "../../domain/config";
import type { PhaseDispatchRequest } from "../../orchestrator/engine";
import type { RunEvent } from "../../orchestrator/events";
import type { PhaseRunResult } from "../../orchestrator/phase-runner";

export interface RunExecution {
  readonly sandboxMode: SandboxMode | undefined;
  enter(): Promise<void>;
  dispose(): Promise<void>;
  onEvent(): (event: RunEvent) => void;
  dispatchPhase(): (req: PhaseDispatchRequest) => Promise<PhaseRunResult>;
}

/**
 * Internal option shapes use `T | undefined` (required, explicit
 * undefined allowed) so the composition root can do plain assignment
 * without `...(opts.X ? { X: opts.X } : {})` ceremony under
 * `exactOptionalPropertyTypes`. The public `HarnessRuntimeOptions`
 * keeps `T?` because omission is the natural way external callers
 * decline an option.
 */
export interface RunExecutionPrepareOptions {
  readonly root: string;
  readonly workflowName: string;
  readonly config: HarnessConfig;
  readonly workspaceRoot: string;
  readonly projectName: string | undefined;
  readonly onEvent: ((event: RunEvent) => void) | undefined;
}

export interface RunExecutionFactory {
  prepare(opts: RunExecutionPrepareOptions): Promise<RunExecution>;
}

/**
 * Session-scoped overrides applied to every `prepare()` call. The
 * composition root pre-binds these at factory construction so use
 * cases can stay ignorant of sandbox / dispatcher injection.
 */
export interface RunExecutionFactoryOverrides {
  readonly dispatchPhaseOverride:
    | ((request: PhaseDispatchRequest) => Promise<PhaseRunResult>)
    | undefined;
  readonly egressGatePrompter:
    | ((req: { host: string; port: number | undefined }) => Promise<boolean>)
    | undefined;
  readonly sandboxModeOverride: SandboxMode | undefined;
  readonly scriptPathOverride: string | undefined;
}
