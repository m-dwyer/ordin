import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { RunExecution } from "../application/ports";
import { Broker } from "../broker";
import { AuditService } from "../broker/audit-service";
import { InProcessBrokerClient } from "../broker/client/in-process";
import { deriveToolPolicy } from "../broker/client/tool-authority";
import type { BrokerClient } from "../broker/client/types";
import { BrokerDispatch } from "../broker/dispatch";
import { makeToolServiceHandler } from "../broker/tool-service";
import type { HarnessConfig, SandboxMode } from "../domain/config";
import { shutdownTracing, startTracing } from "../observability/tracing";
import type { PhaseDispatchRequest } from "../orchestrator/engine";
import type { RunEvent } from "../orchestrator/events";
import { PhaseRunner, type PhaseRunResult } from "../orchestrator/phase-runner";
import { selectSandbox } from "../sandbox";
import type { Sandbox } from "../sandbox/types";
import { buildRuntime } from "../worker/runtimes/registry";
import { type EgressApproval, EgressApprovalStore } from "./egress-store";
import { resolveClaudeBin } from "./resolve-claude-bin";
import { prepareWorkerDispatch } from "./worker-dispatch";
import { buildWorkerEnv, workerReadRoots } from "./worker-policy";

export interface RunExecutionOptions {
  readonly root: string;
  readonly workflowName: string;
  readonly config: HarnessConfig;
  readonly workspaceRoot: string;
  readonly projectName: string | undefined;
  readonly onEvent: ((event: RunEvent) => void) | undefined;
  readonly dispatchPhaseOverride:
    | ((request: PhaseDispatchRequest) => Promise<PhaseRunResult>)
    | undefined;
  readonly egressGatePrompter:
    | ((req: { host: string; port: number | undefined }) => Promise<boolean>)
    | undefined;
  readonly sandboxOverride: Sandbox | undefined;
  readonly sandboxModeOverride: SandboxMode | undefined;
  readonly scriptPathOverride: string | undefined;
}

/**
 * Per-run execution plumbing — the concrete adapter behind the
 * application-layer `RunExecution` port. Owns broker/audit/sandbox
 * lifecycle and the phase dispatcher that closes over that
 * infrastructure. Constructed via `DefaultRunExecutionFactory.prepare`;
 * use cases never `new` this class directly.
 */
export class DefaultRunExecution implements RunExecution {
  private infra?: RunInfra;
  private tracingStarted = false;

  constructor(private readonly opts: RunExecutionOptions) {}

  async prepareInfra(): Promise<void> {
    const egress = await this.prepareEgressStore();
    this.infra = this.buildInfra(egress);
  }

  get sandboxMode(): SandboxMode | undefined {
    const infra = this.requireInfra();
    return infra.kind === "managed" ? infra.mode : undefined;
  }

