import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { PhasePreview } from "../domain/phase-preview";
import type { Phase } from "../domain/workflow";
import type { PhaseDispatchRequest } from "../orchestrator/engine";
import type {
  Sandbox,
  SandboxParams,
  SandboxReadiness,
  WorkerHandle,
  WorkerPlan,
} from "../sandbox/types";
import type { InvokeResult, RuntimeEvent } from "../worker/runtimes/types";
import { prepareWorkerDispatch } from "./worker-dispatch";

describe("prepareWorkerDispatch", () => {
  it("writes a worker plan, spawns the worker, streams runtime events, and returns the result", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-worker-dispatch-"));
    const runDir = join(root, "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    const sandbox = new FakeSandbox({
      events: [{ type: "assistant.text", text: "hello from worker" }],
      result: invokeResult(),
    });
    const received: RuntimeEvent[] = [];
    const req = phaseDispatchRequest(root, runDir);

    const dispatch = await prepareWorkerDispatch(sandbox, req, workerConfig(root));
    const result = await dispatch.invoke({
      runId: "run-1",
      prompt: req.preview.prompt,
      runDir,
      onEvent: (ev) => received.push(ev),
    });

    expect(result).toEqual(invokeResult());
    expect(received).toEqual([{ type: "assistant.text", text: "hello from worker" }]);
    expect(sandbox.spawned).toHaveLength(1);
    expect(sandbox.spawned[0]?.argv.at(-2)).toBe("--plan");
    const planPath = sandbox.spawned[0]?.argv.at(-1);
    if (typeof planPath !== "string") throw new Error("expected --plan argv");
    expect(planPath).toBe(join(runDir, "worker-plan-1.plan.json"));
    expect(sandbox.spawned[0]?.env["BASE"]).toBe("1");

    const plan = JSON.parse(await readFile(planPath, "utf8")) as {
      harnessRoot: string;
      workflowName: string;
      runsDir: string;
      runId: string;
      runtimeName: string;
      runtimeConfig: unknown;
      resultPath: string;
    };
    expect(plan).toMatchObject({
      harnessRoot: root,
      workflowName: "software-delivery",
      runsDir: join(root, "runs"),
      runId: "run-1",
      runtimeName: "scripted",
      runtimeConfig: { name: "scripted" },
      resultPath: join(runDir, "worker-plan-1.result.json"),
    });
  });

  it("throws when the worker exits non-zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-worker-dispatch-"));
    const runDir = join(root, "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    const sandbox = new FakeSandbox({ exitCode: 17, result: invokeResult() });
    const req = phaseDispatchRequest(root, runDir);
    const dispatch = await prepareWorkerDispatch(sandbox, req, workerConfig(root));

    await expect(
      dispatch.invoke({ runId: "run-1", prompt: req.preview.prompt, runDir }),
    ).rejects.toThrow('worker for phase "plan" iteration 1 exited 17');
  });

  it("forwards aborts to the worker handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-worker-dispatch-"));
    const runDir = join(root, "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    const sandbox = new FakeSandbox({ result: invokeResult() });
    const req = phaseDispatchRequest(root, runDir);
    const dispatch = await prepareWorkerDispatch(sandbox, req, workerConfig(root));
    const controller = new AbortController();
    const promise = dispatch.invoke({
      runId: "run-1",
      prompt: req.preview.prompt,
      runDir,
      abortSignal: controller.signal,
    });

    controller.abort();
    await promise;

    expect(sandbox.kills).toEqual(["SIGTERM"]);
  });

  it("drops malformed runtime event lines with a warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-worker-dispatch-"));
    const runDir = join(root, "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    const sandbox = new FakeSandbox({
      rawLines: ["not-json", JSON.stringify({ type: "assistant.text", text: "kept" })],
      result: invokeResult(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const received: RuntimeEvent[] = [];
    const req = phaseDispatchRequest(root, runDir);
    const dispatch = await prepareWorkerDispatch(sandbox, req, workerConfig(root));

    await dispatch.invoke({
      runId: "run-1",
      prompt: req.preview.prompt,
      runDir,
      onEvent: (ev) => received.push(ev),
    });

    expect(received).toEqual([{ type: "assistant.text", text: "kept" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped malformed event line"));
    warn.mockRestore();
  });
});

class FakeSandbox implements Sandbox {
  readonly name = "fake";
  readonly spawned: WorkerPlan[] = [];
  readonly kills: string[] = [];

  constructor(
    private readonly opts: {
      readonly events?: readonly RuntimeEvent[];
      readonly rawLines?: readonly string[];
      readonly result?: InvokeResult;
      readonly exitCode?: number;
    } = {},
  ) {}

  async enterIfNeeded(_params: SandboxParams): Promise<void> {}

  spawnWorker(plan: WorkerPlan): WorkerHandle {
    this.spawned.push(plan);
    const stdout = new PassThrough();
    const exit = this.completeWorker(plan, stdout);
    return {
      exit,
      stdout,
      kill: (signal) => {
        this.kills.push(signal ?? "");
      },
    };
  }

  async shutdown(): Promise<void> {}

  async readiness(): Promise<SandboxReadiness> {
    return { ok: true, reasons: [] };
  }

  private async completeWorker(plan: WorkerPlan, stdout: PassThrough): Promise<number> {
    const planPath = plan.argv[plan.argv.indexOf("--plan") + 1];
    if (!planPath) throw new Error("fake worker expected --plan");
    const workerPlan = JSON.parse(await readFile(planPath, "utf8")) as { resultPath: string };
    for (const line of this.opts.rawLines ?? []) {
      stdout.write(`${line}\n`);
    }
    for (const ev of this.opts.events ?? []) {
      stdout.write(`${JSON.stringify(ev)}\n`);
    }
    stdout.end();
    if (this.opts.result) {
      await writeFile(workerPlan.resultPath, JSON.stringify(this.opts.result), "utf8");
    }
    return this.opts.exitCode ?? 0;
  }
}

function workerConfig(root: string) {
  return {
    harnessRoot: root,
    workflowName: "software-delivery",
    runsDir: join(root, "runs"),
    workerEnv: { BASE: "1" },
    runtimeConfigFor: (runtimeName: string) => ({ name: runtimeName }),
  };
}

function phaseDispatchRequest(root: string, runDir: string): PhaseDispatchRequest {
  const phase: Phase = {
    id: "plan",
    agent: "planner",
    gate: "auto",
    allowed_tools: [],
  };
  return {
    runId: "run-1",
    runDir,
    iteration: 1,
    phase,
    preview: phasePreview(root, phase),
    runtimeName: "scripted",
    emit: () => {},
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

function invokeResult(): InvokeResult {
  return {
    status: "ok",
    exitCode: 0,
    transcriptPath: "/tmp/worker-transcript.jsonl",
    tokens: { input: 1, output: 2, cacheReadInput: 0, cacheCreationInput: 0, totalInput: 1 },
    durationMs: 5,
  };
}
