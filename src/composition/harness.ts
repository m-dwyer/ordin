import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VerifyResult } from "../broker/audit-chain";
import type { BundleHash } from "../domain/bundle";
import type { PhasePreview } from "../domain/phase-preview";
import type { WorkflowManifest } from "../domain/workflow";
import { BundleLoader } from "../infrastructure/bundle-loader";
import { BundleResolver } from "../infrastructure/bundle-resolver";
import type { Engine, PhaseDispatchRequest } from "../orchestrator/engine";
import type { RunEvent } from "../orchestrator/events";
import type { PhaseInvocationResult } from "../orchestrator/phase-invocation";
import type { RunMeta } from "../orchestrator/run-store";
import type { SandboxMode } from "../sandbox";
import { DefaultHarnessStateLoader, type HarnessPaths } from "./default-harness-state-loader";
import { PreviewRunUseCase } from "./preview-run";
import { RunExecutionFactory } from "./run-execution";
import { GetRunUseCase, ListRunsUseCase, VerifyAuditUseCase } from "./run-queries";
import { DefaultRunSession, type RunSession } from "./run-session";
import { StartRunUseCase } from "./start-run";
import type { StartRunInput } from "./start-run-input";
import { WorkspaceResolver } from "./workspace-resolver";

export type { VerifyResult } from "../broker/audit-chain";
export type { SandboxMode } from "../domain/config";
export type { PhasePreview } from "../domain/phase-preview";
export type { Phase } from "../domain/workflow";
export type { Gate } from "../gates/types";
export type { RunEvent } from "../orchestrator/events";
export type { PhaseMeta, RunMeta } from "../orchestrator/run-store";
export type { PendingGate, RunSession } from "./run-session";
export type { StartRunInput } from "./start-run-input";

/**
 * Stable library surface. The CLI is the Stage 1 client; HTTP and MCP
 * adapters call through `RunService` which itself goes through this
 * runtime.
 */
export interface HarnessOptions {
  /** Harness config root (where ordin.config.yaml + projects.yaml live). */
  readonly root?: string;
  /**
   * Bundle to execute. Resolved against the search path:
   *   --bundle-dir override → $ORDIN_BUNDLE_PATH → <cwd>/bundles → ~/.ordin/bundles
   */
  readonly bundle: string;
  /** Explicit bundle directory; bypasses search-path resolution. */
  readonly bundleDir?: string;
  /** Engine adapter used to compile and run workflows. Defaults to "mastra". */
  readonly engine?: string;
  /** Additional engine adapters that can be selected via `engine`. */
  readonly engines?: Iterable<Engine>;
  /**
   * Override the per-phase dispatcher. When provided, replaces the
   * default worker-spawn path entirely. Tests use this to short-circuit
   * the worker process: the override receives the engine's
   * `PhaseDispatchRequest` and returns a synthetic `PhaseInvocationResult`
   * without ever touching `Sandbox.spawnWorker`. The eval suite uses
   * this to swap in `AiSdkRuntime` against a LiteLLM proxy.
   */
  readonly dispatchPhase?: (request: PhaseDispatchRequest) => Promise<PhaseInvocationResult>;
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
   * Sandbox mode override — typically the CLI's `--sandbox` flag, or
   * `RunService` forcing `passthrough` for server modes. Beats the
   * config file's `sandbox:` field.
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

/**
 * Composition root. Wires the application-layer use cases to their
 * adapter implementations: `DefaultHarnessStateLoader` reads disk and
 * registers engines; a closure over the constructor's session-scoped
 * overrides serves as the `RunExecutionFactory`, delegating to
 * `DefaultRunExecution.prepare` for each run.
 *
 * Active runs are tracked by `runId` while in flight; `findSession`
 * lets multi-tenant transports (HTTP, MCP) look up the live handle for
 * out-of-band gate resolution and event subscription. Sessions are
 * evicted on completion — historical runs go through `RunStore`.
 */
export class Harness {
  private readonly loader: DefaultHarnessStateLoader;
  private readonly factory: RunExecutionFactory;
  private readonly startRun_: StartRunUseCase;
  private readonly previewRun_: PreviewRunUseCase;
  private readonly listRuns_: ListRunsUseCase;
  private readonly getRun_: GetRunUseCase;
  private readonly verifyAudit_: VerifyAuditUseCase;
  private readonly sessions = new Map<string, RunSession>();
  private readonly sandboxModeOverride: SandboxMode | undefined;
  private readonly workspaceResolver: WorkspaceResolver;

