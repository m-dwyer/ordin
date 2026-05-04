import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const runtime = new ScriptedRuntime({ plan, runsDirFallback: scratch });

    const result = await runtime.invoke(
      makeRequest({ runDir: scratch, onEvent: (e) => events.push(e) }),
    );

    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(events).toEqual([
      { type: "assistant.text", text: "hello" },
      { type: "assistant.text", text: "world" },
    ]);
  });

  it("dispatches tool calls via the injected dispatcher", async () => {
    const dispatch = vi.fn().mockResolvedValue("tool-output");
    const dispatcher = { dispatch };
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
    const runtime = new ScriptedRuntime({
      plan,
      runsDirFallback: scratch,
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      dispatcher: dispatcher as any,
    });

    const events: RuntimeEvent[] = [];
    const result = await runtime.invoke(
      makeRequest({ runDir: scratch, onEvent: (e) => events.push(e) }),
    );

    expect(result.status).toBe("ok");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "Read",
      { file_path: "x.md" },
      expect.objectContaining({ cwd: "/tmp/test-cwd" }),
    );
    const toolUseEvents = events.filter((e) => e.type === "tool.use");
    expect(toolUseEvents).toHaveLength(2);
  });

  it("substitutes {cwd}, {workspace}, {run_id}, {phase} in text and tool inputs", async () => {
    const dispatch = vi.fn().mockResolvedValue("ok");
    const plan: ScriptedPlan = new Map([
      [
        "plan",
        {
          steps: [
            { text: "running in {cwd} as {phase}" },
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
    const events: RuntimeEvent[] = [];
    const runtime = new ScriptedRuntime({
      plan,
      runsDirFallback: scratch,
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      dispatcher: { dispatch } as any,
    });

    await runtime.invoke(makeRequest({ runDir: scratch, onEvent: (e) => events.push(e) }));

    const textEvent = events.find((e) => e.type === "assistant.text");
    expect(textEvent).toEqual({
      type: "assistant.text",
      text: "running in /tmp/test-cwd as plan",
    });
    expect(dispatch).toHaveBeenCalledWith(
      "Write",
      {
        file_path: "/tmp/test-cwd/log-test-run-1-plan.txt",
        content: "static",
      },
      expect.anything(),
    );
  });

  it("emits tool.result with ok=true on success", async () => {
    const dispatch = vi.fn().mockResolvedValue("hello world output");
    const plan: ScriptedPlan = new Map([
      ["plan", { steps: [{ tool: { name: "Bash", input: { command: "echo ok" } } }] }],
    ]);
    const events: RuntimeEvent[] = [];
    const runtime = new ScriptedRuntime({
      plan,
      runsDirFallback: scratch,
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      dispatcher: { dispatch } as any,
    });

    await runtime.invoke(makeRequest({ runDir: scratch, onEvent: (e) => events.push(e) }));

    const result = events.find((e) => e.type === "tool.result");
    expect(result).toMatchObject({ type: "tool.result", ok: true, result: "hello world output" });
  });

  it("emits tool.result with ok=false and returns failed status when dispatcher throws", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("boom"));
    const plan: ScriptedPlan = new Map([
      ["plan", { steps: [{ tool: { name: "Bash", input: { command: "fail" } } }] }],
    ]);
    const events: RuntimeEvent[] = [];
    const runtime = new ScriptedRuntime({
      plan,
      runsDirFallback: scratch,
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      dispatcher: { dispatch } as any,
    });

    const result = await runtime.invoke(
      makeRequest({ runDir: scratch, onEvent: (e) => events.push(e) }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure?.kind).toBe("tool");
    expect(result.failure?.message).toBe("boom");
    const failResult = events.find((e) => e.type === "tool.result");
    expect(failResult).toMatchObject({ type: "tool.result", ok: false, result: "boom" });
  });

  it("throws when no script exists for the requested phase", async () => {
    const plan: ScriptedPlan = new Map([["plan", { steps: [] }]]);
    const runtime = new ScriptedRuntime({ plan, runsDirFallback: scratch });

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
    const runtime = new ScriptedRuntime({ plan, runsDirFallback: scratch });

    const result = await runtime.invoke(makeRequest({ runDir: scratch }));

    expect(result.transcriptPath).toBe(join(scratch, "plan.jsonl"));
    const lines = readFileSync(result.transcriptPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ type: "assistant.text", text: "first" });
  });

  it("calls planLoader once and memoises the result", async () => {
    const plan: ScriptedPlan = new Map([["plan", { steps: [{ text: "ok" }] }]]);
    const planLoader = vi.fn().mockResolvedValue(plan);
    const runtime = new ScriptedRuntime({ planLoader, runsDirFallback: scratch });

    await runtime.invoke(makeRequest({ runDir: scratch }));
    await runtime.invoke(makeRequest({ runDir: scratch }));
    expect(planLoader).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when neither plan nor planLoader is provided", async () => {
    const runtime = new ScriptedRuntime({ runsDirFallback: scratch });
    await expect(runtime.invoke(makeRequest({ runDir: scratch }))).rejects.toThrow(
      /no plan and no planLoader/,
    );
  });
});
