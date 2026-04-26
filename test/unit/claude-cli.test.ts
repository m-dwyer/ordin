import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComposedPrompt } from "../../src/domain/composer";
import { ClaudeCliRuntime, classifyFailure } from "../../src/runtimes/claude-cli";
import type { InvokeRequest, RuntimeEvent } from "../../src/runtimes/types";

/**
 * Minimal ChildProcess stand-in. Implements the surface ClaudeCliRuntime
 * consumes: stdout/stderr readable streams, on('close'|'error'), kill().
 */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    return true;
  }

  emitExit(code: number, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    // Give the readline parser a microtask to drain before close fires.
    setImmediate(() => this.emit("close", code, signal));
  }
}

type CapturedSpawn = {
  bin: string;
  args: readonly string[];
  cwd?: string;
};

function makePrompt(phaseId = "plan", overrides: Partial<ComposedPrompt> = {}): ComposedPrompt {
  return {
    systemPrompt: "system",
    userPrompt: "user",
    tools: ["Read", "Grep"],
    model: "claude-sonnet-4-6",
    cwd: "/tmp/repo",
    phaseId,
    tier: "M",
    freshContext: true,
    skills: [],
    ...overrides,
  };
}

async function drive(
  runtime: ClaudeCliRuntime,
  req: InvokeRequest,
): Promise<{ events: RuntimeEvent[]; result: Awaited<ReturnType<ClaudeCliRuntime["invoke"]>> }> {
  const events: RuntimeEvent[] = [];
  const result = await runtime.invoke({ ...req, onEvent: (e) => events.push(e) });
  return { events, result };
}

describe("ClaudeCliRuntime.buildArgs", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "claude-cli-test-"));
  });

  afterEach(() => {
    delete process.env["ORDIN_DEBUG_CLAUDE"];
  });

  const runtime = new ClaudeCliRuntime({
    pluginDirs: ["/harness/root"],
    spawner: () => new FakeChild() as unknown as ChildProcess,
  });

  it("includes the always-on flags", () => {
    const prompt = makePrompt();
    const args = runtime.buildArgs({ runId: "r", prompt }, "/run-dir");

    expect(args).toContain("--setting-sources");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
    expect(args).toContain("--include-hook-events");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("includes allowed tools and plugin dirs", () => {
    const prompt = makePrompt("build", { tools: ["Read", "Bash"] });
    const args = runtime.buildArgs({ runId: "r", prompt }, "/run-dir");
    const allowedIdx = args.indexOf("--allowed-tools");
    expect(allowedIdx).toBeGreaterThan(-1);
    expect(args[allowedIdx + 1]).toBe("Read");
    expect(args[allowedIdx + 2]).toBe("Bash");
    expect(args).toContain("--plugin-dir");
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe("/harness/root");
  });

  it("maps tier to --effort", () => {
    expect(
      new ClaudeCliRuntime().buildArgs({ runId: "r", prompt: makePrompt("x", { tier: "S" }) }, "/"),
    ).toContain("low");
    expect(
      new ClaudeCliRuntime().buildArgs({ runId: "r", prompt: makePrompt("x", { tier: "M" }) }, "/"),
    ).toContain("medium");
    expect(
      new ClaudeCliRuntime().buildArgs({ runId: "r", prompt: makePrompt("x", { tier: "L" }) }, "/"),
    ).toContain("high");
  });

  it("omits per-phase overrides when none are configured", () => {
    const args = runtime.buildArgs({ runId: "r", prompt: makePrompt("plan") }, "/run-dir");
    expect(args).not.toContain("--fallback-model");
    expect(args).not.toContain("--max-turns");
  });

  it("applies per-phase fallback_model and max_turns from runtime config", () => {
    const configured = new ClaudeCliRuntime({
      phaseOverrides: {
        plan: { fallback_model: "claude-haiku-4-6", max_turns: 60 },
        build: { max_turns: 80 },
      },
    });
    const planArgs = configured.buildArgs({ runId: "r", prompt: makePrompt("plan") }, "/run-dir");
    expect(planArgs).toContain("--fallback-model");
    expect(planArgs[planArgs.indexOf("--fallback-model") + 1]).toBe("claude-haiku-4-6");
    expect(planArgs).toContain("--max-turns");
    expect(planArgs[planArgs.indexOf("--max-turns") + 1]).toBe("60");

    const buildArgs = configured.buildArgs({ runId: "r", prompt: makePrompt("build") }, "/run-dir");
    expect(buildArgs).not.toContain("--fallback-model");
    expect(buildArgs[buildArgs.indexOf("--max-turns") + 1]).toBe("80");
  });

  it("omits fallback_model when it matches the selected main model", () => {
    const configured = new ClaudeCliRuntime({
      phaseOverrides: {
        plan: { fallback_model: "claude-sonnet-4-6", max_turns: 60 },
      },
    });

    const args = configured.buildArgs({ runId: "r", prompt: makePrompt("plan") }, "/run-dir");

    expect(args).not.toContain("--fallback-model");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("60");
  });

  it("gates --no-session-persistence on ephemeralSession", () => {
    const off = runtime.buildArgs({ runId: "r", prompt: makePrompt() }, "/run-dir");
    const on = runtime.buildArgs(
      { runId: "r", prompt: makePrompt(), ephemeralSession: true },
      "/run-dir",
    );
    expect(off).not.toContain("--no-session-persistence");
    expect(on).toContain("--no-session-persistence");
  });

  it("gates --include-partial-messages on streamPartial", () => {
    const off = runtime.buildArgs({ runId: "r", prompt: makePrompt() }, "/run-dir");
    const on = runtime.buildArgs(
      { runId: "r", prompt: makePrompt(), streamPartial: true },
      "/run-dir",
    );
    expect(off).not.toContain("--include-partial-messages");
    expect(on).toContain("--include-partial-messages");
  });

  it("wires --debug flags when ORDIN_DEBUG_CLAUDE=1", () => {
    process.env["ORDIN_DEBUG_CLAUDE"] = "1";
    const args = runtime.buildArgs({ runId: "r", prompt: makePrompt("plan") }, runsDir);
    expect(args).toContain("--debug");
    expect(args[args.indexOf("--debug") + 1]).toBe("api,hooks");
    expect(args).toContain("--debug-file");
    expect(args[args.indexOf("--debug-file") + 1]).toBe(join(runsDir, "plan.debug.log"));
  });
});

