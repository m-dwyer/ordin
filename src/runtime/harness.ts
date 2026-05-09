import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessContext, type HarnessPaths } from "../application/harness-context";
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

export class HarnessRuntime {
  private readonly root: string;
  private readonly workflowName: string;
  private readonly context: HarnessContext;
  private readonly dispatchPhaseOverride?: (
    request: PhaseDispatchRequest,
  ) => Promise<PhaseRunResult>;
  private readonly gateResolver: (kind: Phase["gate"]) => Gate;
  private readonly egressGatePrompter?: (req: {
    host: string;
    port: number | undefined;
  }) => Promise<boolean>;
  private readonly sandboxOverride?: Sandbox;
  private readonly sandboxModeOverride?: SandboxMode;
  private readonly scriptPathOverride?: string;
  private readonly startRunUseCase: StartRunUseCase;
  private readonly previewRunUseCase: PreviewRunUseCase;
  private readonly listRunsUseCase: ListRunsUseCase;
  private readonly getRunUseCase: GetRunUseCase;
  private readonly verifyAuditUseCase: VerifyAuditUseCase;

  constructor(opts: HarnessRuntimeOptions = {}) {
    this.root = opts.root ?? defaultRoot();
    this.workflowName = opts.workflow ?? "software-delivery";
    if (opts.dispatchPhase) this.dispatchPhaseOverride = opts.dispatchPhase;
    this.gateResolver = opts.gateForKind ?? defaultGateResolver;
    if (opts.egressGatePrompter) this.egressGatePrompter = opts.egressGatePrompter;
    this.sandboxOverride = opts.sandbox;
    this.sandboxModeOverride = opts.sandboxMode;
    this.scriptPathOverride = opts.scriptPath;
    this.context = new HarnessContext({
      root: this.root,
      workflowName: this.workflowName,
      engineName: opts.engine ?? "mastra",
      ...(opts.engines ? { engines: opts.engines } : {}),
      ...(this.sandboxModeOverride ? { sandboxModeOverride: this.sandboxModeOverride } : {}),
    });
    this.startRunUseCase = new StartRunUseCase({
      root: this.root,
      workflowName: this.workflowName,
      context: this.context,
      gateResolver: this.gateResolver,
      ...(this.dispatchPhaseOverride ? { dispatchPhaseOverride: this.dispatchPhaseOverride } : {}),
      ...(this.egressGatePrompter ? { egressGatePrompter: this.egressGatePrompter } : {}),
      ...(this.sandboxOverride ? { sandboxOverride: this.sandboxOverride } : {}),
      ...(this.sandboxModeOverride ? { sandboxModeOverride: this.sandboxModeOverride } : {}),
      ...(this.scriptPathOverride ? { scriptPathOverride: this.scriptPathOverride } : {}),
    });
    this.previewRunUseCase = new PreviewRunUseCase(this.context);
    this.listRunsUseCase = new ListRunsUseCase(this.context);
    this.getRunUseCase = new GetRunUseCase(this.context);
    this.verifyAuditUseCase = new VerifyAuditUseCase(this.context);
  }

  async startRun(input: StartRunInput): Promise<RunMeta> {
    return this.startRunUseCase.execute(input);
  }

  /**
   * Compose the prompt for every phase without invoking any runtime.
   * Mirrors `startRun` shape (prepareRun → delegate) so dry-run
   * inherits all the same workflow slicing semantics (`onlyPhases`,
   * `startAt`, project resolution, slug validation).
   */
  async previewRun(input: StartRunInput): Promise<readonly PhasePreview[]> {
    return this.previewRunUseCase.execute(input);
  }

  async listRuns(): Promise<RunMeta[]> {
    return this.listRunsUseCase.execute();
  }

  async getRun(runId: string): Promise<RunMeta> {
    return this.getRunUseCase.execute(runId);
  }

  /**
   * Walk the per-run audit chain (`<runStoreDir>/<runId>/audit.jsonl`)
   * and report tamper status. Returns the same VerifyResult shape the
   * pure verifier produces; the CLI layer renders it.
   */
  async verifyAudit(runId: string): Promise<VerifyResult> {
    return this.verifyAuditUseCase.execute(runId);
  }

  async workflowDefinition(): Promise<WorkflowManifest> {
    return this.context.workflowDefinition();
  }

  async resolveRunWorkspace(
    input: Pick<StartRunInput, "projectName" | "repoPath">,
  ): Promise<string> {
    return this.context.resolveRunWorkspace(input);
  }

  /**
   * Configured sandbox mode (after applying the resolution order:
   * `sandboxMode` constructor override > config file). Used by the
   * doctor command for diagnostic reporting.
   */
  async sandboxMode(): Promise<SandboxMode> {
    return this.context.sandboxMode();
  }

  /** Paths ordin knows about — useful for the CLI `doctor` command. */
  paths(): HarnessPaths {
    return this.context.paths();
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
