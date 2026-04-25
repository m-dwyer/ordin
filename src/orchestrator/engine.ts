import type { Agent } from "../domain/agent";
import type { HarnessConfig } from "../domain/config";
import type { PhasePreview } from "../domain/phase-preview";
import type { GateKind, WorkflowManifest } from "../domain/workflow";
import type { GateArtefact, GateDecision } from "../gates/types";
import type { AgentRuntime } from "../runtimes/types";
import type { RunEvent } from "./events";
import type { RunMeta, RunStore } from "./run-store";

export type { PhasePreview } from "../domain/phase-preview";

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
  /**
   * Compose the prompt for every phase without invoking any runtime.
   * Used by `ordin run --dry-run` so users can verify their agents,
   * skills, and artefact contracts produce the expected prompt before
   * burning inference. First-iteration only (no feedback); no gate
   * decisions, no run-store writes, no events.
   *
   * `PreviewServices` is a strict subset of `EngineServices` — proves
   * by type that the preview path needs no runtime registry, no run
   * store, and no gate dispatch.
   */
  preview(input: PreviewInput, services: PreviewServices): Promise<readonly PhasePreview[]>;
}

/**
 * Per-run dependencies used by compiled workflows. The engine owns
 * phase execution internally — it constructs its own `PhaseRunner`
 * from these lower-level deps. Gates are not here: the engine is
 * gate-agnostic and surfaces decision points via `onGateRequested`
 * on `EngineRunInput`.
 */
export interface EngineServices {
  readonly config: HarnessConfig;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly runtimes: ReadonlyMap<string, AgentRuntime>;
  readonly runStore: RunStore;
}

/**
 * What the engine surfaces at every gate boundary. The application
 * (HarnessRuntime, an HTTP server, a CI driver) decides — engine has
 * no `Gate` concept, just awaits the returned `GateDecision`. Async
 * by design: a handler may take arbitrary time, persist state, or
 * resume a paused workflow from elsewhere.
 */
export interface GateRequest {
  readonly runId: string;
  readonly phaseId: string;
  readonly gateKind: GateKind;
  readonly cwd: string;
  readonly artefacts: readonly GateArtefact[];
  readonly summary: string;
}

export interface EngineRunInput {
  readonly workflow: WorkflowManifest;
  readonly task: string;
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly tier: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  readonly onGateRequested: (request: GateRequest) => Promise<GateDecision>;
  readonly abortSignal?: AbortSignal;
}

/**
 * Per-run inputs used by `CompiledWorkflow.preview()`. Same shape as
 * `EngineRunInput` minus the runtime/event/gate fields — preview
 * doesn't invoke, doesn't emit, doesn't gate.
 */
export interface PreviewInput {
  readonly workflow: WorkflowManifest;
  readonly task: string;
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly tier: "S" | "M" | "L";
}

/**
 * Strict subset of `EngineServices` — only what's needed to compose
 * a phase's prompt. No runtimes, no run store, no gates.
 */
export interface PreviewServices {
  readonly config: HarnessConfig;
  readonly agents: ReadonlyMap<string, Agent>;
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
