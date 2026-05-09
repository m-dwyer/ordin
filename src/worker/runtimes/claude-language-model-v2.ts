import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
  LanguageModelV2ProviderDefinedTool,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolResultOutput,
  LanguageModelV2Usage,
} from "@ai-sdk/provider-v5";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  type ClaudeToolCall,
  interpretClaudeStreamLine,
  type ProviderChildProcess,
  type ProviderMessage,
  type ProviderSpawner,
  ProviderTimeoutError,
} from "./claude-stream";
import type { RuntimeFailure, RuntimeFailureKind, TokenUsage } from "./types";

/**
 * `LanguageModelV2` adapter that drives `claude -p --output-format
 * stream-json` as a model backend. Stateful per `invoke()`: ordin
 * spawns a fresh subprocess for every `doStream()` call, kills it on
 * the first `tool_use` event, captures the `session_id`, and resumes
 * with `--resume` on the next call. Re-instantiated per run — never
 * shared across invocations.
 *
 * Phase B ships the adapter and unit tests in isolation. Phase C
 * wires it into `ClaudeCliProviderRuntime` and deletes the
 * hand-rolled loop in `claude-cli-provider.ts`.
 */
export interface ClaudeLanguageModelV2Options {
  readonly bin: string;
  readonly model: string;
  readonly modelId?: string;
  readonly fallbackModel?: string;
  readonly cwd: string;
  readonly tier: "S" | "M" | "L";
  readonly harnessRoot?: string;
  readonly mcpConfigPath?: string;
  readonly systemPromptFile?: (streamCount: number) => string;
  readonly timeoutMs?: number;
  readonly spawner?: ProviderSpawner;
  readonly onRawLine?: (line: string) => void;
}

const ZERO_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  cacheReadInput: 0,
  cacheCreationInput: 0,
  totalInput: 0,
};

