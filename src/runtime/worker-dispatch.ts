import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { context, trace } from "@opentelemetry/api";
import type { PhaseDispatchRequest } from "../orchestrator/engine";
import type { Sandbox } from "../sandbox/types";
import { workerArgv } from "../worker/locator";
import type { InvokeRequest, InvokeResult, RuntimeEvent } from "../worker/runtimes/types";

export interface WorkerDispatchConfig {
  readonly harnessRoot: string;
  readonly workflowName: string;
  readonly runsDir: string;
  readonly scriptPath?: string;
  readonly workerEnv: NodeJS.ProcessEnv;
  readonly runtimeConfigFor: (runtimeName: string) => unknown;
}

export interface PreparedWorkerDispatch {
  readonly planPath: string;
  readonly resultPath: string;
  readonly invoke: (invokeReq: InvokeRequest) => Promise<InvokeResult>;
}

export async function prepareWorkerDispatch(
  sandbox: Sandbox,
  req: PhaseDispatchRequest,
  config: WorkerDispatchConfig,
): Promise<PreparedWorkerDispatch> {
  const planPath = join(req.runDir, `worker-${req.phase.id}-${req.iteration}.plan.json`);
  const resultPath = join(req.runDir, `worker-${req.phase.id}-${req.iteration}.result.json`);
  const plan = {
    harnessRoot: config.harnessRoot,
    workflowName: config.workflowName,
    ...(config.scriptPath ? { scriptPath: config.scriptPath } : {}),
    runsDir: config.runsDir,
    runId: req.runId,
    runDir: req.runDir,
    iteration: req.iteration,
    phase: req.phase,
    preview: req.preview,
    runtimeName: req.runtimeName,
    runtimeConfig: config.runtimeConfigFor(req.runtimeName),
    resultPath,
  };
  await writeFile(planPath, JSON.stringify(plan));
  return {
    planPath,
    resultPath,
    invoke: (invokeReq) =>
      spawnWorkerInvoke({
        sandbox,
        harnessRoot: config.harnessRoot,
        workerEnv: config.workerEnv,
        planPath,
        resultPath,
        phaseId: req.phase.id,
        iteration: req.iteration,
        invokeReq,
      }),
  };
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
