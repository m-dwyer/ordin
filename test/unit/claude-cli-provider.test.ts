import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ComposedPrompt } from "../../src/domain/composer";
import {
  ClaudeCliProviderRuntime,
  type ClaudeModelProvider,
  type ClaudeProviderTurn,
  interpretClaudeStreamLine,
  type ProviderChildProcess,
  type ProviderMessage,
} from "../../src/worker/runtimes/claude-cli-provider";
import { buildRuntime, KNOWN_RUNTIME_NAMES } from "../../src/worker/runtimes/registry";
import {
  type ToolDispatchContext,
  ToolDispatcher,
} from "../../src/worker/runtimes/shared/dispatcher";
import type { RuntimeEvent } from "../../src/worker/runtimes/types";

const ZERO_TOKENS = {
  input: 0,
  output: 0,
  cacheReadInput: 0,
  cacheCreationInput: 0,
} as const;

function makePrompt(overrides: Partial<ComposedPrompt> = {}): ComposedPrompt {
  return {
    systemPrompt: "system",
    userPrompt: "user",
    tools: ["Read", "Bash(git status*)"],
    model: "claude-sonnet-4-6",
    cwd: "/tmp/repo",
    phaseId: "build",
    tier: "M",
    freshContext: true,
    skills: [],
    ...overrides,
  };
}

class QueueProvider implements ClaudeModelProvider {
  readonly seen: ProviderMessage[][] = [];

  constructor(private readonly responses: ClaudeProviderTurn[]) {}

  async complete(req: {
    readonly messages: readonly ProviderMessage[];
    readonly onRawLine?: (line: string) => void;
  }): Promise<ClaudeProviderTurn> {
    this.seen.push([...req.messages]);
    req.onRawLine?.('{"type":"assistant"}');
    const next = this.responses.shift();
    if (!next) throw new Error("no queued response");
    return next;
  }
}

class FakeDispatcher extends ToolDispatcher {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];

  override async dispatch(
    name: string,
    input: Record<string, unknown>,
    _ctx: ToolDispatchContext,
  ): Promise<string> {
    this.calls.push({ name, input });
    return `result:${name}:${JSON.stringify(input)}`;
  }
}

class FakeChild extends EventEmitter implements ProviderChildProcess {
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

describe("claude-cli-provider registry", () => {
  it("registers and constructs the experimental runtime", async () => {
    expect(KNOWN_RUNTIME_NAMES).toContain("claude-cli-provider");

    const runtime = await buildRuntime(
      "claude-cli-provider",
      { bin: "claude", max_steps: 2 },
      { harnessRoot: "/harness", workflowName: "w", runsDir: "/tmp/runs" },
    );

    expect(runtime.name).toBe("claude-cli-provider");
  });
});

describe("interpretClaudeStreamLine", () => {
  it("parses assistant text and usage", () => {
    expect(
      interpretClaudeStreamLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "hello" }],
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        }),
      ),
    ).toEqual({
      texts: ["hello"],
      thinking: false,
      tokens: { input: 10, output: 3, cacheReadInput: 0, cacheCreationInput: 0 },
    });
  });

  it("parses a native Claude tool_use block", () => {
    expect(
      interpretClaudeStreamLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Read",
                input: { file_path: "README.md" },
              },
            ],
          },
        }),
      ),
    ).toEqual({
      texts: [],
      thinking: false,
      toolCall: { id: "toolu_1", name: "Read", input: { file_path: "README.md" } },
    });
  });

  it("rejects malformed stream JSON", () => {
    expect(() => interpretClaudeStreamLine("{bad")).toThrow(/Malformed Claude stream-json line/);
  });
});