const defaultSpawner: ProviderSpawner = (bin, args, opts) =>
  spawn(bin, args as string[], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

export class ClaudeLanguageModelV2 implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "claude-cli";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly opts: ClaudeLanguageModelV2Options;
  private readonly spawner: ProviderSpawner;
  private sessionId: string | undefined;
  private streamCount = 0;

  constructor(opts: ClaudeLanguageModelV2Options) {
    this.opts = opts;
    this.spawner = opts.spawner ?? defaultSpawner;
    this.modelId = opts.modelId ?? opts.model;
  }

  doGenerate(_options: LanguageModelV2CallOptions): ReturnType<LanguageModelV2["doGenerate"]> {
    return Promise.reject(
      new Error(
        "ClaudeLanguageModelV2.doGenerate is not implemented; the Claude CLI provider only supports streaming.",
      ),
    );
  }

  async doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    this.streamCount += 1;
    const stepIndex = this.streamCount;
    const { systemPrompt, messages } = splitV2Prompt(options.prompt);
    const toolNames = extractToolNames(options.tools);
    const resumed = !!this.sessionId;
    const turnMessages = resumed ? takeLatest(messages) : messages;

    // Open the per-turn span before any I/O so the active OTel context
    // wraps the whole subprocess lifetime; the subprocess closes the
    // span via the stream's start callback.
    const tracer = trace.getTracer("ordin.claude-cli-provider");
    const turnSpan = tracer.startSpan("ordin.provider.turn", {
      attributes: { "ordin.provider.resumed": resumed },
    });

    const systemPromptFile = this.opts.systemPromptFile?.(stepIndex);
    if (systemPromptFile) await writeFile(systemPromptFile, systemPrompt, "utf8");
    const mcpConfigPath = await this.writeMcpConfig(toolNames);

    const args = this.buildArgs({
      systemPrompt,
      ...(systemPromptFile ? { systemPromptFile } : {}),
      ...(mcpConfigPath ? { mcpConfigPath } : {}),
      toolNames,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });

    const child = this.spawner(this.opts.bin, args, {
      cwd: this.opts.cwd,
      env: process.env,
    });
    child.stdin?.end(renderMessages(turnMessages));

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      turnSpan.end();
      throw new Error("Failed to capture stdio from claude provider subprocess");
    }

    return { stream: this.buildStream(child, stdout, stderr, options, turnSpan) };
  }

  private buildStream(
    child: ProviderChildProcess,
    stdout: NonNullable<ProviderChildProcess["stdout"]>,
    stderr: NonNullable<ProviderChildProcess["stderr"]>,
    options: LanguageModelV2CallOptions,
    turnSpan: Span,
  ): ReadableStream<LanguageModelV2StreamPart> {
    const adapter = this;
    let closed = false;
    const kill = (): void => terminateChild(child, () => closed);
    const finishTurn = (status: "ok" | "error", toolRequested: boolean, error?: string): void => {
      turnSpan.setAttribute("ordin.provider.tool_requested", toolRequested);
      if (status === "error") {
        turnSpan.setStatus({
          code: SpanStatusCode.ERROR,
          ...(error ? { message: error } : {}),
        });
        if (error) turnSpan.setAttribute("ordin.error", error);
      }
      turnSpan.end();
    };

    return new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });

        let textId: string | undefined;
        let toolCall: ClaudeToolCall | undefined;
        let tokens: TokenUsage = ZERO_TOKENS;
        const stderrChunks: string[] = [];
        let timedOut = false;

        const abortHandler = (): void => kill();
        options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
        const timer = adapter.opts.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              kill();
            }, adapter.opts.timeoutMs)
          : undefined;

        const rl = createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY });
        rl.on("line", (line) => {
          if (!line.trim()) return;
          adapter.opts.onRawLine?.(line);
          let interpreted: ReturnType<typeof interpretClaudeStreamLine>;
          try {
            interpreted = interpretClaudeStreamLine(line);
          } catch (err) {
            stderrChunks.push(err instanceof Error ? err.message : String(err));
            return;
          }
          for (const text of interpreted.texts) {
            if (!textId) {
              textId = "claude-text";
              controller.enqueue({ type: "text-start", id: textId });
            }
            controller.enqueue({ type: "text-delta", id: textId, delta: text });
          }
          if (interpreted.tokens) tokens = mergeUsage(tokens, interpreted.tokens);
          if (interpreted.sessionId) adapter.sessionId = interpreted.sessionId;
          if (interpreted.toolCall && !toolCall) {
            toolCall = interpreted.toolCall;
            kill();
          }
        });

        stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          for (const part of text.split(/\r?\n/)) {
            if (part.trim()) stderrChunks.push(part);
          }
        });

        const exitInfo = await new Promise<{ code: number; signal: NodeJS.Signals | null }>(
          (resolveExit) => {
            child.on("close", (code, signal) => {
              closed = true;
              resolveExit({ code: code ?? -1, signal });
            });
            child.on("error", (err) => {
              stderrChunks.push(err.message);
              resolveExit({ code: -1, signal: null });
            });
          },
        );

        if (timer) clearTimeout(timer);
        options.abortSignal?.removeEventListener("abort", abortHandler);

        if (textId) controller.enqueue({ type: "text-end", id: textId });

        if (timedOut) {
          const err = new ProviderTimeoutError(adapter.opts.timeoutMs ?? 0);
          finishTurn("error", false, err.message);
          controller.error(err);
          return;
        }
        if (options.abortSignal?.aborted) {
          finishTurn("error", false, "aborted");
          controller.error(new Error("aborted"));
          return;
        }

        let finishReason: LanguageModelV2FinishReason;
        if (toolCall) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: toolCall.id,
            toolName: ordinToolNameFromClaude(toolCall.name),
            input: JSON.stringify(toolCall.input),
          });
          finishReason = "tool-calls";
        } else if (exitInfo.code !== 0) {
          const message =
            stderrChunks.join("\n").trim() ||
            (exitInfo.signal ? `killed by ${exitInfo.signal}` : `exit ${exitInfo.code}`);
          finishTurn("error", false, message);
          controller.error(new Error(message));
          return;
        } else {
          finishReason = "stop";
        }

        controller.enqueue({
          type: "finish",
          usage: usageToV2(tokens),
          finishReason,
        });
        finishTurn("ok", !!toolCall);
        controller.close();
      },
      cancel() {
        kill();
      },
    });
  }

  private buildArgs(req: {
    readonly systemPrompt: string;
    readonly systemPromptFile?: string;
    readonly mcpConfigPath?: string;
    readonly toolNames: readonly string[];
    readonly sessionId?: string;
  }): string[] {
    const mcpToolNames = req.toolNames.map((name) => claudeMcpToolName(name));
    const args = [
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(req.systemPromptFile
        ? ["--system-prompt-file", req.systemPromptFile]
        : ["--system-prompt", req.systemPrompt]),
      "--model",
      this.opts.model,
      "--effort",
      effortForTier(this.opts.tier),
      "--permission-mode",
      "default",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
    ];
    if (this.opts.fallbackModel) {
      args.push("--fallback-model", this.opts.fallbackModel);
    }
    if (req.sessionId) {
      args.push("--resume", req.sessionId);
    }
    if (req.mcpConfigPath) {
      args.push("--mcp-config", req.mcpConfigPath);
    }
    args.push("--tools", "");
    if (mcpToolNames.length > 0) {
      args.push("--allowed-tools", ...mcpToolNames);
    }
    const proxySettings = buildProxySettings(process.env);
    if (proxySettings) {
      args.push("--settings", proxySettings);
    }
    return args;
  }

  private async writeMcpConfig(toolNames: readonly string[]): Promise<string | undefined> {
    if (!this.opts.harnessRoot || !this.opts.mcpConfigPath) return undefined;
    const toolsFile = this.opts.mcpConfigPath.replace(/\.json$/, ".tools.json");
    await writeFile(toolsFile, JSON.stringify(toolNames), "utf8");
    const config = {
      mcpServers: {
        ordin: {
          command: process.execPath,
          args: [
            join(this.opts.harnessRoot, "src", "worker", "runtimes", "claude-provider-mcp.ts"),
            "--tools-json",
            toolsFile,
          ],
        },
      },
    };
    await writeFile(this.opts.mcpConfigPath, JSON.stringify(config), "utf8");
    return this.opts.mcpConfigPath;
  }
}

