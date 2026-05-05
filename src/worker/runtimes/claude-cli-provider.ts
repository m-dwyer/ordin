import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { classifyFailure, effortForTier } from "./claude-cli";
import type { ClaudeProviderMcpEntrypoint } from "./claude-provider-mcp";
import { ToolDispatcher } from "./shared/dispatcher";
import { parseToolSpec } from "./shared/tools";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  TokenUsage,
} from "./types";

type _KeepClaudeProviderMcpEntrypointCruised = ClaudeProviderMcpEntrypoint;

const ProviderPhaseOverrideSchema = z.object({
  fallback_model: z.string().min(1).optional(),
  max_steps: z.number().int().positive().optional(),
});

export const ClaudeCliProviderConfigSchema = z.object({
  bin: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
  max_steps: z.number().int().positive().default(40),
  protocol_debug: z.boolean().optional(),
  /**
   * Per-phase Claude-provider knobs. `fallback_model` flows through to
   * `claude -p`. `max_steps` overrides the runtime-wide ceiling — owned
   * by the provider loop, not Claude, since the process is killed after
   * each tool use. Stable runtime's `max_turns` has no analog here.
   */
  phases: z.record(z.string(), ProviderPhaseOverrideSchema).default({}),
});
export type ClaudeCliProviderConfigRaw = z.infer<typeof ClaudeCliProviderConfigSchema>;
export type ClaudeCliProviderPhaseOverride = z.infer<typeof ProviderPhaseOverrideSchema>;

export interface ProviderMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ClaudeToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ClaudeProviderTurn {
  readonly texts: readonly string[];
  readonly toolCall?: ClaudeToolCall;
  readonly tokens: TokenUsage;
  readonly sessionId?: string;
}

export interface ClaudeModelProvider {
  complete(req: {
    readonly systemPrompt: string;
    readonly systemPromptFile?: string;
    readonly mcpConfigFile?: string;
    readonly messages: readonly ProviderMessage[];
    readonly model: string;
    readonly fallbackModel?: string;
    readonly cwd: string;
    readonly tier: "S" | "M" | "L";
    readonly tools: readonly string[];
    readonly sessionId?: string;
    readonly abortSignal?: AbortSignal;
    readonly onRawLine?: (line: string) => void;
  }): Promise<ClaudeProviderTurn>;
}

export interface ClaudeCliProviderRuntimeOptions {
  readonly bin: string;
  readonly harnessRoot?: string;
  readonly timeoutMs?: number;
  readonly maxSteps?: number;
  readonly protocolDebug?: boolean;
  readonly phaseOverrides?: Readonly<Record<string, ClaudeCliProviderPhaseOverride>>;
  readonly runsDirFallback?: string;
  readonly provider?: ClaudeModelProvider;
  readonly dispatcher?: ToolDispatcher;
  readonly spawner?: ProviderSpawner;
}

export type ProviderSpawner = (
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ProviderChildProcess;

export interface ProviderChildProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider turn timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

const ZERO_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  cacheReadInput: 0,
  cacheCreationInput: 0,
};

