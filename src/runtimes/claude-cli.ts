import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  TokenUsage,
} from "./types";

/**
 * Stage 1's sole runtime. Spawns `claude -p` with:
 *   --append-system-prompt <agent body>
 *   --output-format stream-json
 *   --allowed-tools <space-separated>
 *   --model <model id>
 * CWD = target repo path.
 *
 * Streams JSONL events to a per-run transcript and re-emits structured
 * events via `onEvent` for live progress in the user's terminal.
 *
 * Skills rely on Claude Code's native plugin discovery: every invocation
 * passes `--plugin-dir <ordin-repo>` so SKILL.md files under `skills/`
 * load per-run without touching `~/.claude/`.
 */
export interface ClaudeCliConfig {
  /** Path to the `claude` binary. If relative, PATH is searched. */
  bin?: string;
  /** Where transcripts are persisted. Defaults to ~/.ordin/runs. */
  runsDir?: string;
  /**
   * Plugin directories to load for each invocation. Passed to `claude -p`
   * via repeated `--plugin-dir` flags so skills (and any future bundled
   * agents/hooks/MCP) discover per-run. Typically the ordin repo root.
   */
  pluginDirs?: readonly string[];
  /** Optional hard ceiling on wall-clock duration. Undefined = no timeout (Stage 1 default). */
  timeoutMs?: number;
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
  private readonly runsDir: string;
  private readonly pluginDirs: readonly string[];
  private readonly timeoutMs?: number;

  constructor(config: ClaudeCliConfig = {}) {
    this.bin = config.bin ?? "claude";
    this.runsDir = config.runsDir ?? join(homedir(), ".ordin", "runs");
    this.pluginDirs = config.pluginDirs ?? [];
    this.timeoutMs = config.timeoutMs;
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const runDir = resolve(this.runsDir, req.runId);
    const transcriptPath = join(runDir, `${req.prompt.phaseId}.jsonl`);
    await mkdir(runDir, { recursive: true });

    const args = this.buildArgs(req);
    const started = Date.now();

    const child = spawn(this.bin, args, {
      cwd: req.prompt.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const transcript = createWriteStream(transcriptPath, { flags: "a" });
    const stderrChunks: string[] = [];

    const tokens: { value: TokenUsage } = {
      value: { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 },
    };

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
      this.interpretLine(line, tokens, emit);
    });

    stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      emit({ type: "error", message: text });
    });

    const abortHandler = (): void => {
      if (!child.killed) child.kill("SIGTERM");
    };
    req.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    const timer = this.timeoutMs
      ? setTimeout(() => {
          emit({ type: "error", message: `Timed out after ${this.timeoutMs}ms` });
          if (!child.killed) child.kill("SIGTERM");
        }, this.timeoutMs)
      : undefined;

    const exitCode: number = await new Promise((resolveExit) => {
      child.on("close", (code) => resolveExit(code ?? -1));
      child.on("error", (err) => {
        emit({ type: "error", message: `Failed to spawn claude: ${err.message}` });
        resolveExit(-1);
      });
    });

    if (timer) clearTimeout(timer);
    req.abortSignal?.removeEventListener("abort", abortHandler);
    transcript.end();

    const status = exitCode === 0 ? "ok" : "failed";
    const errorText = stderrChunks.join("").trim();

    return {
      status,
      exitCode,
      transcriptPath,
      tokens: tokens.value,
      durationMs: Date.now() - started,
      ...(status === "failed" && errorText ? { error: errorText } : {}),
    };
  }

  private buildArgs(req: InvokeRequest): string[] {
    const { prompt } = req;
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
      // stdin is ignored in non-interactive `-p`, so any permission prompt
      // stalls the subprocess. `bypassPermissions` skips the prompt; the
      // actual security boundary is `--allowed-tools` below.
      "--permission-mode",
      "bypassPermissions",
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
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    const event = parsed as ClaudeEvent;

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          emit({ type: "assistant.text", text: block.text });
        } else if (block.type === "thinking") {
          emit({ type: "assistant.thinking" });
        } else if (block.type === "tool_use" && block.name && block.id) {
          emit({ type: "tool.use", id: block.id, name: block.name, input: block.input });
        }
      }
      if (event.message.usage) {
        tokens.value = mergeUsage(tokens.value, event.message.usage);
        emit({ type: "tokens", usage: tokens.value });
      }
    } else if (event.type === "user" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const preview = typeof block.content === "string" ? block.content : undefined;
          emit({
            type: "tool.result",
            id: block.tool_use_id,
            ok: block.is_error !== true,
            ...(preview ? { preview } : {}),
          });
        }
      }
    } else if (event.type === "result" && event.usage) {
      tokens.value = mergeUsage(tokens.value, event.usage);
      emit({ type: "tokens", usage: tokens.value });
    }
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

// Claude Code stream-json event shapes (minimal subset we interpret).
interface ClaudeEvent {
  type?: string;
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
