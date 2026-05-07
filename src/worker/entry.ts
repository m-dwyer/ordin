#!/usr/bin/env bun
/**
 * Per-phase sandboxed worker. The parent (HarnessRuntime) writes a
 * plan JSON file, spawns this entrypoint via `Sandbox.spawnWorker`,
 * streams `RuntimeEvent`s from this process's stdout (one JSON object
 * per line), and reads `result.json` after the worker exits. One phase
 * per worker; worker exits when the phase invocation returns.
 *
 * Inside this process: instantiate the one runtime named in the plan
 * (using a parent-resolved config slice — no YAML parsing here),
 * call `runtime.invoke()`, write the result, exit.
 *
 * Phase lifecycle bookkeeping (`phase.started` / `phase.runtime.completed`
 * / `phase.failed`), runId/phaseId tagging, audit emission, and tracing
 * all live parent-side. The worker is "the runtime adapter and a tiny
 * stdio shim".
 *
 * Trust: the plan file is parent-owned. We don't re-validate it — if
 * the parent wrote garbage, that's a harness bug, not a sandbox
 * compromise. The sandbox protects the rest of the world from this
 * process; it doesn't protect this process from the parent.
 */
import { readFile, writeFile } from "node:fs/promises";
import { HttpBrokerClient } from "../broker/client/http";
import type { BrokerClient } from "../broker/client/types";
import type { PhasePreview } from "../domain/phase-preview";
import type { Phase } from "../domain/workflow";
import {
  shutdownWorkerTracing,
  startWorkerTracing,
  withWorkerContext,
} from "./observability/tracing";
import { prepareInnerProcess } from "./prepare";
import { buildRuntime } from "./runtimes/registry";
import type { RuntimeEvent } from "./runtimes/types";

interface WorkerPlan {
  readonly harnessRoot: string;
  readonly workflowName: string;
  readonly scriptPath?: string;
  readonly runsDir: string;
  readonly runId: string;
  readonly runDir: string;
  readonly iteration: number;
  readonly phase: Phase;
  readonly preview: PhasePreview;
  readonly runtimeName: string;
  readonly runtimeConfig: unknown;
  readonly resultPath: string;
}

async function main(): Promise<void> {
  prepareInnerProcess();
  const planPath = parsePlanPath(process.argv);
  const plan: WorkerPlan = JSON.parse(await readFile(planPath, "utf8"));
  startWorkerTracing();
  const broker = brokerClientFromEnv();
  const runtime = await buildRuntime(plan.runtimeName, plan.runtimeConfig, {
    harnessRoot: plan.harnessRoot,
    workflowName: plan.workflowName,
    runsDir: plan.runsDir,
    ...(plan.scriptPath ? { scriptPath: plan.scriptPath } : {}),
    ...(broker ? { broker } : {}),
  });
  try {
    const result = await withWorkerContext(() =>
      runtime.invoke({
        runId: plan.runId,
        runDir: plan.runDir,
        prompt: plan.preview.prompt,
        onEvent: emitRuntimeEvent,
      }),
    );
    await writeFile(plan.resultPath, JSON.stringify(result));
  } finally {
    await shutdownWorkerTracing();
  }
}

function emitRuntimeEvent(event: RuntimeEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Build an `HttpBrokerClient` from the proxy URL the parent (or srt)
 * stamped into `HTTP_PROXY`. The worker tunnels every tool dispatch
 * through the proxy via `HttpProxyAgent`; the broker (forward proxy)
 * routes by the `tools` virtual hostname. Returns undefined if no
 * proxy is configured — runtime construction in `registry.ts` then
 * errors loudly if a broker is required.
 */
function brokerClientFromEnv(): BrokerClient | undefined {
  const proxyUrl = process.env["HTTP_PROXY"];
  if (!proxyUrl) return undefined;
  return new HttpBrokerClient({ proxyUrl });
}

function parsePlanPath(argv: readonly string[]): string {
  const ix = argv.indexOf("--plan");
  const path = ix >= 0 ? argv[ix + 1] : undefined;
  if (!path) throw new Error("worker: --plan <path> required");
  return path;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[worker] fatal: ${msg}\n`);
  process.exit(1);
});
