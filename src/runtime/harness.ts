import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Broker } from "../broker";
import { type VerifyResult, verifyChainText } from "../broker/audit-chain";
import { AuditService } from "../broker/audit-service";
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
import { startTracing } from "../observability/tracing";
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
import { PhaseRunner, type PhaseRunResult } from "../orchestrator/phase-runner";
import { type RunMeta, RunStore } from "../orchestrator/run-store";
import { buildAllRuntimes } from "../runtimes/registry";
import type { AgentRuntime } from "../runtimes/types";
import { type SandboxMode, selectSandbox } from "../sandbox";
import type { Sandbox } from "../sandbox/types";

export type { VerifyResult } from "../broker/audit-chain";
export type { SandboxMode } from "../domain/config";
export type { PhasePreview } from "../domain/phase-preview";
export type { RunEvent } from "../orchestrator/events";
export type { PhaseMeta, RunMeta } from "../orchestrator/run-store";
// Re-exported so the CLI's `doctor` resolves the same `claude` the
// runtime would launch without violating the cli → runtimes rule.
export { resolveClaudeBin } from "../runtimes/claude-cli";

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
  private readonly runtimesOverride?: ReadonlyMap<string, AgentRuntime>;
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
    startTracing();
    this.root = opts.root ?? defaultRoot();
    this.workflowName = opts.workflow ?? "software-delivery";
    this.engineName = opts.engine ?? "mastra";
    this.runtimesOverride = opts.runtimes;
    this.gateResolver = opts.gateForKind ?? defaultGateResolver;
    if (opts.egressGatePrompter) this.egressGatePrompter = opts.egressGatePrompter;
    this.engines = new EngineRegistry([new MastraEngine(), ...(opts.engines ?? [])]);
    this.sandboxOverride = opts.sandbox;
    this.sandboxModeOverride = opts.sandboxMode;
    this.scriptPathOverride = opts.scriptPath;
  }

  async startRun(input: StartRunInput): Promise<RunMeta> {
    const { state, engine, program, slug, workspaceRoot } = await this.prepareRun(input);
    const infra = this.buildInfra(state, input);
    await infra.sandbox.enterIfNeeded({
      workspaceRoot,
      runStoreDir: state.config.runStoreDir(),
      harnessRoot: this.root,
    });
    try {
      const onEvent = makeOnEvent(infra, input);
      const runInput: EngineRunInput = {
        task: input.task,
        slug,
        workspaceRoot,
        tier: input.tier ?? "M",
        onGateRequested: (request) => this.handleGateRequest(request),
        onEvent,
        dispatchPhase: this.makeDispatchPhase(infra, state),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      };
      return await engine.run(program, runInput, this.engineServices(state));
    } finally {
      if (infra.kind === "srt") await infra.audit.closeAll();
      await infra.sandbox.shutdown();
    }
  }

  /**
   * Build the engine's `dispatchPhase` callback. srt mode spawns one
   * sandboxed worker per phase; passthrough mode runs the phase in-
   * process via `PhaseRunner` directly. Both paths return the same
   * `PhaseRunResult`; the engine doesn't care which was used.
   */
  private makeDispatchPhase(
    infra: RunInfra,
    state: LoadedState,
  ): (req: PhaseDispatchRequest) => Promise<PhaseRunResult> {
    if (infra.kind === "srt") {
      const sandbox = infra.sandbox;
      const harnessRoot = this.root;
      const workflowName = this.workflowName;
      const scriptPath = this.scriptPathOverride;
      const configFile = this.paths().configFile;
      return async (req) => {
        const planPath = join(req.runDir, `worker-${req.phase.id}-${req.iteration}.plan.json`);
        const resultPath = join(req.runDir, `worker-${req.phase.id}-${req.iteration}.result.json`);
        const plan = {
          configFile,
          harnessRoot,
          workflowName,
          ...(scriptPath ? { scriptPath } : {}),
          runId: req.runId,
          runDir: req.runDir,
          iteration: req.iteration,
          phase: req.phase,
          preview: req.preview,
          runtimeName: req.runtimeName,
          resultPath,
        };
        await writeFile(planPath, JSON.stringify(plan));
        const handle = sandbox.spawnWorker({
          argv: [process.execPath, workerEntryPath(harnessRoot), "--plan", planPath],
          env: process.env,
        });
        if (req.abortSignal) {
          const onAbort = () => handle.kill("SIGTERM");
          req.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
        const code = await handle.exit;
        if (code !== 0) {
          throw new Error(
            `worker for phase "${req.phase.id}" iteration ${req.iteration} exited ${code}`,
          );
        }
        const resultText = await readFile(resultPath, "utf8");
        return JSON.parse(resultText) as PhaseRunResult;
      };
    }
    // Passthrough: no sandbox boundary, no worker spawn. Run the phase
    // in-process — same shape as before L2.
    const runner = new PhaseRunner();
    const runtimes = this.runtimesFor(state.config);
    return async (req) => {
      const runtime = runtimes.get(req.runtimeName);
      if (!runtime) {
        throw new Error(
          `runtime "${req.runtimeName}" requested by phase "${req.phase.id}" not registered`,
        );
      }
      return runner.run({
        preview: req.preview,
        runtime,
        context: { runId: req.runId, runDir: req.runDir, iteration: req.iteration },
        emit: req.emit,
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
      });
    };
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
    const workspaceRoot = this.resolveWorkspaceRoot(input, state.projects);
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

  private resolveWorkspaceRoot(input: StartRunInput, projects: ProjectRegistry): string {
    if (input.repoPath && input.projectName) {
      throw new Error(
        "startRun accepts either `projectName` (registry) or `repoPath`, not both — " +
          "pick the one that names the workspace you mean to run against.",
      );
    }
    if (input.repoPath) return resolve(input.repoPath);
    if (input.projectName) return projects.get(input.projectName).path;
    throw new Error("startRun requires either `projectName` (registry) or `repoPath`");
  }

  private workflowForRun(workflow: WorkflowManifest, input: StartRunInput): WorkflowManifest {
    if (input.onlyPhases) return workflow.only(input.onlyPhases);
    if (input.startAt) return workflow.startingAt(input.startAt);
    return workflow;
  }

  /**
   * Build the per-run infra bundle: the `Sandbox`, plus (for srt mode)
   * the `Broker` + `AuditService` it fronts. Wires the audit chain's
   * `onEvent` to forward worker-emitted events into the harness's
   * `StartRunInput.onEvent` so the parent's TUI sees them in real time.
   *
   * Resolution order: explicit `Sandbox` instance override > `sandboxMode`
   * override (typically the CLI flag) > config file's `sandbox:` field.
   */
  private buildInfra(state: LoadedState, input: StartRunInput): RunInfra {
    if (this.sandboxOverride) {
      return { kind: "override", sandbox: this.sandboxOverride };
    }
    const mode = this.sandboxModeOverride ?? state.config.sandboxMode();
    if (mode === "passthrough") {
      return { kind: "passthrough", sandbox: selectSandbox(mode) };
    }
    // srt: stand up audit + broker. AuditService is the single fan-out
    // point — every appended event flows back to `input.onEvent`,
    // covering both worker-emitted RunEvents (delivered as HTTP audit
    // POSTs) and parent-emitted RunEvents (which startRun's onEvent
    // funnels through audit.appendEvent). `broker.*` observations are
    // chain-only and don't propagate to the TUI.
    const audit = new AuditService({
      runStoreDir: state.config.runStoreDir(),
      onEvent: (ev) => {
        if (ev.kind.startsWith("broker.")) return;
        input.onEvent?.(ev.payload as RunEvent);
      },
    });
    const services = state.config.localServices();
    const broker = new Broker(services, {
      proxyAuth: randomBytes(32).toString("hex"),
      internalServices: [audit.asInternalService()],
      onEgress: audit.egressSink(),
      ...(this.egressGatePrompter ? { onEgressGate: this.egressGatePrompter } : {}),
    });
    return { kind: "srt", sandbox: selectSandbox(mode, { broker }), broker, audit };
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
    const gate = this.gateResolver(request.gateKind);
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
      buildAllRuntimes(config, {
        harnessRoot: this.root,
        workflowName: this.workflowName,
        ...(this.scriptPathOverride ? { scriptPath: this.scriptPathOverride } : {}),
      })
    );
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

/**
 * Per-run infra bundle returned by `buildInfra`. The `kind` discriminator
 * keeps callers from reaching for `audit`/`broker` in modes that don't
 * have them.
 */
type RunInfra =
  | { readonly kind: "passthrough"; readonly sandbox: Sandbox }
  | { readonly kind: "override"; readonly sandbox: Sandbox }
  | {
      readonly kind: "srt";
      readonly sandbox: Sandbox;
      readonly broker: Broker;
      readonly audit: AuditService;
    };

/**
 * Pick the right per-event funnel for the resolved infra. srt routes
 * everything through `audit.appendEvent` so the chain + the TUI fan-out
 * share a single path; passthrough has no audit so it forwards directly.
 */
function makeOnEvent(infra: RunInfra, input: StartRunInput): (event: RunEvent) => void {
  if (infra.kind === "srt") {
    const audit = infra.audit;
    return (ev) => {
      audit.appendEvent({ runId: ev.runId, kind: ev.type, payload: ev }).catch((err: unknown) => {
        console.warn(`[harness] audit append failed: ${errMessage(err)}`);
      });
    };
  }
  return (ev) => input.onEvent?.(ev);
}

function workerEntryPath(harnessRoot: string): string {
  return join(harnessRoot, "src", "runtime", "worker", "entry.ts");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