const defaultSpawner: ProviderSpawner = (bin, args, opts) =>
  spawn(bin, args as string[], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

/**
 * Experimental Claude Max provider adapter. Claude Code is used as a
 * model backend through its stream-json event protocol; ordin owns the
 * tool loop and dispatches through ToolDispatcher.
 */
export class ClaudeCliProviderRuntime implements AgentRuntime {
  readonly name = "claude-cli-provider";
  readonly capabilities: RuntimeCapabilities = {
    nativeSkillDiscovery: false,
    streaming: true,
    mcpSupport: true,
    maxContextTokens: 200_000,
  };

  private readonly harnessRoot?: string;
  private readonly maxSteps: number;
  private readonly protocolDebug: boolean;
  private readonly phaseOverrides: Readonly<Record<string, ClaudeCliProviderPhaseOverride>>;
  private readonly runsDirFallback: string;
  private readonly provider: ClaudeModelProvider;
  private readonly dispatcher: ToolDispatcher;

  constructor(opts: ClaudeCliProviderRuntimeOptions) {
    this.harnessRoot = opts.harnessRoot;
    this.maxSteps = opts.maxSteps ?? 40;
    this.protocolDebug = opts.protocolDebug ?? false;
    this.phaseOverrides = opts.phaseOverrides ?? {};
    this.runsDirFallback = opts.runsDirFallback ?? join(homedir(), ".ordin", "runs");
    this.dispatcher = opts.dispatcher ?? new ToolDispatcher();
    this.provider =
      opts.provider ??
      new ClaudeCliStreamProvider({
        bin: opts.bin,
        ...(opts.harnessRoot ? { harnessRoot: opts.harnessRoot } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        spawner: opts.spawner ?? defaultSpawner,
      });
  }

  static fromConfig(
    raw: unknown,
    extras: Omit<
      ClaudeCliProviderRuntimeOptions,
      "bin" | "timeoutMs" | "maxSteps" | "protocolDebug" | "phaseOverrides"
    > = {},
  ): ClaudeCliProviderRuntime {
    const parsed = ClaudeCliProviderConfigSchema.parse(raw);
    return new ClaudeCliProviderRuntime({
      bin: parsed.bin,
      maxSteps: parsed.max_steps,
      phaseOverrides: parsed.phases,
      ...(parsed.timeout_ms !== undefined ? { timeoutMs: parsed.timeout_ms } : {}),
      ...(parsed.protocol_debug !== undefined ? { protocolDebug: parsed.protocol_debug } : {}),
      ...extras,
    });
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const runDir = req.runDir ?? resolve(this.runsDirFallback, req.runId);
    const transcriptPath = join(runDir, `${req.prompt.phaseId}.jsonl`);
    await mkdir(runDir, { recursive: true });
    const transcript = createWriteStream(transcriptPath, { flags: "a" });
    const started = Date.now();
    const override = this.phaseOverrides[req.prompt.phaseId] ?? {};
    const maxSteps = override.max_steps ?? this.maxSteps;
    const toolNames = req.prompt.tools.map((spec) => parseToolSpec(spec).name);
    const allowedTools = new Set(toolNames);
    const messages: ProviderMessage[] = [{ role: "user", content: req.prompt.userPrompt }];
    let tokens = ZERO_TOKENS;
    let sessionId: string | undefined;

    const emit = (event: RuntimeEvent): void => {
      transcript.write(`${JSON.stringify({ kind: "event", event })}\n`);
      req.onEvent?.(event);
    };
    const debug = (entry: unknown): void => {
      if (this.protocolDebug) transcript.write(`${JSON.stringify({ kind: "protocol", entry })}\n`);
    };

    try {
      for (let step = 1; step <= maxSteps; step++) {
        if (req.abortSignal?.aborted) throw new Error("aborted");
        emit({ type: "assistant.thinking" });
        const turnStarted = Date.now();
        let turn: ClaudeProviderTurn;
        try {
          turn = await this.provider.complete({
            systemPrompt: buildProviderSystemPrompt(req),
            systemPromptFile: join(runDir, `${req.prompt.phaseId}.provider-system.${step}.md`),
            mcpConfigFile: join(runDir, `${req.prompt.phaseId}.provider-mcp.json`),
            messages,
            model: req.prompt.model,
            ...(override.fallback_model && override.fallback_model !== req.prompt.model
              ? { fallbackModel: override.fallback_model }
              : {}),
            cwd: req.prompt.cwd,
            tier: req.prompt.tier,
            tools: toolNames,
            ...(sessionId ? { sessionId } : {}),
            ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
            onRawLine: (line) => debug({ direction: "provider.out", step, line }),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emit({
            type: "timing",
            name: "ordin.provider.turn",
            durationMs: Date.now() - turnStarted,
            status: "error",
            error: message,
            attributes: {
              "ordin.provider.step": step,
              "ordin.provider.resumed": !!sessionId,
              "ordin.provider.tool_requested": false,
            },
          });
          throw err;
        }
        emit({
          type: "timing",
          name: "ordin.provider.turn",
          durationMs: Date.now() - turnStarted,
          status: "ok",
          attributes: {
            "ordin.provider.step": step,
            "ordin.provider.resumed": !!sessionId,
            "ordin.provider.tool_requested": !!turn.toolCall,
          },
        });
        if (turn.sessionId) sessionId = turn.sessionId;
        tokens = mergeUsage(tokens, turn.tokens);
        if (tokens.input || tokens.output || tokens.cacheReadInput || tokens.cacheCreationInput) {
          emit({ type: "tokens", usage: tokens });
        }

        for (const text of turn.texts) {
          if (text.trim()) emit({ type: "assistant.text", text });
        }

        if (!turn.toolCall) {
          await closeStream(transcript);
          return {
            status: "ok",
            exitCode: 0,
            transcriptPath,
            tokens,
            durationMs: Date.now() - started,
          };
        }

        const toolCall = turn.toolCall;
        const ordinToolName = ordinToolNameFromClaude(toolCall.name);
        if (!allowedTools.has(ordinToolName)) {
          throw new Error(`Tool "${ordinToolName}" is not allowed for this phase.`);
        }

        emit({
          type: "tool.use",
          id: toolCall.id,
          name: ordinToolName,
          input: toolCall.input,
        });
        let result: string;
        let toolOk = true;
        const dispatchStarted = Date.now();
        try {
          result = await this.dispatcher.dispatch(ordinToolName, toolCall.input, {
            cwd: req.prompt.cwd,
            skills: req.prompt.skills,
          });
          emit({ type: "tool.result", id: toolCall.id, ok: true, ...(result ? { result } : {}) });
        } catch (err) {
          result = err instanceof Error ? err.message : String(err);
          toolOk = false;
          emit({ type: "tool.result", id: toolCall.id, ok: false, result });
        }
        emit({
          type: "timing",
          name: `ordin.tool.${ordinToolName}`,
          durationMs: Date.now() - dispatchStarted,
          status: toolOk ? "ok" : "error",
          ...(toolOk ? {} : { error: result }),
          attributes: {
            "ordin.tool.name": ordinToolName,
          },
        });

        const assistantText = [
          ...turn.texts,
          `Requested tool ${ordinToolName} with id ${toolCall.id}.`,
        ].join("\n\n");
        messages.push({ role: "assistant", content: assistantText });
        messages.push({
          role: "user",
          content: [
            `Tool result for ${ordinToolName} (${toolCall.id}):`,
            result || "(no output)",
            "",
            "Continue. If you need another tool, call exactly one tool. Otherwise provide the final answer.",
          ].join("\n"),
        });
      }
      throw new Error(`Exceeded max_steps (${maxSteps}) before final response.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message });
      await closeStream(transcript);
      const failure = classifyFailure({
        exitCode: 1,
        signal: null,
        stderr: message,
        timedOut: err instanceof ProviderTimeoutError,
      });
      return {
        status: "failed",
        exitCode: 1,
        transcriptPath,
        tokens,
        durationMs: Date.now() - started,
        failure,
        error: failure.message,
      };
    }
  }
}

export function interpretClaudeStreamLine(line: string): {
  readonly texts: readonly string[];
  readonly thinking: boolean;
  readonly toolCall?: ClaudeToolCall;
  readonly tokens?: TokenUsage;
  readonly sessionId?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed Claude stream-json line: ${message}`);
  }
  if (!parsed || typeof parsed !== "object") return { texts: [], thinking: false };

  const event = parsed as ClaudeStreamEvent;
  const texts: string[] = [];
  let thinking = false;
  let toolCall: ClaudeToolCall | undefined;
  let tokens: TokenUsage | undefined;
  let sessionId: string | undefined;

  if (event.type === "system" && event.subtype === "init" && event.session_id) {
    sessionId = event.session_id;
  } else if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "thinking") {
        thinking = true;
      } else if (block.type === "tool_use" && block.id && block.name) {
        const input =
          block.input && typeof block.input === "object" && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {};
        toolCall = { id: block.id, name: block.name, input };
      }
    }
    if (event.message.usage) tokens = usageFromClaude(event.message.usage);
  } else if (event.type === "result" && event.usage) {
    tokens = usageFromClaude(event.usage);
    if (event.session_id) sessionId = event.session_id;
  }

  return {
    texts,
    thinking,
    ...(toolCall ? { toolCall } : {}),
    ...(tokens ? { tokens } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function buildProviderSystemPrompt(req: InvokeRequest): string {
  const tools = req.prompt.tools.length > 0 ? req.prompt.tools.join(", ") : "(none)";
  const skillSection =
    req.prompt.skills.length > 0
      ? [
          "",
          "## Loaded skills",
          "The phase skills are already loaded below. Do not call a Skill tool and do not read skill files from the harness repo.",
          ...req.prompt.skills.map((skill) =>
            [
              "",
              `### ${skill.name}`,
              "",
              skill.description,
              "",
              "```markdown",
              skill.body,
              "```",
            ].join("\n"),
          ),
        ].join("\n")
      : "";
  return [
    req.prompt.systemPrompt,
    "",
    "You are running inside ordin's experimental Claude provider runtime.",
    "Use the available tools normally when you need repository context or file changes.",
    "ordin, not Claude Code, executes tool calls. Request at most one tool call per turn.",
    "For file tools, use paths relative to the working directory. Do not read or write outside the working directory.",
    "After a tool result is returned, continue from that result. When done, provide the final response as normal text.",
    `Allowed tools for this phase: ${tools}`,
    skillSection,
  ].join("\n");
}

interface ClaudeCliStreamProviderOptions {
  readonly bin: string;
  readonly harnessRoot?: string;
  readonly timeoutMs?: number;
  readonly spawner: ProviderSpawner;
}

class ClaudeCliStreamProvider implements ClaudeModelProvider {
  private readonly bin: string;
  private readonly harnessRoot?: string;
  private readonly timeoutMs?: number;
  private readonly spawner: ProviderSpawner;

  constructor(opts: ClaudeCliStreamProviderOptions) {
    this.bin = opts.bin;
    this.harnessRoot = opts.harnessRoot;
    this.timeoutMs = opts.timeoutMs;
    this.spawner = opts.spawner;
  }

  async complete(req: {
    readonly systemPrompt: string;
    readonly systemPromptFile?: string;
    readonly mcpConfigFile?: string;
    readonly messages: readonly ProviderMessage[];
    readonly model: string;
    readonly fallbackModel?: string;
    readonly cwd: string;
    readonly tier: "S" | "M" | "L";
    readonly tools: readonly string[];
    readonly sessionId?: string;
    readonly abortSignal?: AbortSignal;
    readonly onRawLine?: (line: string) => void;
  }): Promise<ClaudeProviderTurn> {
    if (req.systemPromptFile) await writeFile(req.systemPromptFile, req.systemPrompt, "utf8");
    const mcpConfigFile = await this.writeMcpConfig(req);
    const child = this.spawner(this.bin, this.buildArgs({ ...req, mcpConfigFile }), {
      cwd: req.cwd,
      env: process.env,
    });
    child.stdin?.end(renderMessages(messagesForTurn(req.messages, !!req.sessionId)));
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      throw new Error("Failed to capture stdio from claude provider subprocess");
    }

    const texts: string[] = [];
    let toolCall: ClaudeToolCall | undefined;
    let tokens = ZERO_TOKENS;
    let sessionId = req.sessionId;
    const stderrChunks: string[] = [];
    let closed = false;

    let timedOut = false;
    const kill = (): void => {
      terminateChild(child, () => closed);
    };
    const abortHandler = (): void => kill();
    req.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    const timer = this.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, this.timeoutMs)
      : undefined;

    const rl = createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      req.onRawLine?.(line);
      const interpreted = interpretClaudeStreamLine(line);
      texts.push(...interpreted.texts);
      if (interpreted.tokens) tokens = mergeUsage(tokens, interpreted.tokens);
      if (interpreted.sessionId) sessionId = interpreted.sessionId;
      if (interpreted.toolCall && !toolCall) {
        toolCall = interpreted.toolCall;
        kill();
      }
    });

    stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) stderrChunks.push(line);
      }
    });

    const exitInfo: { code: number; signal: NodeJS.Signals | null } = await new Promise(
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
    req.abortSignal?.removeEventListener("abort", abortHandler);

    if (timedOut) throw new ProviderTimeoutError(this.timeoutMs ?? 0);
    if (req.abortSignal?.aborted) throw new Error("aborted");
    if (!toolCall && exitInfo.code !== 0) {
      const stderr = stderrChunks.join("\n").trim();
      throw new Error(
        stderr || (exitInfo.signal ? `killed by ${exitInfo.signal}` : `exit ${exitInfo.code}`),
      );
    }

    return {
      texts,
      ...(toolCall ? { toolCall } : {}),
      tokens,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private buildArgs(req: {
    readonly systemPrompt: string;
    readonly systemPromptFile?: string;
    readonly mcpConfigFile?: string;
    readonly messages: readonly ProviderMessage[];
    readonly model: string;
    readonly fallbackModel?: string;
    readonly tier: "S" | "M" | "L";
    readonly tools: readonly string[];
    readonly sessionId?: string;
  }): string[] {
    const mcpToolNames = req.tools.map((name) => claudeMcpToolName(name));
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
      req.model,
      "--effort",
      effortForTier(req.tier),
      "--permission-mode",
      "default",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
    ];
    if (req.fallbackModel) {
      args.push("--fallback-model", req.fallbackModel);
    }
    if (req.sessionId) {
      args.push("--resume", req.sessionId);
    }
    if (req.mcpConfigFile) {
      args.push("--mcp-config", req.mcpConfigFile);
    }
    args.push("--tools", "");
    if (mcpToolNames.length > 0) {
      args.push("--allowed-tools", ...mcpToolNames);
    }
    return args;
  }

  private async writeMcpConfig(req: {
    readonly tools: readonly string[];
    readonly mcpConfigFile?: string;
  }): Promise<string | undefined> {
    if (!this.harnessRoot || !req.mcpConfigFile) return undefined;
    const toolsFile = req.mcpConfigFile.replace(/\.json$/, ".tools.json");
    await writeFile(toolsFile, JSON.stringify(req.tools), "utf8");
    const config = {
      mcpServers: {
        ordin: {
          command: process.execPath,
          args: [
            join(this.harnessRoot, "src", "worker", "runtimes", "claude-provider-mcp.ts"),
            "--tools-json",
            toolsFile,
          ],
        },
      },
    };
    await writeFile(req.mcpConfigFile, JSON.stringify(config), "utf8");
    return req.mcpConfigFile;
  }
}

function renderMessages(messages: readonly ProviderMessage[]): string {
  return messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
}

function messagesForTurn(
  messages: readonly ProviderMessage[],
  resumed: boolean,
): readonly ProviderMessage[] {
  if (!resumed) return messages;
  const latest = messages[messages.length - 1];
  return latest ? [latest] : [];
}

function claudeMcpToolName(name: string): string {
  return `mcp__ordin__${name}`;
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

function usageFromClaude(usage: ClaudeUsage): TokenUsage {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheReadInput: usage.cache_read_input_tokens ?? 0,
    cacheCreationInput: usage.cache_creation_input_tokens ?? 0,
  };
}

function mergeUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    input: Math.max(current.input, next.input),
    output: current.output + next.output,
    cacheReadInput: Math.max(current.cacheReadInput, next.cacheReadInput),
    cacheCreationInput: Math.max(current.cacheCreationInput, next.cacheCreationInput),
  };
}

function closeStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    stream.once("finish", () => resolveClose());
    stream.once("error", rejectClose);
    stream.end();
  });
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ClaudeContentBlock[]; usage?: ClaudeUsage };
  usage?: ClaudeUsage;
}
interface ClaudeContentBlock {
  type?: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
