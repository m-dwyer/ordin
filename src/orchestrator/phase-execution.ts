import type { ArtefactPointer } from "../domain/composer";
import type { Phase } from "../domain/workflow";
import type { RunEvent } from "./events";

/**
 * PhaseExecutionContext is the phase-local slice of run state.
 *
 * Keep it data-only so a future graph orchestrator can checkpoint it
 * cleanly. Services (runtimes, gates, config, emitters) stay outside.
 */
export interface PhaseExecutionContext {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly task: string;
  readonly tier: "S" | "M" | "L";
  readonly iteration: number;
  readonly artefactInputs: readonly ArtefactPointer[];
  readonly artefactOutputs: readonly ArtefactPointer[];
  readonly iterationContext?: string;
}

export interface PhaseExecutionRequest {
  readonly phase: Phase;
  readonly context: PhaseExecutionContext;
  readonly emit: (event: RunEvent) => void;
  readonly abortSignal?: AbortSignal;
}
