import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { z } from "zod";
import type { BrokerClient } from "../../broker/client/types";
import type { MastraTracingFactory } from "../observability/mastra-tracing";
import { classifyFailure } from "./claude-cli";
import { ClaudeLanguageModelV2 } from "./claude-language-model-v2";
import type { ClaudeProviderMcpEntrypoint } from "./claude-provider-mcp";
import type { ProviderSpawner } from "./claude-stream";
import { buildDispatcherTools } from "./shared/mastra-tools";
import { parseToolSpec } from "./shared/tools";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
  RuntimeEvent,
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
   * by the Mastra Agent loop, not Claude, since the subprocess is
   * killed after each tool use. Stable runtime's `max_turns` has no
   * analog here.
   */
  phases: z.record(z.string(), ProviderPhaseOverrideSchema).default({}),
});
export type ClaudeCliProviderConfigRaw = z.infer<typeof ClaudeCliProviderConfigSchema>;
export type ClaudeCliProviderPhaseOverride = z.infer<typeof ProviderPhaseOverrideSchema>;

export interface ClaudeCliProviderRuntimeOptions {
  readonly bin: string;
  readonly harnessRoot?: string;
  readonly timeoutMs?: number;
  readonly maxSteps?: number;
  readonly protocolDebug?: boolean;
  readonly phaseOverrides?: Readonly<Record<string, ClaudeCliProviderPhaseOverride>>;
  readonly runsDirFallback?: string;
  readonly broker: BrokerClient;
  readonly spawner?: ProviderSpawner;
  readonly mastraTracing?: MastraTracingFactory;
  readonly parentTraceId?: string;
  readonly parentSpanId?: string;
}

/**
 * Experimental Claude Max provider adapter. Claude Code is used as a
 * model backend through its stream-json event protocol; ordin owns
 * the agent loop via Mastra's `Agent` running against
 * `ClaudeLanguageModelV2` with tools dispatched through the broker
 * (ADR-016).
 */
export class ClaudeCliProviderRuntime implements AgentRuntime {
  readonly name = "claude-cli-provider";
  readonly capabilities: RuntimeCapabilities = {
    nativeSkillDiscovery: false,
    streaming: true,
    mcpSupport: true,
    maxContextTokens: 200_000,
  };

  private readonly bin: string;
  private readonly harnessRoot?: string;
  private readonly timeoutMs?: number;
  private readonly maxSteps: number;
  private readonly protocolDebug: boolean;
  private readonly phaseOverrides: Readonly<Record<string, ClaudeCliProviderPhaseOverride>>;
  private readonly runsDirFallback: string;
  private readonly broker: BrokerClient;
  private readonly spawner: ProviderSpawner | undefined;
  private readonly mastraTracing: MastraTracingFactory | undefined;
  private readonly parentTraceId: string | undefined;
  private readonly parentSpanId: string | undefined;

  constructor(opts: ClaudeCliProviderRuntimeOptions) {
    this.bin = opts.bin;
    this.harnessRoot = opts.harnessRoot;
    this.timeoutMs = opts.timeoutMs;
    this.maxSteps = opts.maxSteps ?? 40;
    this.protocolDebug = opts.protocolDebug ?? false;
    this.phaseOverrides = opts.phaseOverrides ?? {};
    this.runsDirFallback = opts.runsDirFallback ?? join(homedir(), ".ordin", "runs");
    this.broker = opts.broker;
    this.spawner = opts.spawner;
    this.mastraTracing = opts.mastraTracing;
    this.parentTraceId = opts.parentTraceId;
    this.parentSpanId = opts.parentSpanId;
  }

  static fromConfig(
    raw: unknown,
    extras: Omit<
      ClaudeCliProviderRuntimeOptions,
      "bin" | "timeoutMs" | "maxSteps" | "protocolDebug" | "phaseOverrides"
    >,
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
    const toolNames = [...new Set(req.prompt.tools.map((spec) => parseToolSpec(spec).name))];
    if (req.prompt.skills.length > 0 && !toolNames.includes("Skill")) {
      toolNames.push("Skill");
    }
    const tokens = { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0, totalInput: 0 };

    const emit = (event: RuntimeEvent): void => {
      transcript.write(`${JSON.stringify({ kind: "event", event })}\n`);
      req.onEvent?.(event);
    };
    const debug = (entry: unknown): void => {
      if (this.protocolDebug) transcript.write(`${JSON.stringify({ kind: "protocol", entry })}\n`);
    };

    const model: MastraModelConfig = new ClaudeLanguageModelV2({
      bin: this.bin,
      model: req.prompt.model,
      ...(override.fallback_model && override.fallback_model !== req.prompt.model
        ? { fallbackModel: override.fallback_model }
        : {}),
      cwd: req.prompt.cwd,
      tier: req.prompt.tier,
      ...(this.harnessRoot ? { harnessRoot: this.harnessRoot } : {}),
      mcpConfigPath: join(runDir, `${req.prompt.phaseId}.provider-mcp.json`),
      systemPromptFile: (step) => join(runDir, `${req.prompt.phaseId}.provider-system.${step}.md`),
      ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.spawner ? { spawner: this.spawner } : {}),
      onRawLine: (line) => debug({ direction: "provider.out", line }),
      onEvent: emit,
    });

