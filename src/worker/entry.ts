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
import type { PhasePreview } from "../domain/phase-preview";
import type { Phase } from "../domain/workflow";
import { buildMastraTracingContainer } from "./observability/mastra-tracing";
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
  const traceContext = parseTraceparent(process.env["TRACEPARENT"]);
  const runtime = await buildRuntime(plan.runtimeName, plan.runtimeConfig, {
    harnessRoot: plan.harnessRoot,
    workflowName: plan.workflowName,
    runsDir: plan.runsDir,
    ...(plan.scriptPath ? { scriptPath: plan.scriptPath } : {}),
    mastraTracing: buildMastraTracingContainer,
    ...(traceContext
      ? { parentTraceId: traceContext.traceId, parentSpanId: traceContext.spanId }
      : {}),
  });
  const result = await runtime.invoke({
    runId: plan.runId,
    runDir: plan.runDir,
    prompt: plan.preview.prompt,
    onEvent: emitRuntimeEvent,
  });
  await writeFile(plan.resultPath, JSON.stringify(result));
}

function emitRuntimeEvent(event: RuntimeEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function parsePlanPath(argv: readonly string[]): string {
  const ix = argv.indexOf("--plan");
  const path = ix >= 0 ? argv[ix + 1] : undefined;
  if (!path) throw new Error("worker: --plan <path> required");
  return path;
}

/**
 * Parse a W3C Trace Context header value (`00-<traceId>-<spanId>-<flags>`)
 * the parent stamps into the worker's env so Mastra spans nest under
 * the active `ordin.phase.*` span. Returns undefined for any malformed
 * or absent value — observability is supplementary, never load-bearing.
 */
function parseTraceparent(
  value: string | undefined,
): { traceId: string; spanId: string } | undefined {
  if (!value) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  return { traceId: match[1], spanId: match[2] };
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[worker] fatal: ${msg}\n`);
  process.exit(1);
});