describe("ClaudeCliProviderRuntime tool loop", () => {
  it("invokes Claude CLI with stream-json and native tool schemas enabled", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "claude-provider-"));
    const cwd = await mkdtemp(join(tmpdir(), "claude-provider-cwd-"));
    let capturedArgs: readonly string[] = [];
    let child: FakeChild | undefined;
    const runtime = new ClaudeCliProviderRuntime({
      bin: "claude",
      runsDirFallback: runsDir,
      maxSteps: 1,
      spawner: (_bin, args) => {
        capturedArgs = args;
        child = new FakeChild();
        setImmediate(() => {
          child?.emitLine(
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "done" }] },
            }),
          );
          child?.emitExit(0);
        });
        return child;
      },
    });

    const result = await runtime.invoke({
      runId: "run1",
      prompt: makePrompt({
        cwd,
        skills: [
          {
            name: "rfc-template",
            description: "RFC guidance",
            body: "Use Summary, Problem, Options.",
            source: "/harness/skills/rfc-template/SKILL.md",
          },
        ],
      }),
    });

    expect(result.status).toBe("ok");
    expect(capturedArgs).toContain("--output-format");
    expect(capturedArgs[capturedArgs.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(capturedArgs).toContain("--verbose");
    expect(capturedArgs).toContain("--system-prompt");
    expect(capturedArgs[capturedArgs.indexOf("--system-prompt") + 1]).toContain(
      "Use Summary, Problem, Options.",
    );
    expect(capturedArgs[capturedArgs.indexOf("--system-prompt") + 1]).toContain(
      "Do not call a Skill tool",
    );
    expect(capturedArgs).toContain("--tools");
    expect(capturedArgs[capturedArgs.indexOf("--tools") + 1]).toBe("Read,Bash");
    expect(capturedArgs).toContain("--allowed-tools");
    expect(capturedArgs).not.toContain("--disable-slash-commands");
  });

  it("emits tool events, dispatches through ToolDispatcher, and stops at final", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "claude-provider-"));
    const provider = new QueueProvider([
      {
        texts: ["I will inspect the file."],
        toolCall: { id: "t1", name: "Read", input: { file_path: "README.md" } },
        tokens: ZERO_TOKENS,
      },
      { texts: ["done"], tokens: ZERO_TOKENS },
    ]);
    const dispatcher = new FakeDispatcher();
    const runtime = new ClaudeCliProviderRuntime({
      bin: "claude",
      runsDirFallback: runsDir,
      provider,
      dispatcher,
      maxSteps: 5,
      protocolDebug: true,
    });
    const events: RuntimeEvent[] = [];

    const result = await runtime.invoke({
      runId: "run1",
      prompt: makePrompt(),
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("ok");
    expect(dispatcher.calls).toEqual([{ name: "Read", input: { file_path: "README.md" } }]);
    expect(events).toEqual([
      { type: "assistant.thinking" },
      { type: "assistant.text", text: "I will inspect the file." },
      {
        type: "tool.use",
        id: "t1",
        name: "Read",
        input: { file_path: "README.md" },
      },
      {
        type: "tool.result",
        id: "t1",
        ok: true,
        result: 'result:Read:{"file_path":"README.md"}',
      },
      { type: "assistant.thinking" },
      { type: "assistant.text", text: "done" },
    ]);
    expect(provider.seen[1]?.some((m) => m.content.includes("Tool result for Read"))).toBe(true);
    expect(await readFile(result.transcriptPath, "utf8")).toContain('"kind":"protocol"');
  });

  it("fails when the provider requests a disallowed tool", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "claude-provider-"));
    const runtime = new ClaudeCliProviderRuntime({
      bin: "claude",
      runsDirFallback: runsDir,
      provider: new QueueProvider([
        {
          texts: [],
          toolCall: { id: "t1", name: "Write", input: { file_path: "x", content: "y" } },
          tokens: ZERO_TOKENS,
        },
      ]),
      dispatcher: new FakeDispatcher(),
      maxSteps: 2,
    });

    const result = await runtime.invoke({ runId: "run1", prompt: makePrompt() });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not allowed/);
  });

  it("fails on max-step exhaustion", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "claude-provider-"));
    const runtime = new ClaudeCliProviderRuntime({
      bin: "claude",
      runsDirFallback: runsDir,
      provider: new QueueProvider([
        {
          texts: ["still working"],
          toolCall: { id: "t1", name: "Read", input: { file_path: "README.md" } },
          tokens: ZERO_TOKENS,
        },
      ]),
      dispatcher: new FakeDispatcher(),
      maxSteps: 1,
    });

    const result = await runtime.invoke({ runId: "run1", prompt: makePrompt() });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Exceeded max_steps/);
  });
});
