import type { Phase, WorkflowManifest } from "../domain/workflow";
import type { Gate } from "../gates/types";
import type { RunEvent } from "./events";
import type { PhaseRunner } from "./phase-runner";
import type { RunMeta, RunStore } from "./run-store";

/**
 * Engines compile a declarative workflow manifest into an executable
 * workflow. Compilation is pure topology work; per-run services and
 * inputs are supplied when the compiled workflow runs.
 */
export interface Engine {
  readonly name: string;
  compile(manifest: WorkflowManifest): CompiledWorkflow;
}

export interface CompiledWorkflow {
  readonly engineName: string;
  readonly manifest: WorkflowManifest;
  run(input: EngineRunInput, services: EngineServices): Promise<RunMeta>;
}

/**
 * Per-run dependencies used by compiled workflows. Keeping services
 * outside compile() lets engines validate topology without runtime
 * state and lets callers reuse a compiled workflow with different
 * service implementations in tests/evals.
 */
export interface EngineServices {
  readonly phaseRunner: PhaseRunner;
  readonly gateFor: (phase: Phase) => Gate;
  readonly runStore: RunStore;
}

export interface EngineRunInput {
  readonly task: string;
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly tier: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  readonly abortSignal?: AbortSignal;
}

export class EngineRegistry {
  private readonly engines = new Map<string, Engine>();

  constructor(engines: Iterable<Engine> = []) {
    for (const engine of engines) {
      this.register(engine);
    }
  }

  register(engine: Engine): void {
    if (this.engines.has(engine.name)) {
      throw new Error(`Engine "${engine.name}" is already registered`);
    }
    this.engines.set(engine.name, engine);
  }

  get(name: string): Engine {
    const engine = this.engines.get(name);
    if (!engine) {
      throw new Error(`Engine "${name}" is not registered`);
    }
    return engine;
  }
}
