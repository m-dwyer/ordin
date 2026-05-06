import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalResult,
  BrokerClient,
  RecordedResult,
  ToolIntent,
} from "../../../broker/client/types";
import type { ComposedPrompt } from "../../../domain/composer";
import type { InvokeRequest, RuntimeEvent } from "../types";
import { type ScriptedPlan, ScriptedRuntime } from "./index";

const PROMPT: ComposedPrompt = {
  systemPrompt: "you are a test agent",
  userPrompt: "do the thing",
  tools: ["Read", "Write", "Bash"],
  model: "stub",
  cwd: "/tmp/test-cwd",
  phaseId: "plan",
  tier: "M",
  freshContext: true,
  skills: [],
};

function makeRequest(opts: Partial<InvokeRequest> = {}): InvokeRequest {
  return {
    runId: "test-run-1",
    prompt: PROMPT,
    ...opts,
  };
}

interface FakeBroker extends BrokerClient {
  readonly approvalCalls: ToolIntent[];
  readonly resultCalls: Array<{ intent: ToolIntent; recorded: RecordedResult }>;
}

function fakeBroker(
  approve: (intent: ToolIntent) => ApprovalResult = () => ({ ok: true }),
): FakeBroker {
  const approvalCalls: ToolIntent[] = [];
  const resultCalls: Array<{ intent: ToolIntent; recorded: RecordedResult }> = [];
  const requestApproval = vi.fn(async (intent: ToolIntent): Promise<ApprovalResult> => {
    approvalCalls.push(intent);
    return approve(intent);
  });
  const recordResult = vi.fn(async (intent: ToolIntent, recorded: RecordedResult) => {
    resultCalls.push({ intent, recorded });
  });
  return {
    requestApproval: requestApproval as unknown as (intent: ToolIntent) => Promise<ApprovalResult>,
    recordResult: recordResult as unknown as (
      intent: ToolIntent,
      recorded: RecordedResult,
    ) => Promise<void>,
    approvalCalls,
    resultCalls,
  };
}