  constructor(opts: HarnessOptions) {
    const root = opts.root ?? defaultRoot();
    const engineName = opts.engine ?? "mastra";

    this.loader = new DefaultHarnessStateLoader({
      root,
      bundleName: opts.bundle,
      ...(opts.bundleDir ? { bundleDir: opts.bundleDir } : {}),
      engineName,
      engines: opts.engines,
    });
    this.sandboxModeOverride = opts.sandboxMode;
    this.factory = new RunExecutionFactory({
      dispatchPhaseOverride: opts.dispatchPhase,
      egressGatePrompter: opts.egressGatePrompter,
      sandboxModeOverride: opts.sandboxMode,
      // CLI `--script` wins; the in-bundle `script.yaml` convention is
      // applied by the factory if --script is absent.
      scriptPathOverride: opts.scriptPath,
    });
    const workspaceResolver = new WorkspaceResolver(this.loader);

    this.workspaceResolver = workspaceResolver;
    this.startRun_ = new StartRunUseCase(this.loader, this.factory, workspaceResolver);
    this.previewRun_ = new PreviewRunUseCase(this.loader, workspaceResolver);
    this.listRuns_ = new ListRunsUseCase(this.loader);
    this.getRun_ = new GetRunUseCase(this.loader);
    this.verifyAudit_ = new VerifyAuditUseCase(this.loader);
  }

  /**
   * Construct (and discard) the run-time infra so configuration errors
   * — missing env-var auth on `local_services`, malformed runtime
   * configs, unreadable egress-approval state — surface BEFORE the
   * caller does anything observable. The CLI calls this before mounting
   * the OpenTUI renderer so a crash here doesn't leave terminal-probe
   * responses leaking onto the user's next shell prompt.
   *
   * Pure validation: the broker isn't started, no sockets open, nothing
   * is entered. The constructed instance falls out of scope on return.
   */
  async preflight(): Promise<void> {
    const state = await this.loader.load();
    await this.factory.prepare({
      root: this.loader.root,
      bundleName: this.loader.bundleName,
      config: state.config,
      // `enter()` is the only consumer of workspaceRoot; we never call
      // it. The egress-approval store uses it as a project key but only
      // reads, so a sentinel here doesn't pollute on-disk state.
      workspaceRoot: "/",
      projectName: undefined,
      onEvent: undefined,
      bundleScriptPath: state.bundle.scriptPath,
    });
  }

  /**
   * Begin a run and return a live session once the engine has emitted
   * `run.started`. Resolves with `runId` synchronously available; the
   * eventual `RunMeta` arrives via `session.completion`. Out-of-band
   * gate resolution flows through `session.resolveGate(phaseId, ...)`
   * unless the caller passed an interactive `gateForKind` in `input`.
   */
  async prepareRun(input: StartRunInput): Promise<RunSession> {
    const session = new DefaultRunSession();
    const sessionEmit = session.onEvent(input.onEvent);
    // CLI passes its own gateForKind (interactive); HTTP/MCP omit and
    // the session's deferred prompter handles it.
    const gateForKind = input.gateForKind ?? session.gateResolver();

    let captureRunId!: (id: string) => void;
    let rejectRunStart!: (err: Error) => void;
    const runIdReady = new Promise<string>((res, rej) => {
      captureRunId = res;
      rejectRunStart = rej;
    });

    const onEvent = (event: RunEvent): void => {
      sessionEmit(event);
      if (event.type === "run.started") captureRunId(event.runId);
    };

    const completion = this.startRun_
      .execute({ ...input, onEvent, gateForKind })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        rejectRunStart(e);
        throw e;
      });

