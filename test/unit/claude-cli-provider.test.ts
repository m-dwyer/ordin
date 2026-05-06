import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  ApprovalResult,
  BrokerClient,
  RecordedResult,
  ToolIntent,
} from "../../src/broker/client/types";
import type { ComposedPrompt } from "../../src/domain/composer";
import { ClaudeCliProviderRuntime } from "../../src/worker/runtimes/claude-cli-provider";
import type {
  ProviderChildProcess,
  ProviderSpawner,
} from "../../src/worker/runtimes/claude-stream";
import { buildRuntime, KNOWN_RUNTIME_NAMES } from "../../src/worker/runtimes/registry";
import type { RuntimeEvent } from "../../src/worker/runtimes/types";

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

class FakeBrokerClient implements BrokerClient {
  readonly approvals: Array<{ name: string; input: Record<string, unknown> }> = [];
  readonly results: Array<{ name: string; ok: boolean }> = [];

  async requestApproval(intent: ToolIntent): Promise<ApprovalResult> {
    this.approvals.push({ name: intent.tool, input: intent.input });
    return { ok: true };
  }

  async recordResult(intent: ToolIntent, recorded: RecordedResult): Promise<void> {
    this.results.push({ name: intent.tool, ok: recorded.result.ok });
  }
}

function makePrompt(overrides: Partial<ComposedPrompt> = {}): ComposedPrompt {
  return {
    systemPrompt: "system",
    userPrompt: "user",
    tools: ["Read"],
    model: "claude-sonnet-4-6",
    cwd: "/tmp/repo",
    phaseId: "build",
    tier: "M",
    freshContext: true,
    skills: [],
    ...overrides,
  };
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

describe("claude-cli-provider registry", () => {
  it("registers and constructs the experimental runtime", async () => {
    expect(KNOWN_RUNTIME_NAMES).toContain("claude-cli-provider");
    const broker = new FakeBrokerClient();
    const runtime = await buildRuntime(
      "claude-cli-provider",
      { bin: "claude", max_steps: 2 },
      { harnessRoot: "/harness", workflowName: "w", runsDir: "/tmp/runs", broker },
    );
    expect(runtime.name).toBe("claude-cli-provider");
  });
});

describe("ClaudeCliProviderRuntime", () => {
  it("wires Mastra Agent to ClaudeLanguageModelV2 + dispatcher: tool-call → resume → final, with per-phase fallback", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "claude-provider-"));
    const cwd = await mkdtemp(join(tmpdir(), "claude-provider-cwd-"));
    // The runtime now executes tool calls worker-side (ADR-016 corrected),
    // so the Read tool actually reads from the workspace. Stage a file.
    await writeFile(join(cwd, "README.md"), "# fixture\n", "utf8");
    const broker = new FakeBrokerClient();
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

    const runtime = ClaudeCliProviderRuntime.fromConfig(
      {
        bin: "claude",
        phases: { build: { fallback_model: "claude-haiku-4-6" } },
      },
      {
        harnessRoot: "/harness",
        runsDirFallback: runsDir,
        broker,
        spawner,
      },
    );

    const events: RuntimeEvent[] = [];
    const result = await runtime.invoke({
      runId: "run1",
      prompt: makePrompt({ cwd }),
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("ok");
    expect(records).toHaveLength(2);
    expect(records[0]?.args).toContain("--fallback-model");
    expect(records[0]?.args[records[0].args.indexOf("--fallback-model") + 1]).toBe(
      "claude-haiku-4-6",
    );
    expect(records[0]?.args).toContain("--allowed-tools");
    expect(records[0]?.args).toContain("mcp__ordin__Read");
    expect(records[0]?.args).not.toContain("--resume");
    expect(records[1]?.args).toContain("--resume");
    expect(records[1]?.args[records[1].args.indexOf("--resume") + 1]).toBe("session-1");

    expect(broker.approvals).toEqual([{ name: "Read", input: { file_path: "README.md" } }]);
    expect(broker.results).toEqual([{ name: "Read", ok: true }]);

    const types = events.map((e) => e.type);
    expect(types).toContain("tool.use");
    expect(types).toContain("tool.result");
    expect(types).toContain("assistant.text");
    const turnTimings = events.filter(
      (e): e is Extract<RuntimeEvent, { type: "timing" }> =>
        e.type === "timing" && e.name === "ordin.provider.turn",
    );
    expect(turnTimings).toHaveLength(2);
    expect(turnTimings[0]?.attributes?.["ordin.provider.tool_requested"]).toBe(true);
    expect(turnTimings[0]?.attributes?.["ordin.provider.resumed"]).toBe(false);
    expect(turnTimings[1]?.attributes?.["ordin.provider.tool_requested"]).toBe(false);
    expect(turnTimings[1]?.attributes?.["ordin.provider.resumed"]).toBe(true);
    const toolTiming = events.find(
      (e): e is Extract<RuntimeEvent, { type: "timing" }> =>
        e.type === "timing" && e.name === "ordin.tool.Read",
    );
    expect(toolTiming?.status).toBe("ok");

    const transcript = await readFile(result.transcriptPath, "utf8");
    expect(transcript).toContain("ordin.provider.turn");
    expect(transcript).toContain("ordin.tool.Read");
  });

  it("classifies provider auth failures as non-retryable", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "claude-provider-"));
    const { spawner } = recordingSpawner([
      (child) => {
        child.stderr.write("Invalid API key\n");
        child.emitExit(1, null);
      },
    ]);

    const runtime = new ClaudeCliProviderRuntime({
      bin: "claude",
      runsDirFallback: runsDir,
      maxSteps: 1,
      spawner,
      broker: new FakeBrokerClient(),
    });

    const result = await runtime.invoke({ runId: "run1", prompt: makePrompt() });

    expect(result.status).toBe("failed");
    expect(result.failure?.kind).toBe("auth");
    expect(result.failure?.retryable).toBe(false);
  });
});