describe("ScriptedRuntime", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ordin-scripted-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("runs a simple text-only step deterministically", async () => {
    const events: RuntimeEvent[] = [];
    const plan: ScriptedPlan = new Map([
      ["plan", { steps: [{ text: "hello" }, { text: "world" }] }],
    ]);
    const runtime = new ScriptedRuntime({
      plan,
      runsDirFallback: scratch,
      broker: fakeBroker(),
    });

    const result = await runtime.invoke(
      makeRequest({ runDir: scratch, onEvent: (e) => events.push(e) }),
    );

    expect(result.status).toBe("ok");
    expect(events).toEqual([
      { type: "assistant.text", text: "hello" },
      { type: "assistant.text", text: "world" },
    ]);
  });

  it("requests approval for each tool, executes locally, records the outcome", async () => {
    // Real executors run, so set up the workspace.
    writeFileSync(join(scratch, "x.md"), "x content", "utf8");
    const broker = fakeBroker();
    const plan: ScriptedPlan = new Map([
      [
        "plan",
        {
          steps: [
            { tool: { name: "Read", input: { file_path: "x.md" } } },
            { tool: { name: "Write", input: { file_path: "y.md", content: "ok" } } },
          ],
        },
      ],
    ]);
    const runtime = new ScriptedRuntime({ plan, runsDirFallback: scratch, broker });

    const events: RuntimeEvent[] = [];
    const result = await runtime.invoke(
      makeRequest({
        runDir: scratch,
        prompt: { ...PROMPT, cwd: scratch },
        onEvent: (e) => events.push(e),
      }),
    );

    expect(result.status).toBe("ok");
    expect(broker.approvalCalls.map((c) => ({ tool: c.tool, input: c.input }))).toEqual([
      { tool: "Read", input: { file_path: "x.md" } },
      { tool: "Write", input: { file_path: "y.md", content: "ok" } },
    ]);
    expect(
      broker.resultCalls.map((c) => ({ tool: c.intent.tool, ok: c.recorded.result.ok })),
    ).toEqual([
      { tool: "Read", ok: true },
      { tool: "Write", ok: true },
    ]);
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(2);
  });

  it("substitutes {cwd}, {workspace}, {run_id}, {phase} in tool inputs before approval", async () => {
    const broker = fakeBroker();
    const plan: ScriptedPlan = new Map([
      [
        "plan",
        {
          steps: [
            {
              tool: {
                name: "Write",
                input: {
                  file_path: "{workspace}/log-{run_id}-{phase}.txt",
                  content: "static",
                },
              },
            },
          ],
        },
      ],
    ]);
    const runtime = new ScriptedRuntime({ plan, runsDirFallback: scratch, broker });

    await runtime.invoke(makeRequest({ runDir: scratch, prompt: { ...PROMPT, cwd: scratch } }));

    expect(broker.approvalCalls[0]?.input).toEqual({
      file_path: `${scratch}/log-test-run-1-plan.txt`,
      content: "static",
    });
  });

  it("emits tool.result with ok=true and records ok outcome on success", async () => {
    const broker = fakeBroker();
    const plan: ScriptedPlan = new Map([
      ["plan", { steps: [{ tool: { name: "Bash", input: { command: "echo ok" } } }] }],
    ]);
    const events: RuntimeEvent[] = [];
    const runtime = new ScriptedRuntime({ plan, runsDirFallback: scratch, broker });

    await runtime.invoke(
      makeRequest({
        runDir: scratch,
        prompt: { ...PROMPT, cwd: scratch },
        onEvent: (e) => events.push(e),
      }),
    );

    const result = events.find((e) => e.type === "tool.result");
    expect(result).toMatchObject({ type: "tool.result", ok: true });
    if (result?.type !== "tool.result") throw new Error("expected tool.result");
    expect(result.result).toContain("ok");
    expect(broker.resultCalls[0]?.recorded.result.ok).toBe(true);
  });

  it("emits tool.result with ok=false and records the deny when the broker rejects", async () => {
    const broker = fakeBroker(() => ({
      ok: false,
      error: { kind: "denied", message: "denied by ACL" },
    }));
    const plan: ScriptedPlan = new Map([
      ["plan", { steps: [{ tool: { name: "Bash", input: { command: "irrelevant" } } }] }],
    ]);
    const events: RuntimeEvent[] = [];
    const runtime = new ScriptedRuntime({ plan, runsDirFallback: scratch, broker });

    const result = await runtime.invoke(
      makeRequest({ runDir: scratch, onEvent: (e) => events.push(e) }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure?.kind).toBe("tool");
    expect(result.failure?.message).toBe("denied by ACL");
    const failEvent = events.find((e) => e.type === "tool.result");
    expect(failEvent).toMatchObject({ type: "tool.result", ok: false, result: "denied by ACL" });
    expect(broker.resultCalls[0]?.recorded.result.ok).toBe(false);
  });

  it("emits tool.result with ok=false and records executor failure when bash exits non-zero", async () => {
    const broker = fakeBroker();
    const plan: ScriptedPlan = new Map([
      ["plan", { steps: [{ tool: { name: "Bash", input: { command: "exit 7" } } }] }],
    ]);
    const events: RuntimeEvent[] = [];
    const runtime = new ScriptedRuntime({ plan, runsDirFallback: scratch, broker });

    const result = await runtime.invoke(
      makeRequest({
        runDir: scratch,
        prompt: { ...PROMPT, cwd: scratch },
        onEvent: (e) => events.push(e),
      }),
    );

    expect(result.status).toBe("failed");
    const recorded = broker.resultCalls[0]?.recorded.result;
    if (!recorded || recorded.ok) throw new Error("expected executor failure");
    expect(recorded.error.kind).toBe("executor");
  });

  it("throws when no script exists for the requested phase", async () => {
    const plan: ScriptedPlan = new Map([["plan", { steps: [] }]]);
    const runtime = new ScriptedRuntime({
      plan,
      runsDirFallback: scratch,
      broker: fakeBroker(),
    });

    await expect(
      runtime.invoke(
        makeRequest({
          runDir: scratch,
          prompt: { ...PROMPT, phaseId: "build" },
        }),
      ),
    ).rejects.toThrow(/no script for phase "build"/);
  });

  it("writes a JSONL transcript at the conventional path", async () => {
    const plan: ScriptedPlan = new Map([
      ["plan", { steps: [{ text: "first" }, { text: "second" }] }],
    ]);
    const runtime = new ScriptedRuntime({
      plan,
      runsDirFallback: scratch,
      broker: fakeBroker(),
    });

    const result = await runtime.invoke(makeRequest({ runDir: scratch }));

    expect(result.transcriptPath).toBe(join(scratch, "plan.jsonl"));
    const lines = readFileSync(result.transcriptPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ type: "assistant.text", text: "first" });
  });

  it("calls planLoader once and memoises the result", async () => {
    const plan: ScriptedPlan = new Map([["plan", { steps: [{ text: "ok" }] }]]);
    const planLoader = vi.fn().mockResolvedValue(plan);
    const runtime = new ScriptedRuntime({
      planLoader,
      runsDirFallback: scratch,
      broker: fakeBroker(),
    });

    await runtime.invoke(makeRequest({ runDir: scratch }));
    await runtime.invoke(makeRequest({ runDir: scratch }));
    expect(planLoader).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when neither plan nor planLoader is provided", async () => {
    const runtime = new ScriptedRuntime({
      runsDirFallback: scratch,
      broker: fakeBroker(),
    });
    await expect(runtime.invoke(makeRequest({ runDir: scratch }))).rejects.toThrow(
      /no plan and no planLoader/,
    );
  });
});
