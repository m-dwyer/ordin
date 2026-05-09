import type { HarnessConfig, SandboxMode } from "../../domain/config";
import type { PhaseDispatchRequest } from "../../orchestrator/engine";
import type { RunEvent } from "../../orchestrator/events";
import type { PhaseRunResult } from "../../orchestrator/phase-runner";
import type { Sandbox } from "../../sandbox/types";

export interface RunExecution {
  readonly sandboxMode: SandboxMode | undefined;
  enter(): Promise<void>;
  dispose(): Promise<void>;
  onEvent(): (event: RunEvent) => void;
  dispatchPhase(): (req: PhaseDispatchRequest) => Promise<PhaseRunResult>;
}

export interface RunExecutionPrepareOptions {
  readonly root: string;
  readonly workflowName: string;
  readonly config: HarnessConfig;
  readonly workspaceRoot: string;
  readonly projectName?: string;
  readonly onEvent?: (event: RunEvent) => void;
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
  readonly dispatchPhaseOverride?: (request: PhaseDispatchRequest) => Promise<PhaseRunResult>;
  readonly egressGatePrompter?: (req: {
    host: string;
    port: number | undefined;
  }) => Promise<boolean>;
  readonly sandboxOverride?: Sandbox;
  readonly sandboxModeOverride?: SandboxMode;
  readonly scriptPathOverride?: string;
}
