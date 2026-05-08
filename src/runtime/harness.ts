import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type VerifyResult, verifyChainText } from "../broker/audit-chain";
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
  type PhaseDispatchRequest,
  type PreviewInput,
  type PreviewServices,
  type WorkflowProgram,
} from "../orchestrator/engine";
import type { RunEvent } from "../orchestrator/events";
import { MastraEngine } from "../orchestrator/mastra";
import type { PhaseRunResult } from "../orchestrator/phase-runner";
import { type RunMeta, RunStore } from "../orchestrator/run-store";
import type { SandboxMode } from "../sandbox";
import type { Sandbox } from "../sandbox/types";
import { KNOWN_RUNTIME_NAMES } from "../worker/runtimes/registry";
import { RunExecution } from "./run-execution";

export type { VerifyResult } from "../broker/audit-chain";
export type { SandboxMode } from "../domain/config";
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
   * Override the per-phase dispatcher. When provided, replaces the
   * default worker-spawn path entirely. Tests use this to short-circuit
   * the worker process: the override receives the engine's
   * `PhaseDispatchRequest` and returns a synthetic `PhaseRunResult`
   * without ever touching `Sandbox.spawnWorker`. The eval suite uses
   * this to swap in `AiSdkRuntime` against a LiteLLM proxy.
   */
  readonly dispatchPhase?: (request: PhaseDispatchRequest) => Promise<PhaseRunResult>;
  /**
   * Resolve a `Gate` for a given workflow `gate` kind. Client interfaces
   * assemble their own resolver — the CLI builds one that wraps clack
   * around `HumanGate`; the eval suite (and headless / CI callers)
   * return `AutoGate` for every kind. Harness default (no override) is
   * `AutoGate` for every kind: safe headless behaviour, and production
   * flows always supply their own resolver explicitly.
   */
  readonly gateForKind?: (kind: Phase["gate"]) => Gate;
  /**
   * Resolve a yes/no decision when the agent attempts egress to a host
   * that isn't in `local_services` and isn't in srt's `allowedDomains`.
   * srt's `sandboxAskCallback` routes through `Broker.askApproval`,
   * which calls this hook on cache miss. CLIs wire it to an interactive
   * prompter (TUI gate card); headless callers leave it unset and the
   * broker denies. The signature is intentionally minimal — the prompt
   * UX has only the host/port to work with.
   */
  readonly egressGatePrompter?: (req: {
    host: string;
    port: number | undefined;
  }) => Promise<boolean>;
  /**
   * Direct override — programmatic callers (tests, eval suite) inject
   * a `Sandbox` instance to bypass mode resolution. Highest priority.
   */
  readonly sandbox?: Sandbox;
  /**
   * Sandbox mode override — typically the CLI's `--sandbox` flag.
   * Beats the config file's `sandbox:` field. Lower priority than
   * `sandbox` (which is a fully-resolved instance).
   */
  readonly sandboxMode?: SandboxMode;
  /**
   * Path to a YAML plan file for `ScriptedRuntime`. Wins over the
   * `runtimes.scripted.script_path` config value and the auto-detected
   * `scripts/<workflow>.yaml` convention. Typically set by the CLI's
   * `--script <path>` flag.
   */
  readonly scriptPath?: string;
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

interface PreparedRun {
  readonly state: LoadedState;
  readonly engine: Engine;
  readonly program: WorkflowProgram;
  readonly slug: string;
  readonly workspaceRoot: string;
}

export class HarnessRuntime {
  private loaded?: LoadedState;

  private readonly root: string;
  private readonly workflowName: string;
  private readonly engineName: string;
  private readonly dispatchPhaseOverride?: (
    request: PhaseDispatchRequest,
  ) => Promise<PhaseRunResult>;
  private readonly gateResolver: (kind: Phase["gate"]) => Gate;
  private readonly egressGatePrompter?: (req: {
    host: string;
    port: number | undefined;
  }) => Promise<boolean>;
  private readonly engines: EngineRegistry;
  private readonly sandboxOverride?: Sandbox;
  private readonly sandboxModeOverride?: SandboxMode;
  private readonly scriptPathOverride?: string;

  constructor(opts: HarnessRuntimeOptions = {}) {
    this.root = opts.root ?? defaultRoot();
    this.workflowName = opts.workflow ?? "software-delivery";
    this.engineName = opts.engine ?? "mastra";
    if (opts.dispatchPhase) this.dispatchPhaseOverride = opts.dispatchPhase;
    this.gateResolver = opts.gateForKind ?? defaultGateResolver;
    if (opts.egressGatePrompter) this.egressGatePrompter = opts.egressGatePrompter;
    this.engines = new EngineRegistry([new MastraEngine(), ...(opts.engines ?? [])]);
    this.sandboxOverride = opts.sandbox;
    this.sandboxModeOverride = opts.sandboxMode;
    this.scriptPathOverride = opts.scriptPath;
  }

