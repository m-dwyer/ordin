import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPaths, RunExecutionFactory } from "../application/ports";
import { PreviewRunUseCase } from "../application/preview-run";
import { GetRunUseCase, ListRunsUseCase, VerifyAuditUseCase } from "../application/run-queries";
import { StartRunUseCase } from "../application/start-run";
import type { StartRunInput } from "../application/types";
import { WorkspaceResolver } from "../application/workspace-resolver";
import type { VerifyResult } from "../broker/audit-chain";
import type { PhasePreview } from "../domain/phase-preview";
import type { WorkflowManifest } from "../domain/workflow";
import type { Engine, PhaseDispatchRequest } from "../orchestrator/engine";
import type { RunEvent } from "../orchestrator/events";
import type { PhaseRunResult } from "../orchestrator/phase-runner";
import type { RunMeta } from "../orchestrator/run-store";
import type { SandboxMode } from "../sandbox";
import { DefaultHarnessStateLoader } from "./default-harness-state-loader";
import { DefaultRunExecution } from "./run-execution";
import { DefaultRunSession, type RunSession } from "./run-session";

export type { StartRunInput } from "../application/types";
export type { VerifyResult } from "../broker/audit-chain";
export type { SandboxMode } from "../domain/config";
export type { PhasePreview } from "../domain/phase-preview";
export type { Phase } from "../domain/workflow";
export type { Gate } from "../gates/types";
export type { RunEvent } from "../orchestrator/events";
export type { PhaseMeta, RunMeta } from "../orchestrator/run-store";
export type { PendingGate, RunSession } from "./run-session";

/**
 * Stable library surface. The CLI is the Stage 1 client; HTTP and MCP
 * adapters call through `RunService` which itself goes through this
 * runtime.
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
export class HarnessRuntime {
  private readonly loader: DefaultHarnessStateLoader;
  private readonly startRun_: StartRunUseCase;
  private readonly previewRun_: PreviewRunUseCase;
  private readonly listRuns_: ListRunsUseCase;
  private readonly getRun_: GetRunUseCase;
  private readonly verifyAudit_: VerifyAuditUseCase;
  private readonly sessions = new Map<string, RunSession>();
  private readonly sandboxModeOverride: SandboxMode | undefined;
  private readonly workspaceResolver: WorkspaceResolver;

  constructor(opts: HarnessRuntimeOptions = {}) {
    const root = opts.root ?? defaultRoot();
    const workflowName = opts.workflow ?? "software-delivery";
    const engineName = opts.engine ?? "mastra";

    this.loader = new DefaultHarnessStateLoader({
      root,
      workflowName,
      engineName,
      engines: opts.engines,
    });
    this.sandboxModeOverride = opts.sandboxMode;
    const factory: RunExecutionFactory = (prepareOpts) =>
      DefaultRunExecution.prepare({
        ...prepareOpts,
        dispatchPhaseOverride: opts.dispatchPhase,
        egressGatePrompter: opts.egressGatePrompter,
        sandboxModeOverride: opts.sandboxMode,
        scriptPathOverride: opts.scriptPath,
      });
    const workspaceResolver = new WorkspaceResolver(this.loader);

    this.workspaceResolver = workspaceResolver;
    this.startRun_ = new StartRunUseCase(this.loader, factory, workspaceResolver);
    this.previewRun_ = new PreviewRunUseCase(this.loader, workspaceResolver);
    this.listRuns_ = new ListRunsUseCase(this.loader);
    this.getRun_ = new GetRunUseCase(this.loader);
    this.verifyAudit_ = new VerifyAuditUseCase(this.loader);
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
}

function defaultRoot(): string {
  // Walk up from this file: src/runtime/harness.ts → src/runtime → src → root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
