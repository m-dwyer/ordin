import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeFailure,
  RuntimeFailureKind,
  TokenUsage,
} from "./types";

/**
 * Subprocess wrap of `claude -p`. The only way to drive Claude under a
 * Max plan subscription today; Anthropic's Agent SDK is API-key-only.
 *
 * Flags wired into every invocation:
 *   --output-format stream-json --verbose     (observability)
 *   --append-system-prompt <agent body>
 *   --model <model>
 *   --permission-mode bypassPermissions       (tool allowlist is the
 *                                              real boundary)
 *   --allowed-tools <space-separated>
 *   --plugin-dir <dir>                        (skills / plugin manifest)
 *   --effort <low|medium|high>                (from tier hint)
 *   --setting-sources project                 (no ambient ~/.claude
 *                                              leakage into runs)
 *   --exclude-dynamic-system-prompt-sections  (prompt-cache wins across
 *                                              Plan → Build → Review on
 *                                              the same target repo)
 *   --include-hook-events                     (cheap observability —
 *                                              future-proof for hooks)
 *
 * Conditionally added (resolved from this runtime's own config slice —
 * see `ClaudeCliConfigSchema` — not from the domain):
 *   --fallback-model <name>          per-phase override
 *   --max-turns <n>                  per-phase override
 *   --no-session-persistence         when req.ephemeralSession
 *   --include-partial-messages       when req.streamPartial
 *   --debug api,hooks --debug-file X when ORDIN_DEBUG_CLAUDE=1
 */
const PhaseOverrideSchema = z.object({
  fallback_model: z.string().min(1).optional(),
  max_turns: z.number().int().positive().optional(),
});

export const ClaudeCliConfigSchema = z.object({
  /** Path to the `claude` binary. If relative, PATH is searched. */
  bin: z.string().default("claude"),
  /** Optional hard ceiling on wall-clock duration. Undefined = no timeout. */
  timeout_ms: z.number().int().positive().optional(),
  /** Per-phase Claude-specific knobs (fallback model, turn ceiling, …). */
  phases: z.record(z.string(), PhaseOverrideSchema).default({}),
});
export type ClaudeCliConfigRaw = z.infer<typeof ClaudeCliConfigSchema>;