  async startRun(input: StartRunInput): Promise<RunMeta> {
    const { state, engine, program, slug, workspaceRoot } = await this.prepareRun(input);
    const execution = await RunExecution.prepare({
      root: this.root,
      workflowName: this.workflowName,
      config: state.config,
      input,
      workspaceRoot,
      ...(this.dispatchPhaseOverride ? { dispatchPhaseOverride: this.dispatchPhaseOverride } : {}),
      ...(this.egressGatePrompter ? { egressGatePrompter: this.egressGatePrompter } : {}),
      ...(this.sandboxOverride ? { sandboxOverride: this.sandboxOverride } : {}),
      ...(this.sandboxModeOverride ? { sandboxModeOverride: this.sandboxModeOverride } : {}),
      ...(this.scriptPathOverride ? { scriptPathOverride: this.scriptPathOverride } : {}),
    });
    try {
      await execution.enter();
      const onEvent = execution.onEvent();
      const runInput: EngineRunInput = {
        task: input.task,
        slug,
        workspaceRoot,
        tier: input.tier ?? "M",
        ...(execution.sandboxMode ? { sandboxMode: execution.sandboxMode } : {}),
        ...(input.startAt ? { startAt: input.startAt } : {}),
        ...(input.onlyPhases ? { onlyPhases: input.onlyPhases } : {}),
        onGateRequested: (request) => this.handleGateRequest(request),
        onEvent,
        dispatchPhase: execution.dispatchPhase(),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      };
      return await engine.run(program, runInput, this.engineServices(state));
    } finally {
      await execution.dispose();
    }
  }

  /**
   * Compose the prompt for every phase without invoking any runtime.
   * Mirrors `startRun` shape (prepareRun → delegate) so dry-run
   * inherits all the same workflow slicing semantics (`onlyPhases`,
   * `startAt`, project resolution, slug validation).
   */
  async previewRun(input: StartRunInput): Promise<readonly PhasePreview[]> {
    const { state, engine, program, slug, workspaceRoot } = await this.prepareRun(input);
    const previewInput: PreviewInput = {
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

  /**
   * Walk the per-run audit chain (`<runStoreDir>/<runId>/audit.jsonl`)
   * and report tamper status. Returns the same VerifyResult shape the
   * pure verifier produces; the CLI layer renders it.
   */
  async verifyAudit(runId: string): Promise<VerifyResult> {
    const { runStore } = await this.load();
    const path = join(runStore.runDir(runId), "audit.jsonl");
    const text = await readFile(path, "utf8");
    return verifyChainText(text);
  }

  async workflowDefinition(): Promise<WorkflowManifest> {
    const { workflow } = await this.load();
    return workflow;
  }

  async resolveRunWorkspace(
    input: Pick<StartRunInput, "projectName" | "repoPath">,
  ): Promise<string> {
    const { projects } = await this.load();
    return this.resolveWorkspaceRoot(input as StartRunInput, projects);
  }

  /**
   * Configured sandbox mode (after applying the resolution order:
   * `sandboxMode` constructor override > config file). Used by the
   * doctor command for diagnostic reporting.
   */
  async sandboxMode(): Promise<SandboxMode> {
    if (this.sandboxModeOverride) return this.sandboxModeOverride;
    const { config } = await this.load();
    return config.sandboxMode();
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

  private async prepareRun(input: StartRunInput): Promise<PreparedRun> {
    const state = await this.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = await this.resolveWorkspaceRoot(input, state.projects);
    const engine = this.engines.get(this.engineName);
    const program = engine.compile(this.workflowForRun(state.workflow, input));
    return { state, engine, program, slug, workspaceRoot };
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

  private async resolveWorkspaceRoot(
    input: StartRunInput,
    projects: ProjectRegistry,
  ): Promise<string> {
    if (input.repoPath && input.projectName) {
      throw new Error(
        "startRun accepts either `projectName` (registry) or `repoPath`, not both — " +
          "pick the one that names the workspace you mean to run against.",
      );
    }
    const workspaceRoot = input.repoPath
      ? resolve(input.repoPath)
      : input.projectName
        ? projects.get(input.projectName).path
        : undefined;
    if (!workspaceRoot) {
      throw new Error("startRun requires either `projectName` (registry) or `repoPath`");
    }
    await assertWorkspaceDirectory(workspaceRoot);
    return workspaceRoot;
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
      runtimeNames: new Set(KNOWN_RUNTIME_NAMES),
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
    const gate = this.gateResolver(request.gateKind);
    return gate.request({
      runId: request.runId,
      phaseId: request.phaseId,
      cwd: request.cwd,
      artefacts: request.artefacts,
      summary: request.summary,
    });
  }
}

/**
 * Strict default: only `auto` gates are auto-approved. `human` and
 * `pre-commit` require an explicit `gateForKind` resolver — the CLI
 * wires clack + HumanGate; eval/CI callers supply `() => new AutoGate()`
 * to opt into headless approval. Failing closed here prevents a caller
 * from silently shipping past a human checkpoint by forgetting to wire
 * a resolver.
 */
function defaultGateResolver(kind: Phase["gate"]): Gate {
  switch (kind) {
    case "auto":
      return new AutoGate();
    case "human":
    case "pre-commit":
      throw new Error(
        `Gate kind "${kind}" requires an explicit \`gateForKind\` resolver on HarnessRuntime. ` +
          "Pass one (e.g. clack-backed HumanGate for CLI, or `() => new AutoGate()` for headless).",
      );
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown gate kind: ${String(_exhaustive)}`);
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

async function assertWorkspaceDirectory(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (err) {
    const code =
      typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      throw new Error(`Workspace path does not exist: ${path}`);
    }
    throw err;
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${path}`);
  }
}