    const tools = buildDispatcherTools(toolNames, {
      cwd: req.prompt.cwd,
      skills: req.prompt.skills,
      broker: this.broker,
      runId: req.runId,
      phaseId: req.prompt.phaseId,
      onEvent: emit,
    });

    const mastra = this.mastraTracing?.(emit);
    const agent = new Agent({
      id: `ordin.${req.prompt.phaseId}`,
      name: `ordin.${req.prompt.phaseId}`,
      instructions: buildProviderSystemPrompt(req, toolNames),
      model,
      tools,
      ...(mastra ? { mastra } : {}),
    });

    let status: "ok" | "failed" = "ok";
    let exitCode = 0;
    let errorText: string | undefined;
    try {
      const output = await agent.stream(req.prompt.userPrompt, {
        maxSteps,
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
        onStepFinish: (step) => {
          emitStep(step, tokens, emit);
        },
        tracingOptions: {
          metadata: {
            "ordin.run_id": req.runId,
            "ordin.phase_id": req.prompt.phaseId,
            "ordin.model": req.prompt.model,
            "ordin.runtime": "claude-cli-provider",
            "langfuse.sessionId": req.runId,
          },
          ...(this.parentTraceId ? { traceId: this.parentTraceId } : {}),
          ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
        },
      });
      await output.consumeStream();
      const streamErr = output.error;
      if (streamErr) {
        throw streamErr;
      }
    } catch (err) {
      status = "failed";
      exitCode = 1;
      errorText = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: errorText });
    } finally {
      transcript.end();
    }

    if (status === "failed") {
      const failure = classifyFailure({
        exitCode: 1,
        signal: null,
        stderr: errorText ?? "",
        timedOut: false,
      });
      return {
        status,
        exitCode,
        transcriptPath,
        tokens: { ...tokens },
        durationMs: Date.now() - started,
        failure,
        error: failure.message,
      };
    }

    return {
      status,
      exitCode,
      transcriptPath,
      tokens: { ...tokens },
      durationMs: Date.now() - started,
    };
  }
}

function buildProviderSystemPrompt(req: InvokeRequest, allowedTools: readonly string[]): string {
  const tools = allowedTools.length > 0 ? allowedTools.join(", ") : "(none)";
  return [
    req.prompt.systemPrompt,
    "",
    "You are running inside ordin's experimental Claude provider runtime.",
    "Use the available tools normally when you need repository context or file changes.",
    "ordin, not Claude Code, executes tool calls. Request at most one tool call per turn.",
    "For file tools, use paths relative to the working directory. Do not read or write outside the working directory.",
    "After a tool result is returned, continue from that result. When done, provide the final response as normal text.",
    `Allowed tools for this phase: ${tools}`,
  ].join("\n");
}

interface MastraStepLike {
  readonly text?: string;
  readonly content?: ReadonlyArray<{ type: string }>;
  readonly usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
}

function emitStep(
  step: MastraStepLike,
  tokens: {
    input: number;
    output: number;
    cacheReadInput: number;
    cacheCreationInput: number;
    totalInput: number;
  },
  emit: (e: RuntimeEvent) => void,
): void {
  if (step.text?.trim()) {
    emit({ type: "assistant.text", text: step.text });
  }
  const u = step.usage;
  if (u) {
    tokens.input = Math.max(tokens.input, u.inputTokens ?? 0);
    tokens.output += u.outputTokens ?? 0;
    tokens.cacheReadInput = Math.max(tokens.cacheReadInput, u.cachedInputTokens ?? 0);
    tokens.totalInput = tokens.input + tokens.cacheReadInput + tokens.cacheCreationInput;
    if (tokens.input || tokens.output || tokens.cacheReadInput) {
      emit({ type: "tokens", usage: { ...tokens } });
    }
  }
}