export type Spawner = (
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

const defaultSpawner: Spawner = (bin, args, opts) =>
  spawn(bin, args as string[], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

export interface ClaudeCliRuntimeOptions {
  readonly bin?: string;
  readonly timeoutMs?: number;
  readonly phaseOverrides?: Readonly<
    Record<string, { fallback_model?: string; max_turns?: number }>
  >;
  /**
   * Directories passed via repeated `--plugin-dir`. Injected by the
   * harness facade (typically the ordin repo root). Not YAML config —
   * it's pack metadata, not runtime config.
   */
  readonly pluginDirs?: readonly string[];
  /** Fallback transcript dir when `InvokeRequest.runDir` is unset. */
  readonly runsDirFallback?: string;
  /** Injectable spawner — tests replace; prod uses `child_process.spawn`. */
  readonly spawner?: Spawner;
}

export class ClaudeCliRuntime implements AgentRuntime {
  readonly name = "claude-cli";
  readonly capabilities: RuntimeCapabilities = {
    nativeSkillDiscovery: true,
    streaming: true,
    mcpSupport: true,
    maxContextTokens: 200_000,
  };

  private readonly bin: string;
  private readonly timeoutMs?: number;
  private readonly phaseOverrides: Readonly<
    Record<string, { fallback_model?: string; max_turns?: number }>
  >;
  private readonly pluginDirs: readonly string[];
  private readonly runsDirFallback: string;
  private readonly spawner: Spawner;

  constructor(opts: ClaudeCliRuntimeOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.timeoutMs = opts.timeoutMs;
    this.phaseOverrides = opts.phaseOverrides ?? {};
    this.pluginDirs = opts.pluginDirs ?? [];
    this.runsDirFallback = opts.runsDirFallback ?? join(homedir(), ".ordin", "runs");
    this.spawner = opts.spawner ?? defaultSpawner;
  }

  /**
   * Validate a YAML config slice and construct the runtime. Caller
   * supplies harness-level extras (pluginDirs, runsDirFallback,
   * spawner) that aren't part of the config file itself.
   */
  static fromConfig(
    raw: unknown,
    extras: Omit<ClaudeCliRuntimeOptions, "bin" | "timeoutMs" | "phaseOverrides"> = {},
  ): ClaudeCliRuntime {
    const parsed = ClaudeCliConfigSchema.parse(raw ?? {});
    return new ClaudeCliRuntime({
      bin: parsed.bin,
      ...(parsed.timeout_ms !== undefined ? { timeoutMs: parsed.timeout_ms } : {}),
      phaseOverrides: parsed.phases,
      ...extras,
    });
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const runDir = req.runDir ?? resolve(this.runsDirFallback, req.runId);
    const transcriptPath = join(runDir, `${req.prompt.phaseId}.jsonl`);
    await mkdir(runDir, { recursive: true });

    const args = this.buildArgs(req, runDir);
    const started = Date.now();

    const child = this.spawner(this.bin, args, { cwd: req.prompt.cwd, env: process.env });

    const transcript = createWriteStream(transcriptPath, { flags: "a" });
    const stderrFatalChunks: string[] = [];

    const tokens: { value: TokenUsage } = {
      value: { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 },
    };
    let sessionId: string | undefined;

    const emit = (event: RuntimeEvent): void => {
      req.onEvent?.(event);
    };

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      throw new Error("Failed to capture stdio from claude subprocess");
    }

    const rl = createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      transcript.write(`${line}\n`);
      const interpreted = this.interpretLine(line, tokens, emit);
      if (interpreted?.sessionId) sessionId = interpreted.sessionId;
    });

    stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (isInformationalStderr(line)) continue;
        stderrFatalChunks.push(line);
        emit({ type: "error", message: line });
      }
    });

    const abortHandler = (): void => {
      if (!child.killed) child.kill("SIGTERM");
    };
    req.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    let timedOut = false;
    const timer = this.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          emit({ type: "error", message: `Timed out after ${this.timeoutMs}ms` });
          if (!child.killed) child.kill("SIGTERM");
        }, this.timeoutMs)
      : undefined;

    const exitInfo: { code: number; signal: NodeJS.Signals | null } = await new Promise(
      (resolveExit) => {
        child.on("close", (code, signal) => resolveExit({ code: code ?? -1, signal }));
        child.on("error", (err) => {
          emit({ type: "error", message: `Failed to spawn claude: ${err.message}` });
          resolveExit({ code: -1, signal: null });
        });
      },
    );

    if (timer) clearTimeout(timer);
    req.abortSignal?.removeEventListener("abort", abortHandler);
    transcript.end();

    const exitCode = exitInfo.code;
    const status: "ok" | "failed" = exitCode === 0 ? "ok" : "failed";
    const stderrBlob = stderrFatalChunks.join("\n").trim();
    const failure: RuntimeFailure | undefined =
      status === "failed"
        ? classifyFailure({
            exitCode,
            signal: exitInfo.signal,
            stderr: stderrBlob,
            timedOut,
          })
        : undefined;

    return {
      status,
      exitCode,
      transcriptPath,
      tokens: tokens.value,
      durationMs: Date.now() - started,
      ...(sessionId ? { sessionId } : {}),
      ...(failure ? { failure, error: failure.message } : {}),
    };
  }

  buildArgs(req: InvokeRequest, runDir: string): string[] {
    const { prompt } = req;
    const override = this.phaseOverrides[prompt.phaseId] ?? {};
    const args: string[] = [
      "-p",
      prompt.userPrompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      prompt.systemPrompt,
      "--model",
      prompt.model,
      "--permission-mode",
      "bypassPermissions",
      // Scope settings loading to the project only; no ambient
      // `~/.claude/` leakage into runs.
      "--setting-sources",
      "project",
      // Move per-machine context out of the system prompt so the
      // cached prefix is reusable across phases on the same repo.
      "--exclude-dynamic-system-prompt-sections",
      // Cheap observability: any configured hook emits lifecycle
      // events into our stream.
      "--include-hook-events",
    ];
    if (prompt.tools.length > 0) {
      // Variadic flag: each tool as its own argv entry so Claude's parser
      // treats them as distinct entries rather than a single string.
      args.push("--allowed-tools", ...prompt.tools);
    }
    for (const dir of this.pluginDirs) {
      args.push("--plugin-dir", dir);
    }
    args.push("--effort", ClaudeCliRuntime.effortForTier(prompt.tier));
    if (override.fallback_model) args.push("--fallback-model", override.fallback_model);
    if (override.max_turns !== undefined) args.push("--max-turns", String(override.max_turns));
    if (req.ephemeralSession) args.push("--no-session-persistence");
    if (req.streamPartial) args.push("--include-partial-messages");
    if (process.env["ORDIN_DEBUG_CLAUDE"] === "1") {
      args.push(
        "--debug",
        "api,hooks",
        "--debug-file",
        join(runDir, `${prompt.phaseId}.debug.log`),
      );
    }
    return args;
  }

  /**
   * Tier → Claude `--effort` mapping. Private to this runtime: the domain
   * exposes only the neutral `tier` hint and trusts each runtime to pick
   * its own quality knob. Keep in lockstep with Claude Code's effort
   * levels (`low`, `medium`, `high`, `xhigh`, `max`).
   */
  private static effortForTier(tier: "S" | "M" | "L"): "low" | "medium" | "high" {
    switch (tier) {
      case "S":
        return "low";
      case "M":
        return "medium";
      case "L":
        return "high";
    }
  }

  /**
   * Parse a JSONL event from claude's stream-json output. We tolerate
   * schema drift: unknown event shapes pass through as raw lines.
   */
  private interpretLine(
    line: string,
    tokens: { value: TokenUsage },
    emit: (e: RuntimeEvent) => void,
  ): { sessionId?: string } | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;

    const event = parsed as ClaudeEvent;
    let capturedSession: string | undefined;

    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      capturedSession = event.session_id;
    } else if (event.type === "assistant" && event.message?.content) {
      const parentToolUseId = event.parent_tool_use_id;
      for (const block of event.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          emit({ type: "assistant.text", text: block.text });
        } else if (block.type === "thinking") {
          emit({ type: "assistant.thinking" });
        } else if (block.type === "tool_use" && block.name && block.id) {
          emit({
            type: "tool.use",
            id: block.id,
            name: block.name,
            input: block.input,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
      }
      if (event.message.usage) {
        tokens.value = mergeUsage(tokens.value, event.message.usage);
        emit({ type: "tokens", usage: tokens.value });
      }
    } else if (event.type === "user" && event.message?.content) {
      const parentToolUseId = event.parent_tool_use_id;
      for (const block of event.message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const preview = typeof block.content === "string" ? block.content : undefined;
          emit({
            type: "tool.result",
            id: block.tool_use_id,
            ok: block.is_error !== true,
            ...(preview ? { preview } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
      }
    } else if (event.type === "result" && event.usage) {
      tokens.value = mergeUsage(tokens.value, event.usage);
      emit({ type: "tokens", usage: tokens.value });
    }

    return capturedSession ? { sessionId: capturedSession } : undefined;
  }
}

function mergeUsage(current: TokenUsage, usage: ClaudeUsage): TokenUsage {
  return {
    input: Math.max(current.input, usage.input_tokens ?? 0),
    output: Math.max(current.output, usage.output_tokens ?? 0),
    cacheReadInput: Math.max(current.cacheReadInput, usage.cache_read_input_tokens ?? 0),
    cacheCreationInput: Math.max(
      current.cacheCreationInput,
      usage.cache_creation_input_tokens ?? 0,
    ),
  };
}

/**
 * Heuristic: is this stderr line diagnostic noise rather than a fatal
 * error? Claude Code emits progress + warnings on stderr alongside
 * real failures; we don't want to pollute the `RuntimeEvent` stream
 * with spinner text.
 */
function isInformationalStderr(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("[info]")) return true;
  if (trimmed.startsWith("[warn]")) return true;
  if (trimmed.startsWith("[debug]")) return true;
  if (trimmed.startsWith("{")) return true; // stray JSON fragment
  return false;
}

interface ClassifyInput {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export function classifyFailure(input: ClassifyInput): RuntimeFailure {
  const { exitCode, signal, stderr, timedOut } = input;
  const message = stderr || (signal ? `killed by ${signal}` : `exit ${exitCode}`);

  if (timedOut) return { kind: "timeout", message, retryable: true };
  if (signal) return { kind: "crash", message, retryable: false };

  const lower = stderr.toLowerCase();
  const matchAny = (patterns: readonly string[]): boolean =>
    patterns.some((p) => lower.includes(p));

  const kind: RuntimeFailureKind = matchAny(["rate limit", "rate_limit", "529", "overloaded"])
    ? "rate_limit"
    : matchAny(["invalid api key", "unauthorized", "unauthenticated", "401"])
      ? "auth"
      : matchAny(["not in allowed-tools", "tool not allowed", "disallowed tool"])
        ? "tool"
        : matchAny(["model not found", "unknown model", "invalid model"])
          ? "model"
          : matchAny(["timed out", "timeout"])
            ? "timeout"
            : "unknown";

  const retryable = kind === "rate_limit" || kind === "timeout";
  return { kind, message, retryable };
}

// Claude Code stream-json event shapes (minimal subset we interpret).
interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string;
  message?: { content?: ClaudeContentBlock[]; usage?: ClaudeUsage };
  usage?: ClaudeUsage;
}
interface ClaudeContentBlock {
  type?: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | unknown;
}
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
