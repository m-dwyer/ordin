import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { HarnessConfig } from "../domain/config";
import type { PhasePreview } from "../domain/phase-preview";
import type { Phase } from "../domain/workflow";
import type { PhaseDispatchRequest } from "../orchestrator/engine";
import type { RunEvent } from "../orchestrator/events";
import type { PhaseRunResult } from "../orchestrator/phase-runner";
import type { Sandbox, SandboxParams, SandboxReadiness } from "../sandbox";
import type { WorkerHandle, WorkerPlan } from "../sandbox/types";
import type { InvokeResult, RuntimeEvent } from "../worker/runtimes/types";
import { RunExecution } from "./run-execution";

describe("RunExecution", () => {
  it("owns sandbox lifecycle and direct event fan-out for sandbox overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-run-execution-"));
    const runStoreDir = join(root, "runs");
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot, { recursive: true });
    const sandbox = new FakeSandbox();
    const events: RunEvent[] = [];

    const execution = await RunExecution.prepare({
      root,
      workflowName: "software-delivery",
      config: config(runStoreDir),
      input: { onEvent: (ev) => events.push(ev) },
      workspaceRoot,
      sandboxOverride: sandbox,
    });

    expect(execution.sandboxMode).toBeUndefined();

    await execution.enter();
    execution.onEvent()({ type: "run.started", runId: "run-1" });
    await execution.dispose();

    expect(sandbox.calls).toEqual(["enter", "shutdown"]);
    expect(sandbox.enterParams?.workspaceRoot).toBe(workspaceRoot);
    expect(sandbox.enterParams?.runStoreDir).toBe(runStoreDir);
    expect(sandbox.enterParams?.harnessRoot).toBe(root);
    expect(events).toEqual([{ type: "run.started", runId: "run-1" }]);
  });

  it("returns the injected phase dispatcher unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-run-execution-"));
    const runStoreDir = join(root, "runs");
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot, { recursive: true });
    const expected = phaseRunResult();
    const override = async () => expected;

    const execution = await RunExecution.prepare({
      root,
      workflowName: "software-delivery",
      config: config(runStoreDir),
      input: {},
      workspaceRoot,
      sandboxOverride: new FakeSandbox(),
      dispatchPhaseOverride: override,
    });

    expect(execution.dispatchPhase()).toBe(override);
    await expect(execution.dispatchPhase()(phaseDispatchRequest(root))).resolves.toBe(expected);
  });

  it("dispatches a phase through a sandboxed worker plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-run-execution-"));
    const runStoreDir = join(root, "runs");
    const runDir = join(runStoreDir, "run-1");
    const workspaceRoot = join(root, "repo");
    await mkdir(runDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    const sandbox = new FakeSandbox({
      runtimeEvents: [{ type: "assistant.text", text: "worker said hi" }],
    });
    const emitted: RunEvent[] = [];

    const execution = await RunExecution.prepare({
      root,
      workflowName: "software-delivery",
      config: config(runStoreDir),
      input: {},
      workspaceRoot,
      sandboxOverride: sandbox,
    });

    const result = await execution.dispatchPhase()(
      phaseDispatchRequest(root, {
        runDir,
        emit: (ev) => emitted.push(ev),
      }),
    );

    expect(result.meta).toMatchObject({
      phaseId: "plan",
      iteration: 1,
      status: "running",
      runtime: "scripted",
      model: "m",
      exitCode: 0,
      transcriptPath: "/tmp/worker-transcript.jsonl",
    });
    expect(result.invokeResult.status).toBe("ok");
    expect(result.events).toEqual([{ type: "assistant.text", text: "worker said hi" }]);
    expect(emitted.map((ev) => ev.type)).toEqual([
      "phase.started",
      "agent.text",
      "phase.runtime.completed",
    ]);
    expect(sandbox.spawned).toHaveLength(1);
    const planPath = sandbox.spawned[0]?.argv.at(-1);
    expect(planPath).toContain("worker-plan-1.plan.json");
    if (!planPath) throw new Error("expected worker plan path");
    const plan = JSON.parse(await readFile(planPath, "utf8")) as { resultPath: string };
    expect(plan.resultPath).toContain("worker-plan-1.result.json");
  });
});

class FakeSandbox implements Sandbox {
  readonly name = "fake";
  readonly calls: string[] = [];
  readonly spawned: WorkerPlan[] = [];
  enterParams?: SandboxParams;

  constructor(private readonly opts: { runtimeEvents?: readonly RuntimeEvent[] } = {}) {}

  async enterIfNeeded(params: SandboxParams): Promise<void> {
    this.calls.push("enter");
    this.enterParams = params;
  }

  spawnWorker(plan: WorkerPlan): WorkerHandle {
    this.spawned.push(plan);
    const stdout = new PassThrough();
    const exit = this.completeWorker(plan, stdout);
    return {
      exit,
      stdout,
      kill: () => {
        this.calls.push("kill");
      },
    };
  }

  async shutdown(): Promise<void> {
    this.calls.push("shutdown");
  }

  async readiness(): Promise<SandboxReadiness> {
    return { ok: true, reasons: [] };
  }

  private async completeWorker(plan: WorkerPlan, stdout: PassThrough): Promise<number> {
    const planPath = plan.argv[plan.argv.indexOf("--plan") + 1];
    if (!planPath) throw new Error("fake worker expected --plan");
    const workerPlan = JSON.parse(await readFile(planPath, "utf8")) as { resultPath: string };
    for (const ev of this.opts.runtimeEvents ?? []) {
      stdout.write(`${JSON.stringify(ev)}\n`);
    }
    stdout.end();
    await writeFile(workerPlan.resultPath, JSON.stringify(invokeResult()), "utf8");
    return 0;
  }
}

function config(runStoreDir: string): HarnessConfig {
  return new HarnessConfig(
    { base_dir: runStoreDir },
    "scripted",
    "m",
    [],
    { mode: "passthrough", local_services: {} },
    {},
    { S: {}, M: {}, L: {} },
  );
}

function phaseDispatchRequest(
  root: string,
  opts: {
    readonly runDir?: string;
    readonly emit?: (event: RunEvent) => void;
  } = {},
): PhaseDispatchRequest {
  const phase: Phase = {
    id: "plan",
    agent: "planner",
    gate: "auto",
    allowed_tools: [],
  };
  return {
    runId: "run-1",
    runDir: opts.runDir ?? root,
    iteration: 1,
    phase,
    preview: phasePreview(root, phase),
    runtimeName: "scripted",
    emit: opts.emit ?? (() => {}),
  };
}

function phasePreview(root: string, phase: Phase): PhasePreview {
  return {
    phase,
    runtimeName: "scripted",
    prompt: {
      phaseId: phase.id,
      cwd: root,
      tier: "M",
      model: "m",
      freshContext: true,
      systemPrompt: "system",
      userPrompt: "user",
      tools: [],
      skills: [],
    },
  };
}

function phaseRunResult(): PhaseRunResult {
  return {
    meta: {
      phaseId: "plan",
      iteration: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "running",
    },
    invokeResult: invokeResult(),
    events: [],
  };
}

function invokeResult(): InvokeResult {
  return {
    status: "ok",
    exitCode: 0,
    transcriptPath: "/tmp/worker-transcript.jsonl",
    tokens: { input: 1, output: 2, cacheReadInput: 0, cacheCreationInput: 0, totalInput: 1 },
    durationMs: 5,
  };
}