    const runId = await runIdReady;
    this.sessions.set(runId, session);
    session.bind(runId, completion);
    // Sessions remain in the map after completion so late MCP polls
    // can drain buffered events and observe `isClosed: true`. No
    // eviction yet — multi-tenant servers will need an explicit
    // dispose hook before this matters.
    return session;
  }

  /**
   * Convenience over `prepareRun`: start a run and await its full
   * completion. CLI uses this; out-of-band callers should `prepareRun`
   * and consume `session.events` / call `session.resolveGate(...)`.
   */
  async startRun(input: StartRunInput): Promise<RunMeta> {
    const session = await this.prepareRun(input);
    return session.completion;
  }

  findSession(runId: string): RunSession | undefined {
    return this.sessions.get(runId);
  }

  previewRun(input: StartRunInput): Promise<readonly PhasePreview[]> {
    return this.previewRun_.execute(input);
  }

  listRuns(): Promise<RunMeta[]> {
    return this.listRuns_.execute();
  }

  getRun(runId: string): Promise<RunMeta> {
    return this.getRun_.execute(runId);
  }

  /**
   * Walk the per-run audit chain (`<runStoreDir>/<runId>/audit.jsonl`)
   * and report tamper status. Returns the same VerifyResult shape the
   * pure verifier produces; the CLI layer renders it.
   */
  verifyAudit(runId: string): Promise<VerifyResult> {
    return this.verifyAudit_.execute(runId);
  }

  async workflowDefinition(): Promise<WorkflowManifest> {
    const state = await this.loader.load();
    return state.workflow;
  }

  resolveRunWorkspace(input: Pick<StartRunInput, "projectName" | "repoPath">): Promise<string> {
    return this.workspaceResolver.resolve(input);
  }

  /**
   * Configured sandbox mode (after applying the resolution order:
   * `sandboxMode` constructor override > config file). Used by the
   * doctor command for diagnostic reporting.
   */
  async sandboxMode(): Promise<SandboxMode> {
    if (this.sandboxModeOverride) return this.sandboxModeOverride;
    const state = await this.loader.load();
    return state.config.sandboxMode();
  }

  /** Paths ordin knows about — useful for the CLI `doctor` command. */
  paths(): HarnessPaths {
    return this.loader.paths();
  }

  /** Resolved bundle directory (search-path lookup; throws if not found). */
  bundleDir(): Promise<string> {
    return this.loader.bundleDir();
  }

  /**
   * Enumerate bundles reachable via the search path. Static facade for
   * `ordin bundle list` — does not depend on the configured bundle name
   * (callers may want to list before picking one).
   */
  static listBundles(): Promise<readonly { name: string; dir: string; source: string }[]> {
    return new BundleResolver().list();
  }

  /** Search-path entries the resolver walks, in precedence order. */
  static bundleSearchPath(): readonly string[] {
    return new BundleResolver().searchPath();
  }

  /**
   * Load a bundle by name and return manifest + workflow + per-component
   * hashes. Facade for `ordin bundle show`.
   */
  static async inspectBundle(name: string): Promise<BundleInspection> {
    const dir = await new BundleResolver().resolve(name);
    const loaded = await new BundleLoader().load(dir);
    return {
      dir,
      manifest: {
        name: loaded.manifest.name,
        version: loaded.manifest.version,
        description: loaded.manifest.description,
        runtime: loaded.manifest.runtime,
        model: loaded.manifest.model,
      },
      workflow: {
        name: loaded.workflow.name,
        phaseIds: loaded.workflow.phases.map((p) => p.id),
      },
      hash: loaded.hash,
    };
  }
}

export interface BundleInspection {
  readonly dir: string;
  readonly manifest: {
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly runtime?: string;
    readonly model?: string;
  };
  readonly workflow: {
    readonly name: string;
    readonly phaseIds: readonly string[];
  };
  readonly hash: BundleHash;
}

/**
 * `__ORDIN_COMPILED__` is replaced with the literal `true` at build
 * time by `scripts/package.ts` via Bun.build's `define` option. In dev
 * runs the identifier doesn't exist, so the `typeof` guard yields
 * `"undefined"` and the code branches to the dev walk-up. No filesystem
 * heuristic, no ambiguity at runtime.
 */
declare const __ORDIN_COMPILED__: boolean | undefined;

/**
 * Resolve the harness config root (where ordin.config.yaml + projects.yaml
 * live). Precedence:
 *
 *   1. $ORDIN_HOME env override — explicit user choice.
 *   2. Compiled binary → `~/.ordin/`. The dev walk-up via
 *      `import.meta.url` would resolve to the source repo on the build
 *      machine, which is meaningless on an installed user's system.
 *   3. Dev tree → walk up from the source file.
 *   4. Last-resort fallback → `~/.ordin/`.
 *
 * Bundles are resolved separately via the bundle search path.
 */
function defaultRoot(): string {
  const explicit = process.env["ORDIN_HOME"];
  if (explicit) return resolve(explicit);
  if (typeof __ORDIN_COMPILED__ !== "undefined" && __ORDIN_COMPILED__) {
    return join(homedir(), ".ordin");
  }
  const fromSource = devSourceRoot();
  if (fromSource) return fromSource;
  return join(homedir(), ".ordin");
}

function devSourceRoot(): string | undefined {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  } catch {
    return undefined;
  }
}
