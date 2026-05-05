import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import type {
  ProviderChildProcess,
  ProviderSpawner,
} from "../../src/worker/runtimes/claude-cli-provider";
import { ClaudeLanguageModelV2 } from "../../src/worker/runtimes/claude-language-model-v2";

class FakeChild extends EventEmitter implements ProviderChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    return super.emit(eventName, ...args);
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    return true;
  }

  emitLine(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  emitExit(code = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

function recordingSpawner(scripts: Array<(child: FakeChild) => void>): {
  spawner: ProviderSpawner;
  records: Array<{ args: readonly string[]; child: FakeChild }>;
} {
  const records: Array<{ args: readonly string[]; child: FakeChild }> = [];
  const spawner: ProviderSpawner = (_bin, args) => {
    const index = records.length;
    const child = new FakeChild();
    records.push({ args: [...args], child });
    setImmediate(() => scripts[index]?.(child));
    return child;
  };
  return { spawner, records };
}

function makeOptions(prompt: LanguageModelV2Prompt): LanguageModelV2CallOptions {
  return {
    prompt,
    tools: [{ type: "function", name: "Read", inputSchema: { type: "object" } }],
  };
}

async function readStream(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<LanguageModelV2StreamPart[]> {
  const parts: LanguageModelV2StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return parts;
}

describe("ClaudeLanguageModelV2", () => {
  it("translates a tool-use turn, kills the child, captures session_id, and resumes on the next call", async () => {
    const { spawner, records } = recordingSpawner([
      (child) => {
        child.emitLine(
          JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }),
        );
        child.emitLine(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "I will inspect the file." },
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "mcp__ordin__Read",
                  input: { file_path: "README.md" },
                },
              ],
              usage: { input_tokens: 11, output_tokens: 7 },
            },
          }),
        );
        child.emitExit(-1, "SIGTERM");
      },
      (child) => {
        child.emitLine(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "done" }] },
          }),
        );
        child.emitExit(0);
      },
    ]);

    const adapter = new ClaudeLanguageModelV2({
      bin: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp/repo",
      tier: "M",
      spawner,
    });

    const first = await adapter.doStream(
      makeOptions([
        { role: "system", content: "you are a test agent" },
        { role: "user", content: [{ type: "text", text: "read it" }] },
      ]),
    );
    const firstParts = await readStream(first.stream);

    expect(records[0]?.child.killed).toBe(true);
    expect(records[0]?.args).not.toContain("--resume");
    expect(firstParts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "tool-call",
      "finish",
    ]);
    const toolCall = firstParts[4];
    if (toolCall?.type !== "tool-call") throw new Error("expected tool-call");
    expect(toolCall.toolCallId).toBe("toolu_1");
    expect(toolCall.toolName).toBe("Read");
    expect(JSON.parse(toolCall.input as string)).toEqual({ file_path: "README.md" });
    const firstFinish = firstParts[5];
    if (firstFinish?.type !== "finish") throw new Error("expected finish");
    expect(firstFinish.finishReason).toBe("tool-calls");

    const second = await adapter.doStream(
      makeOptions([
        { role: "system", content: "you are a test agent" },
        { role: "user", content: [{ type: "text", text: "read it" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "toolu_1",
              toolName: "Read",
              input: JSON.stringify({ file_path: "README.md" }),
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "toolu_1",
              toolName: "Read",
              output: { type: "text", value: "file body" },
            },
          ],
        },
      ]),
    );
    const secondParts = await readStream(second.stream);

    expect(records).toHaveLength(2);
    const resumeIndex = records[1]?.args.indexOf("--resume") ?? -1;
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(records[1]?.args[resumeIndex + 1]).toBe("session-1");
    const secondFinish = secondParts[secondParts.length - 1];
    if (secondFinish?.type !== "finish") throw new Error("expected finish");
    expect(secondFinish.finishReason).toBe("stop");
  });
});
