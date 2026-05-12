import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { RunExecution, RunExecutionPrepareOptions } from "../application/ports";
import { Broker } from "../broker";
import { AuditService } from "../broker/audit-service";
import { InProcessBrokerClient } from "../broker/client/in-process";
import type { BrokerClient } from "../broker/client/types";
import { BrokerDispatch } from "../broker/dispatch";
import { makeToolServiceHandler } from "../broker/tool-service";
import type { SandboxMode } from "../domain/config";
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
 * Session-scoped overrides applied to every prepared `RunExecution`.
 * The composition root captures these once and merges them with
 * per-run `RunExecutionPrepareOptions` inside its `RunExecutionFactory`
 * closure, so application use cases never see them.
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

export type RunExecutionOptions = RunExecutionPrepareOptions & RunExecutionOverrides;

/**
 * Per-run execution plumbing — the concrete adapter behind the
 * application-layer `RunExecution` port. Owns broker/audit/sandbox
 * lifecycle and constructs the `PhaseDispatcher` that drives each phase.
 * Use cases never `new` this class directly; the composition root's
 * `RunExecutionFactory` closure calls `DefaultRunExecution.prepare`.
 */
export class DefaultRunExecution implements RunExecution {
  private infra?: RunInfra;
  private tracingStarted = false;

  constructor(private readonly opts: RunExecutionOptions) {}

  /**
   * Build a prepared `DefaultRunExecution` in one step. Equivalent to
   * `new DefaultRunExecution(opts)` followed by `prepareInfra()`, but
   * gives the composition root a single call to invoke from its factory
   * closure.
   */
  static async prepare(opts: RunExecutionOptions): Promise<DefaultRunExecution> {
    const execution = new DefaultRunExecution(opts);
    await execution.prepareInfra();
    return execution;
  }

  async prepareInfra(): Promise<void> {
    const egress = await this.prepareEgressStore();
    this.infra = this.buildInfra(egress);
  }

  get sandboxMode(): SandboxMode | undefined {
    return this.requireInfra().mode;
  }

  onEvent(): (event: RunEvent) => void {
    const { audit } = this.requireInfra();
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

    const infra = this.requireInfra();
    const ctx: RuntimeContext = {
      harnessRoot: this.opts.root,
      bundleName: this.opts.bundleName,
      runsDir: this.opts.config.runStoreDir(),
      scriptPath: this.opts.scriptPathOverride,
      runtimeConfigFor: (name) => resolveRuntimeConfig(name, this.opts.config.runtimeConfig(name)),
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
    const infra = this.requireInfra();
    await infra.broker.start();
    this.tracingStarted = startParentTracing(infra);
    await infra.sandbox.enterIfNeeded({
      workspaceRoot: this.opts.workspaceRoot,
      runStoreDir: this.opts.config.runStoreDir(),
      harnessRoot: this.opts.root,
      workerArgv: workerArgv({ harnessRoot: this.opts.root }),
    });
  }

  async dispose(): Promise<void> {
    const infra = this.infra;
    if (!infra) return;
    if (this.tracingStarted) await shutdownTracing();
    await infra.audit.closeAll();
    await infra.broker.stop();
    await infra.sandbox.shutdown();
  }

  private requireInfra(): RunInfra {
    if (!this.infra) throw new Error("DefaultRunExecution used before prepareInfra()");
    return this.infra;
  }

  private async prepareEgressStore(): Promise<EgressBinding> {
    const ordinDir = dirname(this.opts.config.runStoreDir());
    const projectKey = EgressApprovalStore.projectKeyForWorkspace(
      this.opts.workspaceRoot,
      this.opts.projectName,
    );
    const store = new EgressApprovalStore({ ordinDir, projectKey });
    const preApprovedHosts = await store.load();
    const userPrompter = this.opts.egressGatePrompter;
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

  private buildInfra(egress: EgressBinding): RunInfra {
    const mode = this.opts.sandboxModeOverride ?? this.opts.config.sandboxMode();
    const audit = new AuditService({
      runStoreDir: this.opts.config.runStoreDir(),
      onEvent: (ev) => {
        if (ev.kind.startsWith("broker.")) return;
        this.opts.onEvent?.(ev.payload as RunEvent);
      },
    });
    const services = this.opts.config.localServices();
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

function resolveRuntimeConfig(name: string, slice: unknown): unknown {
  if (name === "claude-cli-provider") {
    const cur = (slice ?? {}) as { bin?: string };
    return { ...cur, bin: resolveClaudeBin(cur.bin) };
  }
  return slice;
}
