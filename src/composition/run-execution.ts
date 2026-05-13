import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { Broker } from "../broker";
import { AuditService } from "../broker/audit-service";
import { InProcessBrokerClient } from "../broker/client/in-process";
import type { BrokerClient } from "../broker/client/types";
import { BrokerDispatch } from "../broker/dispatch";
import { makeToolServiceHandler } from "../broker/tool-service";
import type { HarnessConfig, SandboxMode } from "../domain/config";
import { shutdownTracing, startTracing } from "../observability/tracing";
import type { PhaseDispatchRequest } from "../orchestrator/engine";
import type { RunEvent } from "../orchestrator/events";
import type { PhaseInvocationResult } from "../orchestrator/phase-invocation";
import { selectSandbox } from "../sandbox";
import type { Sandbox } from "../sandbox/types";
import { workerArgv } from "../worker/locator";
import { type EgressApproval, EgressApprovalStore } from "./egress-store";
import {
  InProcessInvokeSource,
  PhaseDispatcher,
  type RuntimeContext,
  SandboxedInvokeSource,
  type WorkerInvokeSource,
} from "./phase-dispatcher";
import { resolveClaudeBin } from "./resolve-claude-bin";
import { buildWorkerEnv } from "./worker-policy";

/**
 * Per-run inputs threaded from `Harness` through the factory closure.
 * `T | undefined` (required, explicit-undefined-allowed) so the
 * composition root can do plain assignment without
 * `...(opts.X ? { X: opts.X } : {})` ceremony under
 * `exactOptionalPropertyTypes`.
 */
export interface RunExecutionPrepareOptions {
  readonly root: string;
  readonly bundleName: string;
  readonly config: HarnessConfig;
  readonly workspaceRoot: string;
  readonly projectName: string | undefined;
  readonly onEvent: ((event: RunEvent) => void) | undefined;
  /**
   * Absolute path to `<bundleDir>/script.yaml` if present. Transient
   * carrier consumed by the composition root's factory closure: it
   * resolves `cli --script ?? bundleScriptPath` into the single
   * `scriptPathOverride` that flows downstream.
   */
  readonly bundleScriptPath: string | undefined;
}

/**
 * Session-scoped overrides applied to every prepared `DefaultRunExecution`.
 * The composition root captures these once and merges them with
 * per-run `RunExecutionPrepareOptions` inside its factory closure.
 */
export interface RunExecutionOverrides {
  readonly dispatchPhaseOverride:
    | ((request: PhaseDispatchRequest) => Promise<PhaseInvocationResult>)
    | undefined;
  readonly egressGatePrompter:
    | ((req: { host: string; port: number | undefined }) => Promise<boolean>)
    | undefined;
  readonly sandboxModeOverride: SandboxMode | undefined;
  readonly scriptPathOverride: string | undefined;
}

// `bundleScriptPath` is consumed by the composition root's factory
// closure (merged with the CLI `--script` override into
// `scriptPathOverride`); `DefaultRunExecution` never sees it.
export type RunExecutionOptions = Omit<RunExecutionPrepareOptions, "bundleScriptPath"> &
  RunExecutionOverrides;

/**
 * Builds a `DefaultRunExecution` per run. Constructed once by `Harness`
 * with session-scoped overrides pre-bound; use cases call `prepare(opts)`
 * for each run. Owns the merge of session overrides + per-run options,
 * including resolving `cli --script` against the bundle's `script.yaml`.
 */
export class RunExecutionFactory {
  constructor(private readonly overrides: RunExecutionOverrides) {}

  prepare(opts: RunExecutionPrepareOptions): Promise<DefaultRunExecution> {
    const { bundleScriptPath, ...prepareOpts } = opts;
    return DefaultRunExecution.create({
      ...prepareOpts,
      ...this.overrides,
      scriptPathOverride: this.overrides.scriptPathOverride ?? bundleScriptPath,
    });
  }
}

/**
 * Per-run execution plumbing. Owns broker / audit / sandbox lifecycle
 * and constructs the `PhaseDispatcher` that drives each phase. Use
 * cases never `new` this class directly; the composition root's
 * factory closure calls `DefaultRunExecution.create`. Construction is
 * the only async seam — after `create()` returns, every accessor is
 * sync, infra is non-optional, and the resume-shaped variant of this
 * factory (Step 2.3+) is the single place that grows a checkpoint
 * branch.
 */
export class DefaultRunExecution {
  private tracingStarted = false;

  private constructor(
    private readonly opts: RunExecutionOptions,
    private readonly infra: RunInfra,
  ) {}

  /**
   * Build a fully-prepared `DefaultRunExecution`. Steps run in this
   * order because each depends on the previous:
   *
   *   1. Load the egress-approval store from disk.
   *   2. Construct audit → broker-dispatch → broker (audit sinks into
   *      dispatch; dispatch into broker).
   *   3. Select a sandbox bound to the broker.
   *
   * No state escapes between these steps — they're just sequenced.
   */
  static async create(opts: RunExecutionOptions): Promise<DefaultRunExecution> {
    const egress = await prepareEgressStore(opts);
    const infra = buildInfra(opts, egress);
    return new DefaultRunExecution(opts, infra);
  }

  get sandboxMode(): SandboxMode {
    return this.infra.mode;
  }

