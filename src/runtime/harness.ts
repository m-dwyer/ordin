import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { context, trace } from "@opentelemetry/api";
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
import { shutdownTracing, startTracing } from "../observability/tracing";
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
import { type SandboxMode, selectSandbox } from "../sandbox";
import type { Sandbox } from "../sandbox/types";
import { workerArgv } from "../worker/locator";
import { KNOWN_RUNTIME_NAMES } from "../worker/runtimes/registry";
import type { InvokeRequest, InvokeResult, RuntimeEvent } from "../worker/runtimes/types";
import { resolveClaudeBin } from "./resolve-claude-bin";
import { buildWorkerEnv, workerReadRoots } from "./worker-policy";

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
    const infra = this.buildInfra(state, input);
    let tracingStarted = false;
    try {
      // Broker must be listening before the sandbox initialises — srt
      // needs the bound port for its parentProxy URL. Parent-side
      // tracing uses that same broker proxy, so start it after bind and
      // flush before teardown.
      if (infra.kind === "managed") {
        await infra.broker.start();
        tracingStarted = startParentTracing(infra);
      }
      await infra.sandbox.enterIfNeeded({
        workspaceRoot,
        runStoreDir: state.config.runStoreDir(),
        harnessRoot: this.root,
        workerReadRoots: workerReadRoots(this.root),
      });
      const onEvent = makeOnEvent(infra, input);
      const runInput: EngineRunInput = {
        task: input.task,
        slug,
        workspaceRoot,
        tier: input.tier ?? "M",
        ...(infra.kind === "managed" ? { sandboxMode: infra.mode } : {}),
        ...(input.startAt ? { startAt: input.startAt } : {}),
        ...(input.onlyPhases ? { onlyPhases: input.onlyPhases } : {}),
        onGateRequested: (request) => this.handleGateRequest(request),
        onEvent,
        dispatchPhase: this.makeDispatchPhase(infra, state),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      };
      return await engine.run(program, runInput, this.engineServices(state));
    } finally {
      if (infra.kind === "managed") {
        if (tracingStarted) await shutdownTracing();
        await infra.audit.closeAll();
        await infra.broker.stop();
      }
      await infra.sandbox.shutdown();
    }
  }

  /**
   * Build the engine's `dispatchPhase` callback. Always spawns a
   * sandboxed worker — in srt mode the worker is wrapped by srt; in
   * passthrough mode it's a plain `Bun.spawn`. Uniform path means one
   * code path to test and no parent value-import of worker code.
   *
   * The plan carries a parent-resolved runtime config slice so the
   * worker doesn't load `ordin.config.yaml` itself. For claude-cli,
   * the `bin` is resolved through `resolveClaudeBin` parent-side so
   * the worker sees an absolute (or PATH-resolvable) string and never
   * touches the env or the user's PATH.
   *
   * Phase lifecycle bookkeeping (`phase.started` / `phase.runtime.completed`
   * / `phase.failed`) and runId/phaseId tagging happen here, in the
   * parent — `PhaseRunner` is the shared driver. Runtime events flow
   * back to the parent over the worker's stdout as one JSON object per
   * line (no broker round-trip), and the worker writes its `InvokeResult`
   * to a file we read on exit.
   */
  private makeDispatchPhase(
    infra: RunInfra,
    state: LoadedState,
  ): (req: PhaseDispatchRequest) => Promise<PhaseRunResult> {
    if (this.dispatchPhaseOverride) return this.dispatchPhaseOverride;
    const sandbox = infra.sandbox;
    const harnessRoot = this.root;
    const workflowName = this.workflowName;
    const scriptPath = this.scriptPathOverride;
    const config = state.config;
    const workerEnv = buildWorkerEnv(infra, process.env);
    return async (req) => {
      const planPath = join(req.runDir, `worker-${req.phase.id}-${req.iteration}.plan.json`);
      const resultPath = join(req.runDir, `worker-${req.phase.id}-${req.iteration}.result.json`);
      const plan = {
        harnessRoot,
        workflowName,
        ...(scriptPath ? { scriptPath } : {}),
        runsDir: config.runStoreDir(),
        runId: req.runId,
        runDir: req.runDir,
        iteration: req.iteration,
        phase: req.phase,
        preview: req.preview,
        runtimeName: req.runtimeName,
        runtimeConfig: resolveRuntimeConfig(req.runtimeName, config.runtimeConfig(req.runtimeName)),
        resultPath,
      };
      await writeFile(planPath, JSON.stringify(plan));
      return new PhaseRunner().run({
        preview: req.preview,
        runtimeName: req.runtimeName,
        context: { runId: req.runId, runDir: req.runDir, iteration: req.iteration },
        emit: req.emit,
        invoke: (invokeReq) =>
          spawnWorkerInvoke({
            sandbox,
            harnessRoot,
            workerEnv,
            planPath,
            resultPath,
            phaseId: req.phase.id,
            iteration: req.iteration,
            invokeReq,
          }),
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

  /**
   * Build the per-run infra bundle: the `Sandbox`, the `Broker`, and the
   * `AuditService`. The broker is wired regardless of mode — srt uses it
   * as the kernel-enforced parentProxy; passthrough still uses it for
   * forward services (otel/llm-gateway) so "switch sandbox modes" is a
   * true substitution. Runtime observation events flow over the worker's
   * stdout JSONL channel under L2 (Phase B); the broker is no longer in
   * the audit data path.
   *
   * Resolution order: explicit `Sandbox` instance override > `sandboxMode`
   * override (typically the CLI flag) > config file's `sandbox:` field.
   */
  private buildInfra(state: LoadedState, input: StartRunInput): RunInfra {
    if (this.sandboxOverride) {
      return { kind: "override", sandbox: this.sandboxOverride };
    }
    const mode = this.sandboxModeOverride ?? state.config.sandboxMode();
    // AuditService is the single fan-out point — every appended event
    // flows back to `input.onEvent`. Parent-emitted RunEvents (run
    // lifecycle, phase lifecycle, runtime observations) all funnel
    // through `audit.appendEvent` from `makeOnEvent`. `broker.*`
    // observations are chain-only and don't propagate to the TUI.
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
      onEgress: audit.egressSink(),
      ...(this.egressGatePrompter ? { onEgressGate: this.egressGatePrompter } : {}),
    });
    return {
      kind: "managed",
      mode,
      sandbox: selectSandbox(mode, { broker }),
      broker,
      audit,
      services,
    };
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

/**
 * Per-run infra bundle returned by `buildInfra`. The `kind` discriminator
 * keeps callers from reaching for `audit`/`broker` in modes that don't
 * have them.
 */
type RunInfra =
  | { readonly kind: "override"; readonly sandbox: Sandbox }
  | {
      readonly kind: "managed";
      readonly mode: SandboxMode;
      readonly sandbox: Sandbox;
      readonly broker: Broker;
      readonly audit: AuditService;
      readonly services: Readonly<Record<string, unknown>>;
    };

/**
 * Pick the right per-event funnel for the resolved infra. Managed
 * infra (any caller-non-overridden mode) routes everything through
 * `audit.appendEvent` so the chain writer + the TUI fan-out share a
 * single path. The `override` branch (programmatic Sandbox injection)
 * has no audit, so events go directly to the caller's `onEvent`.
 */
function makeOnEvent(infra: RunInfra, input: StartRunInput): (event: RunEvent) => void {
  if (infra.kind === "managed") {
    const audit = infra.audit;
    return (ev) => {
      audit.appendEvent({ runId: ev.runId, kind: ev.type, payload: ev }).catch((err: unknown) => {
        console.warn(`[harness] audit append failed: ${errMessage(err)}`);
      });
    };
  }
  return (ev) => input.onEvent?.(ev);
}

function startParentTracing(infra: RunInfra): boolean {
  if (infra.kind !== "managed") return false;
  if (!Object.hasOwn(infra.services, "otel")) return false;
  return startTracing({ enabled: true, proxyUrl: infra.broker.proxyUrl() });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * Pre-resolve any parent-side concerns in a runtime's config slice so
 * the worker can build the runtime without env or PATH access. Today
 * the only resolution is Claude CLI-backed runtime bins through
 * `resolveClaudeBin` (honors `CLAUDE_BIN` env, defaults to `"claude"`).
 * Other runtimes pass through untouched.
 */
function resolveRuntimeConfig(name: string, slice: unknown): unknown {
  if (name === "claude-cli" || name === "claude-cli-provider") {
    const cur = (slice ?? {}) as { bin?: string };
    return { ...cur, bin: resolveClaudeBin(cur.bin) };
  }
  return slice;
}

interface SpawnWorkerInvokeArgs {
  readonly sandbox: Sandbox;
  readonly harnessRoot: string;
  readonly workerEnv: NodeJS.ProcessEnv;
  readonly planPath: string;
  readonly resultPath: string;
  readonly phaseId: string;
  readonly iteration: number;
  readonly invokeReq: InvokeRequest;
}

/**
 * Spawn the sandboxed worker and shape its lifecycle into the
 * `(InvokeRequest) => InvokeResult` contract `PhaseRunner` expects.
 * Stdout is the JSONL channel: each line is a `RuntimeEvent` the
 * worker emits via its `onEvent` callback. We read + dispatch in a
 * background reader, await the child's exit, then read the result
 * file the worker wrote.
 */
async function spawnWorkerInvoke(args: SpawnWorkerInvokeArgs): Promise<InvokeResult> {
  const { sandbox, harnessRoot, workerEnv, planPath, resultPath, phaseId, iteration, invokeReq } =
    args;
  // Stamp the active OTel span as W3C `TRACEPARENT` so the worker can
  // hand it to Mastra's `tracingOptions` and Mastra-emitted spans
  // (chat / tool calls forwarded to Langfuse) nest under the active
  // `ordin.phase.*` span instead of producing a sibling trace tree.
  // No-op when tracing is disabled — `trace.getSpan` returns
  // undefined under the API's default no-op TracerProvider.
  const traceparent = serializeActiveTraceparent();
  const env = traceparent ? { ...workerEnv, TRACEPARENT: traceparent } : workerEnv;
  const handle = sandbox.spawnWorker({
    argv: [...workerArgv({ harnessRoot }), "--plan", planPath],
    env,
  });
  const events = consumeRuntimeEvents(handle.stdout, invokeReq.onEvent);
  if (invokeReq.abortSignal) {
    const onAbort = () => handle.kill("SIGTERM");
    invokeReq.abortSignal.addEventListener("abort", onAbort, { once: true });
  }
  const code = await handle.exit;
  await events;
  if (code !== 0) {
    throw new Error(`worker for phase "${phaseId}" iteration ${iteration} exited ${code}`);
  }
  const resultText = await readFile(resultPath, "utf8");
  return JSON.parse(resultText) as InvokeResult;
}

/**
 * Serialize the currently-active OTel span to a W3C Trace Context
 * `traceparent` value (`00-<traceId>-<spanId>-<flags>`). Returns
 * undefined when no SDK is active — under `@opentelemetry/api`'s
 * default no-op tracer provider, `trace.getSpan` returns undefined.
 */
function serializeActiveTraceparent(): string | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const sc = span.spanContext();
  if (!sc.traceId || !sc.spanId) return undefined;
  const flags = (sc.traceFlags ?? 0).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

/**
 * Read the worker's stdout one line at a time, parse each as a
 * `RuntimeEvent`, and forward to the supplied callback. Resolves when
 * the stream ends (i.e. the worker has closed stdout). Malformed lines
 * are logged and dropped — runtime events are supplementary observation
 * data, never load-bearing for run correctness.
 */
async function consumeRuntimeEvents(
  stdout: NodeJS.ReadableStream,
  onEvent: ((event: RuntimeEvent) => void) | undefined,
): Promise<void> {
  const rl = createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RuntimeEvent;
      onEvent?.(parsed);
    } catch (err) {
      console.warn(`[worker] dropped malformed event line: ${errMessage(err)}`);
    }
  }
}
