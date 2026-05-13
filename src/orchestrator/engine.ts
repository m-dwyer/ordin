import type { Agent } from "../domain/agent";
import type { ArtefactStore } from "../domain/artefact-store";
import type { HarnessConfig } from "../domain/config";
import type { PhasePreview } from "../domain/phase-preview";
import type { GateKind, WorkflowManifest } from "../domain/workflow";
import type { GateArtefact, GateDecision } from "../gates/types";
import type { RunEvent } from "./events";
import type { PhaseInvocationResult } from "./phase-invocation";
import type { RunMeta, RunStore } from "./run-store";
import type { ExecutionPlan } from "./workflow-plan";

export type { PhasePreview } from "../domain/phase-preview";

/**
 * Engines compile a declarative workflow manifest into a stable,
 * engine-neutral execution program. Compilation is pure topology work;
 * per-run services and inputs are supplied later when the selected
 * engine executes or previews that program.
 *
 * The seam is shaped for resumable state-machine execution, not just
 * one-shot topology (see `docs/decisions/engine-resumable.md`). Today
 * a single MastraEngine implementation runs to completion in-process;
 * the `start` + `RunHandle` surface is the precondition for cross-
 * process pause/resume in a follow-up plan. Engine-neutral plan
 * traversal (e.g. "what's the next phase given this RunMeta?") lives
 * with the plan in `workflow-plan.ts`, not on this seam.
 */
export interface Engine {
  readonly name: string;
  compile(manifest: WorkflowManifest): WorkflowProgram;
  /**
   * Begin a run and resolve once `runId` is known + the initial
   * `run.started` event has been emitted. The returned handle lets the
   * caller await final completion, query a pending gate (resume seam),
   * and subscribe to events. The legacy `run()` is start + await.
   */
  start(
    program: WorkflowProgram,
    input: EngineRunInput,
    services: EngineServices,
  ): Promise<RunHandle>;
  /** Convenience wrapper: `start().then(h => h.awaitCompletion())`. */
  run(program: WorkflowProgram, input: EngineRunInput, services: EngineServices): Promise<RunMeta>;
  preview(
    program: WorkflowProgram,
    input: PreviewInput,
    services: PreviewServices,
  ): Promise<readonly PhasePreview[]>;
}

/**
 * Live handle for a run that has begun but may still be in flight.
 * Calling `awaitCompletion()` blocks until the engine finishes; the
 * `events` stream replays buffered events and then emits live ones
 * until the run closes. `pendingGate()` returns the request the engine
 * is currently yielding on, or undefined if no gate is pending —
 * undefined today, becomes meaningful when Step 2.5 lands the
 * gates-as-events contract.
 */
export interface RunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<RunEvent>;
  awaitCompletion(): Promise<RunMeta>;
  pendingGate(): GateRequest | undefined;
}

export interface WorkflowProgram {
  readonly manifest: WorkflowManifest;
  readonly plan: ExecutionPlan;
}

/**
 * Per-run dependencies used by compiled workflows. The engine owns
 * phase execution internally — it constructs its own `PhaseInvocation`
 * from these lower-level deps. Gates are not here: the engine is
 * gate-agnostic and surfaces decision points via `onGateRequested`
 * on `EngineRunInput`.
 */
export interface EngineServices {
  readonly config: HarnessConfig;
  readonly agents: ReadonlyMap<string, Agent>;
  /**
   * Names of registered runtimes — used by the planner to validate
   * that a phase's resolved runtime is known. Instances live in
   * whichever process the dispatcher chose to invoke them in (under
   * L2: the worker, not the parent).
   */
  readonly runtimeNames: ReadonlySet<string>;
  readonly runStore: RunStore;
  /**
   * Bundle that produced this run — name + version + content hash.
   * Persisted in `RunMeta.bundle` and emitted as `ordin.bundle.*` span
   * attributes so traces can be sliced by exact loaded content.
   */
  readonly bundle: { readonly name: string; readonly version: string; readonly hash: string };
  /**
   * Builds an `ArtefactStore` for the given workspace. Injected so
   * orchestrator code stays disk-loader-free; composition wires the
   * concrete `ArtefactManager`.
   */
  readonly artefactStore: (workspaceRoot: string) => ArtefactStore;
}

/**
 * What the engine surfaces at every gate boundary. The application
 * (Harness, an HTTP server, a CI driver) decides — engine has
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
  readonly task: string;
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly tier: "S" | "M" | "L";
  readonly sandboxMode: "passthrough" | "broker" | "srt" | undefined;
  readonly startAt: string | undefined;
  readonly onlyPhases: readonly string[] | undefined;
  readonly onEvent: ((event: RunEvent) => void) | undefined;
  readonly onGateRequested: (request: GateRequest) => Promise<GateDecision>;
  /**
   * How a single phase invocation runs. Engine-neutral: the engine
   * decides *when* to invoke a phase (DAG order, loops, retries); the
   * dispatcher decides *where* (in-process, sandboxed worker, remote
   * runner). Harness supplies this per-run.
   */
  readonly dispatchPhase: (request: PhaseDispatchRequest) => Promise<PhaseInvocationResult>;
  readonly abortSignal: AbortSignal | undefined;
}

/**
 * One unit of phase execution the engine asks the harness to perform.
 * The preview is fully composed parent-side; the dispatcher just needs
 * to invoke the named runtime against it and return the result.
 */
export interface PhaseDispatchRequest {
  readonly runId: string;
  readonly runDir: string;
  readonly iteration: number;
  readonly preview: PhasePreview;
  readonly runtimeName: string;
  readonly emit: (event: RunEvent) => void;
  readonly abortSignal?: AbortSignal;
}

/**
 * Per-run inputs used by `Engine.preview()`. Same shape as
 * `EngineRunInput` minus the runtime/event/gate fields — preview
 * doesn't invoke, doesn't emit, doesn't gate.
 */
export interface PreviewInput {
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
