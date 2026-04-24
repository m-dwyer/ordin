import type { ArtefactPointer } from "../domain/composer";
import type { Workflow } from "../domain/workflow";
import type { Gate } from "../gates/types";
import type { RunEvent } from "./events";
import type { PhaseRunner } from "./phase-runner";
import type { RunMeta, RunStore } from "./run-store";

/**
 * The orchestration seam. Engines drive a `Workflow` through to a
 * `RunMeta`, delegating single-phase execution to `PhaseRunner` and
 * gate decisions to a resolver. Swapping engine implementations
 * (sequential → Mastra → LangGraph) is an adapter change; domain,
 * runtimes, gates, composer, CLI, and YAML content are all unchanged.
 */
export interface Engine {
  run(input: EngineRunInput): Promise<RunMeta>;
}

/**
 * Dependencies engines receive at construction. Services are held for
 * the engine's lifetime; `EngineRunInput` carries the per-run values.
 */
export interface EngineServices {
  readonly phaseRunner: PhaseRunner;
  readonly gateFor: (phase: import("../domain/workflow").Phase) => Gate;
  readonly runStore: RunStore;
}

export interface EngineRunInput {
  readonly workflow: Workflow;
  readonly task: string;
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly tier: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  readonly artefactInputs?: ReadonlyMap<string, readonly ArtefactPointer[]>;
  readonly artefactOutputs?: ReadonlyMap<string, readonly ArtefactPointer[]>;
  readonly abortSignal?: AbortSignal;
}
