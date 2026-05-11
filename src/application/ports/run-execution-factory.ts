import type { HarnessConfig, SandboxMode } from "../../domain/config";
import type { PhaseDispatchRequest } from "../../orchestrator/engine";
import type { RunEvent } from "../../orchestrator/events";
import type { PhaseInvocationResult } from "../../orchestrator/phase-invocation";

export interface RunExecution {
  readonly sandboxMode: SandboxMode | undefined;
  enter(): Promise<void>;
  dispose(): Promise<void>;
  onEvent(): (event: RunEvent) => void;
  dispatchPhase(): (req: PhaseDispatchRequest) => Promise<PhaseInvocationResult>;
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

/**
 * Application-layer port for constructing a per-run `RunExecution`.
 * Composition roots build the closure with session-scoped overrides
 * (sandbox mode, dispatch shim, egress prompter) pre-bound, so use
 * cases stay ignorant of how the execution is wired.
 */
export type RunExecutionFactory = (opts: RunExecutionPrepareOptions) => Promise<RunExecution>;
