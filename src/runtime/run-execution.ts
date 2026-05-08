import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { context, trace } from "@opentelemetry/api";
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
import { workerArgv } from "../worker/locator";
import { buildRuntime } from "../worker/runtimes/registry";
import type { InvokeRequest, InvokeResult, RuntimeEvent } from "../worker/runtimes/types";
import { type EgressApproval, EgressApprovalStore } from "./egress-store";
import { resolveClaudeBin } from "./resolve-claude-bin";
import { buildWorkerEnv, workerReadRoots } from "./worker-policy";

export interface RunExecutionOptions {
  readonly root: string;
  readonly workflowName: string;
  readonly config: HarnessConfig;
  readonly input: {
    readonly projectName?: string;
    readonly onEvent?: (event: RunEvent) => void;
  };
  readonly workspaceRoot: string;
  readonly dispatchPhaseOverride?: (request: PhaseDispatchRequest) => Promise<PhaseRunResult>;
  readonly egressGatePrompter?: (req: {
    host: string;
    port: number | undefined;
  }) => Promise<boolean>;
  readonly sandboxOverride?: Sandbox;
  readonly sandboxModeOverride?: SandboxMode;
  readonly scriptPathOverride?: string;
}

/**
 * Per-run execution plumbing behind `HarnessRuntime`'s public interface.
 * Owns broker/audit/sandbox lifecycle and the phase dispatcher that
 * closes over that infrastructure.
 */
export class RunExecution {
  private infra?: RunInfra;
  private tracingStarted = false;

  private constructor(private readonly opts: RunExecutionOptions) {}

  static async prepare(opts: RunExecutionOptions): Promise<RunExecution> {
    const execution = new RunExecution(opts);
    const egress = await execution.prepareEgressStore();
    execution.infra = execution.buildInfra(egress);
    return execution;
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
          console.warn(`[harness] audit append failed: ${errMessage(err)}`);
        });
      };
    }
    return (ev) => this.opts.input.onEvent?.(ev);
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
      return runWithPhaseAcl(brokerDispatch, req, () =>
        new PhaseRunner().run({
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
    if (!this.infra) throw new Error("RunExecution used before prepare()");
    return this.infra;
  }

  private async prepareEgressStore(): Promise<EgressBinding> {
    if (this.opts.sandboxOverride) return { preApprovedHosts: [] };
    const ordinDir = dirname(this.opts.config.runStoreDir());
    const projectKey = EgressApprovalStore.projectKeyForWorkspace(
      this.opts.workspaceRoot,
      this.opts.input.projectName,
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
            `[harness] failed to persist egress approval for ${req.host}: ${errMessage(err)}`,
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
        this.opts.input.onEvent?.(ev.payload as RunEvent);
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
  brokerDispatch.registerPhase(runId, phaseId, policy.toolNames);
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

async function spawnWorkerInvoke(args: SpawnWorkerInvokeArgs): Promise<InvokeResult> {
  const { sandbox, harnessRoot, workerEnv, planPath, resultPath, phaseId, iteration, invokeReq } =
    args;
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

function serializeActiveTraceparent(): string | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const sc = span.spanContext();
  if (!sc.traceId || !sc.spanId) return undefined;
  const flags = (sc.traceFlags ?? 0).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
