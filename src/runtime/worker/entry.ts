#!/usr/bin/env bun
/**
 * Per-phase sandboxed worker. The parent (HarnessRuntime) writes a
 * plan JSON file, spawns this entrypoint via `Sandbox.spawnWorker`,
 * and reads `result.json` after the worker exits. One phase per
 * worker; worker exits when the phase invocation returns.
 *
 * Inside this process: load HarnessConfig from disk, instantiate the
 * one runtime named in the plan, run `PhaseRunner.run`, write the
 * result, exit. RunEvents emit through `AuditEmitter` (POST to the
 * broker via HTTP_PROXY); the parent's `AuditService.onEvent` hook
 * forwards them into the TUI.
 *
 * Trust: the plan file is parent-owned. We don't re-validate it — if
 * the parent wrote garbage, that's a harness bug, not a sandbox
 * compromise. The sandbox protects the rest of the world from this
 * process; it doesn't protect this process from the parent.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { PhasePreview } from "../../domain/phase-preview";
import type { Phase } from "../../domain/workflow";
import { HarnessConfigLoader } from "../../infrastructure/config-loader";
import { AuditEmitter } from "../../observability/audit-emitter";
import { startTracing } from "../../observability/tracing";
import { PhaseRunner } from "../../orchestrator/phase-runner";
import { buildRuntime } from "../../runtimes/registry";
import { prepareInnerProcess } from "../../sandbox";

interface WorkerPlan {
  readonly configFile: string;
  readonly harnessRoot: string;
  readonly workflowName: string;
  readonly scriptPath?: string;
  readonly runId: string;
  readonly runDir: string;
  readonly iteration: number;
  readonly phase: Phase;
  readonly preview: PhasePreview;
  readonly runtimeName: string;
  readonly resultPath: string;
}

async function main(): Promise<void> {
  prepareInnerProcess();
  startTracing();
  const planPath = parsePlanPath(process.argv);
  const plan: WorkerPlan = JSON.parse(await readFile(planPath, "utf8"));
  const config = await new HarnessConfigLoader().load(plan.configFile);
  const runtime = buildRuntime(plan.runtimeName, config, {
    harnessRoot: plan.harnessRoot,
    workflowName: plan.workflowName,
    ...(plan.scriptPath ? { scriptPath: plan.scriptPath } : {}),
  });
  const auditEmitter = new AuditEmitter();
  const result = await new PhaseRunner().run({
    preview: plan.preview,
    runtime,
    context: { runId: plan.runId, runDir: plan.runDir, iteration: plan.iteration },
    emit: (e) => auditEmitter.emit(e),
  });
  await writeFile(plan.resultPath, JSON.stringify(result));
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
