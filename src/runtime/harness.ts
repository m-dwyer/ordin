import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "../domain/agent";
import type { HarnessConfig } from "../domain/config";
import type { PhasePreview } from "../domain/phase-preview";
import type { ProjectRegistry } from "../domain/project";
import type { Phase, WorkflowManifest } from "../domain/workflow";
import { AutoGate } from "../gates/auto";
import type { Gate, GateDecision } from "../gates/types";
import { AgentLoader } from "../infrastructure/agent-loader";
import { HarnessConfigLoader } from "../infrastructure/config-loader";
import { ProjectRegistryLoader } from "../infrastructure/project-loader";
import { SkillLoader } from "../infrastructure/skill-loader";
import { WorkflowLoader } from "../infrastructure/workflow-loader";
import {
  type Engine,
  EngineRegistry,
  type EngineRunInput,
  type EngineServices,
  type GateRequest,
  type PreviewInput,
  type PreviewServices,
} from "../orchestrator/engine";
import type { RunEvent } from "../orchestrator/events";
import { MastraEngine } from "../orchestrator/mastra";
import { type RunMeta, RunStore } from "../orchestrator/run-store";
import { AiSdkRuntime } from "../runtimes/ai-sdk";
import { ClaudeCliRuntime } from "../runtimes/claude-cli";
import type { AgentRuntime } from "../runtimes/types";

export type { PhasePreview } from "../domain/phase-preview";
export type { RunEvent } from "../orchestrator/events";
export type { PhaseMeta, RunMeta } from "../orchestrator/run-store";

/**
 * Stable library surface. The CLI is the Stage 1 client; Phase 2 adds
 * an HTTP adapter that will call the same methods.
 */
export interface HarnessRuntimeOptions {
  /** Harness repo root. Defaults to the repo this module lives in. */
  readonly root?: string;
  /**
   * Which workflow to execute. Defaults to "software-delivery".
   * Resolved as `<root>/workflows/<name>.yaml`.
   */
  readonly workflow?: string;
  /** Engine adapter used to compile and run workflows. Defaults to "mastra". */
  readonly engine?: string;
  /** Additional engine adapters that can be selected via `engine`. */
  readonly engines?: Iterable<Engine>;
  /**
   * Override the runtime map. Keys are the runtime names the workflow
   * references (today: "claude-cli"). When provided, the default
   * `ClaudeCliRuntime` construction is skipped entirely — callers supply
   * whatever `AgentRuntime` they want slotted into each workflow-declared
   * name. Used by the eval suite to run phases through `AiSdkRuntime`
   * against a LiteLLM proxy.
   */
  readonly runtimes?: ReadonlyMap<string, AgentRuntime>;
  /**
   * Resolve a `Gate` for a given workflow `gate` kind. Client interfaces
   * assemble their own resolver — the CLI builds one that wraps clack
   * around `HumanGate`; the eval suite (and headless / CI callers)
   * return `AutoGate` for every kind. Harness default (no override) is
   * `AutoGate` for every kind: safe headless behaviour, and production
   * flows always supply their own resolver explicitly.
   */
  readonly gateForKind?: (kind: Phase["gate"]) => Gate;
}

export interface StartRunInput {
  readonly task: string;
  readonly slug: string;
  readonly projectName?: string;
  readonly repoPath?: string;
  readonly tier?: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  /** Begin at this phase; earlier phases are skipped. */
  readonly startAt?: string;
  /** Run only these phases (in workflow order). Overrides startAt. */
  readonly onlyPhases?: readonly string[];
  readonly abortSignal?: AbortSignal;
}

interface LoadedState {
  readonly config: HarnessConfig;
  readonly workflow: WorkflowManifest;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly projects: ProjectRegistry;
  readonly runStore: RunStore;
}

export class HarnessRuntime {
  private loaded?: LoadedState;

  private readonly root: string;
  private readonly workflowName: string;
  private readonly engineName: string;
  private readonly runtimesOverride?: ReadonlyMap<string, AgentRuntime>;
  private readonly gateResolver?: (kind: Phase["gate"]) => Gate;
  private readonly engines: EngineRegistry;

  constructor(opts: HarnessRuntimeOptions = {}) {
    this.root = opts.root ?? defaultRoot();
    this.workflowName = opts.workflow ?? "software-delivery";
    this.engineName = opts.engine ?? "mastra";
    this.runtimesOverride = opts.runtimes;
    this.gateResolver = opts.gateForKind;
    this.engines = new EngineRegistry([new MastraEngine(), ...(opts.engines ?? [])]);
  }

  async startRun(input: StartRunInput): Promise<RunMeta> {
    const state = await this.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = this.resolveWorkspaceRoot(input, state.projects);
    const engine = this.engines.get(this.engineName);
    const program = engine.compile(this.workflowForRun(state.workflow, input));

    const runInput: EngineRunInput = {
      workflow: program.manifest,
      task: input.task,
      slug,
      workspaceRoot,
      tier: input.tier ?? "M",
      onGateRequested: (request) => this.handleGateRequest(request),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    };
    return engine.run(program, runInput, this.engineServices(state));
  }

