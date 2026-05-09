import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPaths } from "../application/ports";
import { PreviewRunUseCase } from "../application/preview-run";
import { GetRunUseCase, ListRunsUseCase, VerifyAuditUseCase } from "../application/run-queries";
import { StartRunUseCase } from "../application/start-run";
import type { StartRunInput } from "../application/types";
import type { VerifyResult } from "../broker/audit-chain";
import type { PhasePreview } from "../domain/phase-preview";
import type { Phase, WorkflowManifest } from "../domain/workflow";
import { AutoGate } from "../gates/auto";
import type { Gate } from "../gates/types";
import type { Engine, PhaseDispatchRequest } from "../orchestrator/engine";
import type { PhaseRunResult } from "../orchestrator/phase-runner";
import type { RunMeta } from "../orchestrator/run-store";
import type { SandboxMode } from "../sandbox";
import type { Sandbox } from "../sandbox/types";
import { DefaultHarnessStateLoader } from "./default-harness-state-loader";
import { DefaultRunExecutionFactory } from "./default-run-execution-factory";

export type { StartRunInput } from "../application/types";
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

/**
 * Composition root. Wires the application-layer use cases to their
 * adapter implementations: `DefaultHarnessStateLoader` reads disk and
 * registers engines; `DefaultRunExecutionFactory` constructs broker /
 * sandbox / dispatcher per run. The use cases never reach into either.
 */
export class HarnessRuntime {
  private readonly loader: DefaultHarnessStateLoader;
  private readonly startRun_: StartRunUseCase;
  private readonly previewRun_: PreviewRunUseCase;
  private readonly listRuns_: ListRunsUseCase;
  private readonly getRun_: GetRunUseCase;
  private readonly verifyAudit_: VerifyAuditUseCase;

  constructor(opts: HarnessRuntimeOptions = {}) {
    const root = opts.root ?? defaultRoot();
    const workflowName = opts.workflow ?? "software-delivery";
    const engineName = opts.engine ?? "mastra";
    const gateResolver = opts.gateForKind ?? defaultGateResolver;

    this.loader = new DefaultHarnessStateLoader({
      root,
      workflowName,
      engineName,
      engines: opts.engines,
      sandboxModeOverride: opts.sandboxMode,
    });
    const factory = new DefaultRunExecutionFactory({
      dispatchPhaseOverride: opts.dispatchPhase,
      egressGatePrompter: opts.egressGatePrompter,
      sandboxOverride: opts.sandbox,
      sandboxModeOverride: opts.sandboxMode,
      scriptPathOverride: opts.scriptPath,
    });

    this.startRun_ = new StartRunUseCase(this.loader, factory, gateResolver, root, workflowName);
    this.previewRun_ = new PreviewRunUseCase(this.loader);
    this.listRuns_ = new ListRunsUseCase(this.loader);
    this.getRun_ = new GetRunUseCase(this.loader);
    this.verifyAudit_ = new VerifyAuditUseCase(this.loader);
  }

  startRun(input: StartRunInput): Promise<RunMeta> {
    return this.startRun_.execute(input);
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
    return this.loader.resolveWorkspace(input);
  }

  /**
   * Configured sandbox mode (after applying the resolution order:
   * `sandboxMode` constructor override > config file). Used by the
   * doctor command for diagnostic reporting.
   */
  sandboxMode(): Promise<SandboxMode> {
    return this.loader.sandboxMode();
  }

  /** Paths ordin knows about — useful for the CLI `doctor` command. */
  paths(): HarnessPaths {
    return this.loader.paths();
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

function defaultRoot(): string {
  // Walk up from this file: src/runtime/harness.ts → src/runtime → src → root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