function splitV2Prompt(prompt: LanguageModelV2Prompt): {
  systemPrompt: string;
  messages: ProviderMessage[];
} {
  const systemTexts: string[] = [];
  const messages: ProviderMessage[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      systemTexts.push(message.content);
      continue;
    }
    const rendered = renderV2Message(message);
    if (rendered) messages.push(rendered);
  }
  return { systemPrompt: systemTexts.join("\n\n"), messages };
}

function renderV2Message(
  message: Exclude<LanguageModelV2Message, { role: "system" }>,
): ProviderMessage | undefined {
  switch (message.role) {
    case "user": {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter((s) => s.length > 0)
        .join("\n");
      return { role: "user", content: text };
    }
    case "assistant": {
      const parts: string[] = [];
      for (const part of message.content) {
        if (part.type === "text") parts.push(part.text);
        else if (part.type === "tool-call") {
          parts.push(`Requested tool ${part.toolName} with id ${part.toolCallId}.`);
        }
      }
      return { role: "assistant", content: parts.join("\n\n") };
    }
    case "tool": {
      const blocks: string[] = [];
      for (const part of message.content) {
        const output = formatToolOutput(part.output);
        blocks.push(
          [
            `Tool result for ${part.toolName} (${part.toolCallId}):`,
            output || "(no output)",
            "",
            "Continue. If you need another tool, call exactly one tool. Otherwise provide the final answer.",
          ].join("\n"),
        );
      }
      return { role: "user", content: blocks.join("\n\n") };
    }
  }
}

function formatToolOutput(output: LanguageModelV2ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "content":
      return output.value
        .map((entry) => (entry.type === "text" ? entry.text : ""))
        .filter((s) => s.length > 0)
        .join("\n");
    default:
      return "";
  }
}

function extractToolNames(
  tools:
    | ReadonlyArray<LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool>
    | undefined,
): readonly string[] {
  if (!tools) return [];
  const names = new Set<string>();
  for (const tool of tools) names.add(tool.name);
  return [...names];
}

function takeLatest(messages: readonly ProviderMessage[]): ProviderMessage[] {
  const latest = messages[messages.length - 1];
  return latest ? [latest] : [];
}

function renderMessages(messages: readonly ProviderMessage[]): string {
  return messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
}

function claudeMcpToolName(name: string): string {
  return `mcp__ordin__${name}`;
}

/**
 * claude-cli ignores `HTTP_PROXY` / `HTTPS_PROXY` from the process env
 * for its API traffic, but does honor them when set in the `env` block
 * of a `--settings` payload. Under srt the worker inherits the proxy
 * URLs srt set up; we re-stamp them via `--settings` so claude routes
 * to api.anthropic.com through srt's proxy. Without this, claude opens
 * direct TCP that srt's seatbelt profile silently blocks.
 *
 * Returns undefined when no proxy is set so non-srt runs see no
 * extra arg.
 */
function buildProxySettings(env: NodeJS.ProcessEnv): string | undefined {
  const passThrough: Record<string, string> = {};
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    const value = env[key];
    if (value) passThrough[key] = value;
  }
  if (Object.keys(passThrough).length === 0) return undefined;
  return JSON.stringify({ env: passThrough });
}

function ordinToolNameFromClaude(name: string): string {
  const match = /^mcp__ordin__(.+)$/.exec(name);
  return match?.[1] ?? name;
}

function terminateChild(child: ProviderChildProcess, isClosed: () => boolean): void {
  if (isClosed() || child.killed) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!isClosed()) child.kill("SIGKILL");
  }, 1_000).unref();
}

function mergeUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  const input = Math.max(current.input, next.input);
  const cacheReadInput = Math.max(current.cacheReadInput, next.cacheReadInput);
  const cacheCreationInput = Math.max(current.cacheCreationInput, next.cacheCreationInput);
  return {
    input,
    output: current.output + next.output,
    cacheReadInput,
    cacheCreationInput,
    totalInput: input + cacheReadInput + cacheCreationInput,
  };
}

function usageToV2(tokens: TokenUsage): LanguageModelV2Usage {
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    totalTokens: tokens.input + tokens.output,
    cachedInputTokens: tokens.cacheReadInput,
  };
}

/**
 * Tier → Claude `--effort` mapping. Domain exposes the neutral `tier`
 * hint; this module maps it to Claude Code's effort levels.
 */
export function effortForTier(tier: "S" | "M" | "L"): "low" | "medium" | "high" {
  switch (tier) {
    case "S":
      return "low";
    case "M":
      return "medium";
    case "L":
      return "high";
  }
}

export interface ClassifyInput {
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
      : matchAny(["not in allowed-tools", "tool not allowed", "disallowed tool", "is not allowed"])
        ? "tool"
        : matchAny(["model not found", "unknown model", "invalid model"])
          ? "model"
          : matchAny(["timed out", "timeout"])
            ? "timeout"
            : "unknown";

  const retryable = kind === "rate_limit" || kind === "timeout";
  return { kind, message, retryable };
}