describe("ClaudeCliRuntime.fromConfig", () => {
  it("applies defaults for an empty slice", () => {
    const rt = ClaudeCliRuntime.fromConfig({});
    expect(rt.name).toBe("claude-cli");
  });

  it("rejects invalid shapes", () => {
    expect(() => ClaudeCliRuntime.fromConfig({ bin: 123 })).toThrow();
    expect(() => ClaudeCliRuntime.fromConfig({ phases: { plan: { max_turns: -1 } } })).toThrow();
  });

  it("surfaces per-phase overrides through buildArgs", () => {
    const rt = ClaudeCliRuntime.fromConfig({
      bin: "claude",
      phases: { plan: { fallback_model: "x", max_turns: 10 } },
    });
    const args = rt.buildArgs({ runId: "r", prompt: { ...makePrompt("plan") } }, "/run-dir");
    expect(args).toContain("--fallback-model");
    expect(args[args.indexOf("--fallback-model") + 1]).toBe("x");
  });
});

describe("ClaudeCliRuntime.invoke (with fake spawner)", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "claude-cli-run-"));
  });

  function spawnAndDrive(
    driver: (child: FakeChild) => void,
    captured: CapturedSpawn[] = [],
  ): ClaudeCliRuntime {
    return new ClaudeCliRuntime({
      runsDirFallback: runsDir,
      spawner: (bin, args, opts) => {
        captured.push({ bin, args, cwd: opts.cwd });
        const child = new FakeChild();
        setImmediate(() => driver(child));
        return child as unknown as ChildProcess;
      },
    });
  }

  it("captures session_id from system init and persists transcript", async () => {
    const runtime = spawnAndDrive((child) => {
      child.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        })}\n`,
      );
      child.emitExit(0);
    });

    const { events, result } = await drive(runtime, { runId: "run1", prompt: makePrompt() });

    expect(result.status).toBe("ok");
    expect(result.sessionId).toBe("abc-123");
    expect(result.tokens.input).toBe(10);
    expect(result.tokens.output).toBe(5);
    expect(events.some((e) => e.type === "assistant.text")).toBe(true);

    const transcriptText = await readFile(result.transcriptPath, "utf8");
    expect(transcriptText).toContain("abc-123");
  });

  it("surfaces parent_tool_use_id on subagent tool events", async () => {
    const runtime = spawnAndDrive((child) => {
      child.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          parent_tool_use_id: "subagent-1",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } }],
          },
        })}\n`,
      );
      child.emitExit(0);
    });

    const { events } = await drive(runtime, { runId: "run2", prompt: makePrompt() });
    const toolUse = events.find(
      (e): e is Extract<RuntimeEvent, { type: "tool.use" }> => e.type === "tool.use",
    );
    expect(toolUse?.parentToolUseId).toBe("subagent-1");
  });

  it("filters informational stderr but surfaces fatal lines", async () => {
    const runtime = spawnAndDrive((child) => {
      child.stderr.write("[info] starting\n");
      child.stderr.write("[warn] slow\n");
      child.stderr.write("Error: 529 overloaded\n");
      child.emitExit(1);
    });

    const { events, result } = await drive(runtime, { runId: "run3", prompt: makePrompt() });
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: expect.stringContaining("529") });
    expect(result.status).toBe("failed");
    expect(result.failure?.kind).toBe("rate_limit");
    expect(result.failure?.retryable).toBe(true);
  });

  it("classifies auth failure from stderr", async () => {
    const runtime = spawnAndDrive((child) => {
      child.stderr.write("Error: Invalid API key\n");
      child.emitExit(1);
    });
    const { result } = await drive(runtime, { runId: "run4", prompt: makePrompt() });
    expect(result.failure?.kind).toBe("auth");
    expect(result.failure?.retryable).toBe(false);
  });

  it("classifies signal kill as crash (not retryable)", async () => {
    const runtime = spawnAndDrive((child) => {
      child.emitExit(-1, "SIGTERM");
    });
    const { result } = await drive(runtime, { runId: "run5", prompt: makePrompt() });
    expect(result.failure?.kind).toBe("crash");
    expect(result.failure?.retryable).toBe(false);
  });

  it("writes transcripts under the provided runDir", async () => {
    const runtime = spawnAndDrive((child) => {
      child.emitExit(0);
    });
    const runDir = join(runsDir, "explicit");
    const { result } = await drive(runtime, {
      runId: "ignored",
      runDir,
      prompt: makePrompt("plan"),
    });
    expect(result.transcriptPath).toBe(join(runDir, "plan.jsonl"));
  });
});

describe("classifyFailure", () => {
  it("prioritises timeout over other signals", () => {
    expect(
      classifyFailure({ exitCode: -1, signal: "SIGTERM", stderr: "", timedOut: true }).kind,
    ).toBe("timeout");
  });

  it("returns unknown for empty stderr on a plain non-zero exit", () => {
    const f = classifyFailure({ exitCode: 1, signal: null, stderr: "", timedOut: false });
    expect(f.kind).toBe("unknown");
    expect(f.retryable).toBe(false);
  });

  it.each([
    ["Error: 529 service overloaded", "rate_limit", true],
    ["rate limit exceeded", "rate_limit", true],
    ["Invalid API key", "auth", false],
    ["unauthorized request", "auth", false],
    ["tool not allowed: Bash", "tool", false],
    ["Model not found: claude-xyz", "model", false],
    ["request timed out", "timeout", true],
  ] as const)("classifies %s as %s (retryable=%s)", (stderr, kind, retryable) => {
    const f = classifyFailure({ exitCode: 1, signal: null, stderr, timedOut: false });
    expect(f.kind).toBe(kind);
    expect(f.retryable).toBe(retryable);
  });
});