  /**
   * Compose the prompt for every phase without invoking any runtime.
   * Mirrors `startRun` shape (load → compile → delegate) so dry-run
   * inherits all the same workflow slicing semantics (`onlyPhases`,
   * `startAt`, project resolution, slug validation).
   */
  async previewRun(input: StartRunInput): Promise<readonly PhasePreview[]> {
    const state = await this.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = this.resolveWorkspaceRoot(input, state.projects);
    const engine = this.engines.get(this.engineName);
    const program = engine.compile(this.workflowForRun(state.workflow, input));

    const previewInput: PreviewInput = {
      workflow: program.manifest,
      task: input.task,
      slug,
      workspaceRoot,
      tier: input.tier ?? "M",
    };
    const previewServices: PreviewServices = {
      config: state.config,
      agents: state.agents,
    };
    return engine.preview(program, previewInput, previewServices);
  }

  async listRuns(): Promise<RunMeta[]> {
    const { runStore } = await this.load();
    return runStore.listRuns();
  }

  async getRun(runId: string): Promise<RunMeta> {
    const { runStore } = await this.load();
    return runStore.readMeta(runId);
  }

  async workflowDefinition(): Promise<WorkflowManifest> {
    const { workflow } = await this.load();
    return workflow;
  }

  /** Paths ordin knows about — useful for the CLI `doctor` command. */
  paths(): HarnessPaths {
    return {
      root: this.root,
      configFile: join(this.root, "ordin.config.yaml"),
      workflowFile: join(this.root, "workflows", `${this.workflowName}.yaml`),
      agentsDir: join(this.root, "agents"),
      skillsDir: join(this.root, "skills"),
      projectsFile: join(this.root, "projects.yaml"),
      projectsLocalFile: join(this.root, "projects.local.yaml"),
    };
  }

  private async load(): Promise<LoadedState> {
    if (this.loaded) return this.loaded;
    const paths = this.paths();
    const configLoader = new HarnessConfigLoader();
    const projectLoader = new ProjectRegistryLoader();
    const [config, workflow, skills, projects] = await Promise.all([
      configLoader.load(paths.configFile),
      new WorkflowLoader().load(paths.workflowFile),
      new SkillLoader().loadAll(paths.skillsDir),
      projectLoader.load(paths.projectsFile, paths.projectsLocalFile),
    ]);
    const agents = await new AgentLoader().loadAll(paths.agentsDir, skills);
    this.loaded = {
      config,
      workflow,
      agents,
      projects,
      runStore: new RunStore(config.runStoreDir()),
    };
    return this.loaded;
  }

  private resolveWorkspaceRoot(input: StartRunInput, projects: ProjectRegistry): string {
    if (input.repoPath) return resolve(input.repoPath);
    if (input.projectName) return projects.get(input.projectName).path;
    throw new Error("startRun requires either `projectName` (registry) or `repoPath`");
  }

  private workflowForRun(workflow: WorkflowManifest, input: StartRunInput): WorkflowManifest {
    if (input.onlyPhases) return workflow.only(input.onlyPhases);
    if (input.startAt) return workflow.startingAt(input.startAt);
    return workflow;
  }

  private engineServices(state: LoadedState): EngineServices {
    return {
      config: state.config,
      agents: state.agents,
      runtimes: this.runtimesFor(state.config),
      runStore: state.runStore,
    };
  }

  /**
   * Adapts the engine's gate-agnostic `GateRequest` to whichever
   * `Gate` impl the harness has wired for the requested kind. Engine
   * doesn't know about `Gate`, `clack`, `AutoGate`, etc. — that
   * vocabulary stops here at the harness boundary.
   */
  private async handleGateRequest(request: GateRequest): Promise<GateDecision> {
    const resolver = this.gateResolver ?? this.gateForKind.bind(this);
    const gate = resolver(request.gateKind);
    return gate.request({
      runId: request.runId,
      phaseId: request.phaseId,
      cwd: request.cwd,
      artefacts: request.artefacts,
      summary: request.summary,
    });
  }

  private runtimesFor(config: HarnessConfig): ReadonlyMap<string, AgentRuntime> {
    return (
      this.runtimesOverride ??
      new Map<string, AgentRuntime>([
        [
          "ai-sdk",
          AiSdkRuntime.fromConfig(config.runtimeConfig("ai-sdk"), {
            runsDir: config.runStoreDir(),
          }),
        ],
        [
          "claude-cli",
          ClaudeCliRuntime.fromConfig(config.runtimeConfig("claude-cli"), {
            // The ordin repo itself is a Claude Code plugin
            // (.claude-plugin/plugin.json + top-level skills/). Loading it
            // per-invocation means zero pollution of ~/.claude/.
            pluginDirs: [this.root],
            runsDirFallback: config.runStoreDir(),
          }),
        ],
      ])
    );
  }

  /**
   * Headless default: auto-approve for every kind. Production callers
   * (CLI, HTTP, Slack) supply their own resolver via `gateForKind` that
   * wires `HumanGate` + the appropriate prompter. Kept in the harness
   * (rather than forcing every caller to opt in) so CI / eval / library
   * consumers just work out of the box.
   */
  private gateForKind(kind: Phase["gate"]): Gate {
    switch (kind) {
      case "human":
      case "auto":
      case "pre-commit":
        return new AutoGate();
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unknown gate kind: ${String(_exhaustive)}`);
      }
    }
  }
}

export interface HarnessPaths {
  readonly root: string;
  readonly configFile: string;
  readonly workflowFile: string;
  readonly agentsDir: string;
  readonly skillsDir: string;
  readonly projectsFile: string;
  readonly projectsLocalFile: string;
}

function requireSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}": use lowercase kebab-case (e.g. "add-user-search")`);
  }
  return slug;
}

function defaultRoot(): string {
  // Walk up from this file: src/runtime/harness.ts → src/runtime → src → root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