  onEvent(): (event: RunEvent) => void {
    const { audit } = this.infra;
    return (ev) => {
      audit.appendEvent({ runId: ev.runId, kind: ev.type, payload: ev }).catch((err: unknown) => {
        console.warn(
          `[harness] audit append failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };
  }

  dispatchPhase(): (req: PhaseDispatchRequest) => Promise<PhaseInvocationResult> {
    if (this.opts.dispatchPhaseOverride) return this.opts.dispatchPhaseOverride;

    const infra = this.infra;
    const ctx: RuntimeContext = {
      harnessRoot: this.opts.root,
      bundleName: this.opts.bundleName,
      runsDir: this.opts.config.runStoreDir(),
      scriptPath: this.opts.scriptPathOverride,
      runtimeConfigFor: (name) =>
        resolveRuntimeConfig(name, this.opts.config.runtimeConfig(name), infra.mode),
    };
    // Only `passthrough` runs in-process. `broker` and `srt` both
    // need subprocess isolation: the worker's env carries the broker's
    // proxy URL (`buildWorkerEnv`) which we don't want leaking into the
    // harness process for the rest of its lifetime.
    const source: WorkerInvokeSource =
      infra.mode === "passthrough"
        ? new InProcessInvokeSource(ctx, infra.brokerClient)
        : new SandboxedInvokeSource(infra.sandbox, ctx, buildWorkerEnv(infra, process.env));
    const dispatcher = new PhaseDispatcher(source, infra.brokerDispatch);
    return (req) => dispatcher.dispatch(req);
  }

  async enter(): Promise<void> {
    await this.infra.broker.start();
    this.tracingStarted = startParentTracing(this.infra);
    await this.infra.sandbox.enterIfNeeded({
      workspaceRoot: this.opts.workspaceRoot,
      runStoreDir: this.opts.config.runStoreDir(),
      harnessRoot: this.opts.root,
      workerArgv: workerArgv({ harnessRoot: this.opts.root }),
    });
  }

  async dispose(): Promise<void> {
    if (this.tracingStarted) await shutdownTracing();
    await this.infra.audit.closeAll();
    await this.infra.broker.stop();
    await this.infra.sandbox.shutdown();
  }
}

async function prepareEgressStore(opts: RunExecutionOptions): Promise<EgressBinding> {
  const ordinDir = dirname(opts.config.runStoreDir());
  const projectKey = EgressApprovalStore.projectKeyForWorkspace(
    opts.workspaceRoot,
    opts.projectName,
  );
  const store = new EgressApprovalStore({ ordinDir, projectKey });
  const preApprovedHosts = await store.load();
  const userPrompter = opts.egressGatePrompter;
  if (!userPrompter) return { preApprovedHosts };
  const prompter: NonNullable<RunExecutionOptions["egressGatePrompter"]> = async (req) => {
    const approved = await userPrompter(req);
    if (approved) {
      try {
        await store.add(req.host, req.port);
      } catch (err) {
        console.warn(
          `[harness] failed to persist egress approval for ${req.host}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return approved;
  };
  return { preApprovedHosts, prompter };
}

function buildInfra(opts: RunExecutionOptions, egress: EgressBinding): RunInfra {
  const mode = opts.sandboxModeOverride ?? opts.config.sandboxMode();
  const audit = new AuditService({
    runStoreDir: opts.config.runStoreDir(),
    onEvent: (ev) => {
      if (ev.kind.startsWith("broker.")) return;
      opts.onEvent?.(ev.payload as RunEvent);
    },
  });
  const services = opts.config.localServices();
  const brokerDispatch = new BrokerDispatch({
    audit: { append: (ev) => audit.appendEvent(ev) },
  });
  const proxyAuth = randomBytes(32).toString("hex");
  const broker = new Broker(services, {
    proxyAuth,
    onEgress: audit.egressSink(),
    internalServices: [
      { kind: "internal", name: "tools", handler: makeToolServiceHandler(brokerDispatch) },
    ],
    ...(egress.prompter ? { onEgressGate: egress.prompter } : {}),
    preApprovedHosts: egress.preApprovedHosts,
  });
  const brokerClient = new InProcessBrokerClient(brokerDispatch);
  return {
    mode,
    sandbox: selectSandbox(mode, { broker }),
    broker,
    brokerClient,
    brokerDispatch,
    audit,
    services,
  };
}

interface EgressBinding {
  readonly preApprovedHosts: readonly EgressApproval[];
  readonly prompter?: NonNullable<RunExecutionOptions["egressGatePrompter"]>;
}

interface RunInfra {
  readonly mode: SandboxMode;
  readonly sandbox: Sandbox;
  readonly broker: Broker;
  readonly brokerClient: BrokerClient;
  readonly brokerDispatch: BrokerDispatch;
  readonly audit: AuditService;
  readonly services: Readonly<Record<string, unknown>>;
}

function startParentTracing(infra: RunInfra): boolean {
  if (!Object.hasOwn(infra.services, "otel")) return false;
  return startTracing({ enabled: true, proxyUrl: infra.broker.proxyUrl() });
}

export function resolveRuntimeConfig(name: string, slice: unknown, mode: SandboxMode): unknown {
  const selected = selectSandboxProfile(slice, mode);
  if (name === "claude-cli-provider") {
    const cur = (selected ?? {}) as { bin?: string };
    return { ...cur, bin: resolveClaudeBin(cur.bin) };
  }
  return selected;
}

function selectSandboxProfile(slice: unknown, mode: SandboxMode): unknown {
  if (!isRecord(slice)) return slice;
  const { profiles, ...base } = slice;
  if (profiles === undefined) return base;
  if (!isRecord(profiles)) {
    throw new Error("Runtime config `profiles` must be an object keyed by sandbox mode.");
  }
  const profile = profiles[mode];
  if (profile === undefined) return base;
  if (!isRecord(profile)) {
    throw new Error(`Runtime config profile "${mode}" must be an object.`);
  }
  return { ...base, ...profile };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