  onEvent(): (event: RunEvent) => void {
    const infra = this.requireInfra();
    if (infra.kind === "managed") {
      const audit = infra.audit;
      return (ev) => {
        audit.appendEvent({ runId: ev.runId, kind: ev.type, payload: ev }).catch((err: unknown) => {
          console.warn(
            `[harness] audit append failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      };
    }
    return (ev) => this.opts.onEvent?.(ev);
  }

  dispatchPhase(): (req: PhaseDispatchRequest) => Promise<PhaseRunResult> {
    if (this.opts.dispatchPhaseOverride) return this.opts.dispatchPhaseOverride;

    const infra = this.requireInfra();
    const harnessRoot = this.opts.root;
    const workflowName = this.opts.workflowName;
    const scriptPath = this.opts.scriptPathOverride;
    const config = this.opts.config;

    // Only `passthrough` runs in-process. `claude-self` and `srt` both
    // need subprocess isolation: the worker's env carries the broker's
    // proxy URL (`buildWorkerEnv`) which we don't want leaking into the
    // harness process for the rest of its lifetime.
    const inProcess = infra.kind === "managed" && infra.mode === "passthrough";
    const brokerDispatch = infra.kind === "managed" ? infra.brokerDispatch : undefined;
    if (inProcess) {
      const brokerClient = infra.kind === "managed" ? infra.brokerClient : undefined;
      return async (req) => {
        const runtimeConfig = resolveRuntimeConfig(
          req.runtimeName,
          config.runtimeConfig(req.runtimeName),
        );
        return runWithPhaseAcl(brokerDispatch, req, () =>
          new PhaseRunner().run({
            preview: req.preview,
            runtimeName: req.runtimeName,
            context: { runId: req.runId, runDir: req.runDir, iteration: req.iteration },
            emit: req.emit,
            invoke: async (invokeReq) => {
              const runtime = await buildRuntime(req.runtimeName, runtimeConfig, {
                harnessRoot,
                workflowName,
                runsDir: config.runStoreDir(),
                ...(scriptPath ? { scriptPath } : {}),
                ...(brokerClient ? { broker: brokerClient } : {}),
              });
              return runtime.invoke(invokeReq);
            },
            ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
          }),
        );
      };
    }

    const sandbox = infra.sandbox;
    const workerEnv = buildWorkerEnv(infra, process.env);
    return async (req) => {
      const worker = await prepareWorkerDispatch(sandbox, req, {
        harnessRoot,
        workflowName,
        ...(scriptPath ? { scriptPath } : {}),
        runsDir: config.runStoreDir(),
        workerEnv,
        runtimeConfigFor: (runtimeName) =>
          resolveRuntimeConfig(runtimeName, config.runtimeConfig(runtimeName)),
      });
      return runWithPhaseAcl(brokerDispatch, req, () =>
        new PhaseRunner().run({
          preview: req.preview,
          runtimeName: req.runtimeName,
          context: { runId: req.runId, runDir: req.runDir, iteration: req.iteration },
          emit: req.emit,
          invoke: worker.invoke,
          ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
        }),
      );
    };
  }

  async enter(): Promise<void> {
    const infra = this.requireInfra();
    if (infra.kind === "managed") {
      await infra.broker.start();
      this.tracingStarted = startParentTracing(infra);
    }
    await infra.sandbox.enterIfNeeded({
      workspaceRoot: this.opts.workspaceRoot,
      runStoreDir: this.opts.config.runStoreDir(),
      harnessRoot: this.opts.root,
      workerReadRoots: workerReadRoots(this.opts.root),
    });
  }

  async dispose(): Promise<void> {
    const infra = this.infra;
    if (!infra) return;
    if (infra.kind === "managed") {
      if (this.tracingStarted) await shutdownTracing();
      await infra.audit.closeAll();
      await infra.broker.stop();
    }
    await infra.sandbox.shutdown();
  }

  private requireInfra(): RunInfra {
    if (!this.infra) throw new Error("DefaultRunExecution used before prepareInfra()");
    return this.infra;
  }

  private async prepareEgressStore(): Promise<EgressBinding> {
    if (this.opts.sandboxOverride) return { preApprovedHosts: [] };
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
    if (this.opts.sandboxOverride) {
      return { kind: "override", sandbox: this.opts.sandboxOverride };
    }
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
      kind: "managed",
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

type RunInfra =
  | { readonly kind: "override"; readonly sandbox: Sandbox }
  | {
      readonly kind: "managed";
      readonly mode: SandboxMode;
      readonly sandbox: Sandbox;
      readonly broker: Broker;
      readonly brokerClient: BrokerClient;
      readonly brokerDispatch: BrokerDispatch;
      readonly audit: AuditService;
      readonly services: Readonly<Record<string, unknown>>;
    };

async function runWithPhaseAcl<T>(
  brokerDispatch: BrokerDispatch | undefined,
  req: PhaseDispatchRequest,
  body: () => Promise<T>,
): Promise<T> {
  if (!brokerDispatch) return body();
  const { runId, preview } = req;
  const { phaseId } = preview.prompt;
  const policy = deriveToolPolicy({
    allowedTools: preview.prompt.tools,
    hasSkills: preview.prompt.skills.length > 0,
  });
  brokerDispatch.registerPhase(runId, phaseId, policy);
  try {
    return await body();
  } finally {
    brokerDispatch.releasePhase(runId, phaseId);
  }
}

function startParentTracing(infra: RunInfra): boolean {
  if (infra.kind !== "managed") return false;
  if (!Object.hasOwn(infra.services, "otel")) return false;
  return startTracing({ enabled: true, proxyUrl: infra.broker.proxyUrl() });
}

function resolveRuntimeConfig(name: string, slice: unknown): unknown {
  if (name === "claude-cli" || name === "claude-cli-provider") {
    const cur = (slice ?? {}) as { bin?: string };
    return { ...cur, bin: resolveClaudeBin(cur.bin) };
  }
  return slice;
}
