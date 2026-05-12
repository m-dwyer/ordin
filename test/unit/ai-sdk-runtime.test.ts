import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerDispatch } from "../../src/broker/dispatch";
import type { ComposedPrompt } from "../../src/domain/composer";
import { AiSdkRuntime } from "../../src/worker/runtimes/ai-sdk";
import type { InvokeRequest, RuntimeEvent } from "../../src/worker/runtimes/types";

/**
 * Builds a BrokerDispatch pre-registered for `(runId="run-1",
 * phaseId="plan")` against the supplied tool list. Mirrors what the
 * harness does parent-side around each phase invoke.
 */
function noopBroker(allowedTools: readonly string[] = []): BrokerDispatch {
  const broker = new BrokerDispatch({ audit: { append: () => {} } });
  broker.registerPhase("run-1", "plan", allowedTools);
  return broker;
}

/**
 * Phase A parity check for the Mastra-Agent migration. Mastra owns the
 * tool loop now; the runtime's job is mapping per-step Mastra
 * callbacks to `RuntimeEvent`s. These two scenarios pin the contract
 * the integration suite relied on under `generateText({...})`:
 *   1. text-only step → exactly one `assistant.text` (not one per delta)
 *      plus one `tokens` event.
 *   2. tool-call → next step → ordered
 *      `assistant.text, tool.use, tool.result, tokens` then
 *      `assistant.text, tokens`.
 */

function streamOf(parts: LanguageModelV3StreamPart[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

const FINISH_STOP = {
  type: "finish",
  usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  finishReason: "stop",
} as unknown as LanguageModelV3StreamPart;
const FINISH_TOOL_CALLS = {
  type: "finish",
  usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  finishReason: "tool-calls",
} as unknown as LanguageModelV3StreamPart;
const FINISH_STOP_2 = {
  type: "finish",
  usage: { inputTokens: 30, outputTokens: 3, totalTokens: 33 },
  finishReason: "stop",
} as unknown as LanguageModelV3StreamPart;

function makePrompt(overrides: Partial<ComposedPrompt> = {}): ComposedPrompt {
  return {
    systemPrompt: "you are a test agent",
    userPrompt: "do the thing",
    tools: [],
    model: "test-model",
    cwd: overrides.cwd ?? mkdtempSync(join(tmpdir(), "ordin-aisdk-")),
    phaseId: "plan",
    tier: "M",
    freshContext: true,
    skills: [],
    ...overrides,
  };
}

function makeRequest(prompt: ComposedPrompt = makePrompt()): {
  request: InvokeRequest;
  events: RuntimeEvent[];
} {
  const events: RuntimeEvent[] = [];
  const request: InvokeRequest = {
    runId: "run-1",
    prompt,
    runDir: mkdtempSync(join(tmpdir(), "ordin-aisdk-run-")),
    onEvent: (e) => events.push(e),
  };
  return { request, events };
}

describe("AiSdkRuntime.fromConfig", () => {
  afterEach(() => {
    delete process.env["ORDIN_TEST_LITELLM_KEY"];
  });

  it("accepts local OpenAI-compatible provider config", () => {
    process.env["ORDIN_TEST_LITELLM_KEY"] = "test-key";
    const runtime = AiSdkRuntime.fromConfig(
      {
        base_url: "http://localhost:4000",
        api_key_env: "ORDIN_TEST_LITELLM_KEY",
        max_steps: 12,
        bypass_cache: true,
      },
      { broker: noopBroker() },
    );
    expect(runtime.name).toBe("ai-sdk");
  });

  it("rejects invalid config shapes", () => {
    expect(() =>
      AiSdkRuntime.fromConfig({ base_url: "not-a-url" }, { broker: noopBroker() }),
    ).toThrow();
    expect(() => AiSdkRuntime.fromConfig({ max_steps: 0 }, { broker: noopBroker() })).toThrow();
  });
});

describe("AiSdkRuntime.invoke event mapping", () => {
  it("collapses text-deltas into one assistant.text per step", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hello " },
          { type: "text-delta", id: "t1", delta: "world." },
          { type: "text-end", id: "t1" },
          FINISH_STOP,
        ]),
      }),
    });

    const runtime = new AiSdkRuntime({ model, broker: noopBroker() });
    const { request, events } = makeRequest();
    const result = await runtime.invoke(request);

    expect(result.status).toBe("ok");
    expect(events.map((e) => e.type)).toEqual(["assistant.text", "tokens"]);
    expect(events[0]).toEqual({ type: "assistant.text", text: "Hello world." });
    expect(events[1]).toEqual({
      type: "tokens",
      usage: { input: 11, output: 7, cacheReadInput: 0, cacheCreationInput: 0, totalInput: 11 },
    });
  });

  it("emits assistant.text, tool.use, tool.result, tokens in order across a tool loop", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ordin-aisdk-bash-"));
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++;
        if (call === 1) {
          return {
            stream: streamOf([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "running echo" },
              { type: "text-end", id: "t1" },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "Bash",
                input: JSON.stringify({ command: "echo hi" }),
              },
              FINISH_TOOL_CALLS,
            ]),
          };
        }
        return {
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t2" },
            { type: "text-delta", id: "t2", delta: "done" },
            { type: "text-end", id: "t2" },
            FINISH_STOP_2,
          ]),
        };
      },
    });

    const runtime = new AiSdkRuntime({ model, broker: noopBroker(["Bash"]) });
    const { request, events } = makeRequest(makePrompt({ cwd, tools: ["Bash"] }));
    const result = await runtime.invoke(request);

    expect(result.status).toBe("ok");
    // Order: buildDispatcherTools.execute fires tool.use / tool.result
    // inside Mastra's tool-call step (before onStepFinish), then
    // onStepFinish emits the assistant text and tokens accumulated for
    // that step. The per-tool span (`ordin.tool.<name>`) flows OTel-
    // native now (Phase D); no `timing` runtime event for it.
    expect(events.map((e) => e.type)).toEqual([
      "tool.use",
      "tool.result",
      "assistant.text",
      "tokens",
      "assistant.text",
      "tokens",
    ]);

    const toolUse = events[0];
    if (toolUse?.type !== "tool.use") throw new Error("expected tool.use");
    expect(toolUse).toMatchObject({ name: "Bash", input: { command: "echo hi" } });

    const toolResult = events[1];
    if (toolResult?.type !== "tool.result") throw new Error("expected tool.result");
    expect(toolResult.ok).toBe(true);
    expect(toolResult.result).toContain("hi");

    expect(events[4]).toEqual({ type: "assistant.text", text: "done" });
    expect(call).toBe(2);
  });

  it("includes provider HTTP context when stream startup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const providerError = Object.assign(new Error("No connected db."), {
      statusCode: 400,
      url: "http://localhost:4000/v1/chat/completions",
      responseBody:
        '{"error":{"message":"No connected db.","type":"no_db_connection","code":"400"}}',
    });
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw providerError;
      },
    });

    const runtime = new AiSdkRuntime({ model, broker: noopBroker() });
    const { request, events } = makeRequest();
    try {
      const result = await runtime.invoke(request);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("No connected db.");
      expect(result.error).toContain("HTTP 400 from http://localhost:4000/v1/chat/completions");
      expect(result.error).toContain("no_db_connection");
      expect(events.at(-1)).toEqual({ type: "error", message: result.error });
    } finally {
      consoleError.mockRestore();
    }
  });
});
