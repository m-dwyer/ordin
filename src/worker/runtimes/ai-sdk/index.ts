import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { z } from "zod";
import type { BrokerClient } from "../../../broker/client/types";
import type { MastraTracingFactory } from "../../observability/mastra-tracing";
import { buildDispatcherTools } from "../shared/mastra-tools";
import { parseToolSpec } from "../shared/tools";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
  RuntimeEvent,
} from "../types";

/**
 * In-process runtime driven by Mastra's `Agent` against any
 * OpenAI-compatible provider (Mastra wraps the AI SDK internally).
 * Today's default backs onto the LiteLLM proxy (Phase 4 eval); swap
 * `baseUrl` to hit OpenAI, Ollama direct, or any other compatible
 * gateway — runtime code doesn't change.
 *
 * Mastra owns the tool loop, retries, abort semantics, and step events.
 * This class adapts Mastra's per-step callbacks into the harness's
 * `RuntimeEvent` stream. The Mastra-Agent boundary is the same one
 * used at the workflow layer (`MastraEngine`); aligning both layers
 * behind one library means the eventual LangGraph swap is a single
 * substitution at each level.
 */
export interface AiSdkRuntimeConfig {
  /** OpenAI-compatible provider URL. Default: LiteLLM proxy at localhost:4000. */
  baseUrl?: string;
  /** API key; providers without auth (local LiteLLM) ignore it. */
  apiKey?: string;
  /** Where transcripts are persisted. Defaults to ~/.ordin/runs. */
  runsDir?: string;
  /**
   * Optional escape hatch for aliasing composer-side model names to
   * provider-side ones. The default setup uses matching names on both
   * sides (LiteLLM's `model_list` entries named after the harness-side
   * model names in `ordin.config.yaml`), so no rewrite is needed. Only
   * useful if you deliberately want non-matching names — most callers
   * leave this undefined.
   */
  modelMap?: ReadonlyMap<string, string>;
  /** Hard ceiling on tool-loop steps. Default 40. */
  maxSteps?: number;
  /**
   * When true, a no-cache header is sent so a caching provider (LiteLLM)
   * bypasses its cache. Used by `ordin eval --real-models`.
   */
  bypassCache?: boolean;
  /**
   * Test-only escape hatch: drop in a pre-built Mastra-compatible
   * model (e.g. `MockLanguageModelV3` from `ai/test`). When set,
   * `baseUrl` / `apiKey` / `modelMap` are unused — the supplied model
   * receives every `doStream` call. Production paths leave this
   * undefined and the OpenAI-compatible provider is built per-invoke.
   */
  model?: MastraModelConfig;
  /**
   * Mastra container factory used to wire vendor-specific
   * observability (today: a `LangfuseExporter` pointed at the
   * harness's broker). The factory lives in
   * `src/worker/observability/mastra-tracing.ts`; the runtime never
   * imports `@mastra/langfuse` or `@mastra/observability` directly.
   * Leave undefined and Agent runs without observability wiring.
   */
  mastraTracing?: MastraTracingFactory;
  /**
   * Parent OTel trace context, used by Mastra's `tracingOptions` so
   * spans emitted by Mastra (chat / tool calls forwarded to Langfuse
   * by `LangfuseExporter`) nest under the active `ordin.phase.*`
   * span instead of producing a sibling trace tree. Threaded through
   * by the worker entry from W3C `TRACEPARENT`.
   */
  parentTraceId?: string;
  parentSpanId?: string;
  /**
   * Broker client used by the shared Mastra tool builder. Required:
   * tool dispatch authority lives in the broker (ADR-016) — there is
   * no in-runtime fallback. Tests inject a fake; the harness wires an
   * `InProcessBrokerClient` for passthrough runs.
   */
  broker: BrokerClient;
}

export const AiSdkRuntimeConfigSchema = z.object({
  /** OpenAI-compatible provider URL. Default: LiteLLM proxy at localhost:4000. */
  base_url: z.string().url().optional(),
  /**
   * API key value. Prefer `api_key_env` for local configs so secrets
   * stay out of YAML.
   */
  api_key: z.string().optional(),
  /** Environment variable to read for the API key. */
  api_key_env: z.string().min(1).optional(),
  /** Where transcripts are persisted. Defaults to the harness run store. */
  runs_dir: z.string().optional(),
  /** Hard ceiling on tool-loop steps. Default 40. */
  max_steps: z.number().int().positive().optional(),
  /** Send a no-cache header to providers that support it. */
  bypass_cache: z.boolean().optional(),
});
export type AiSdkRuntimeConfigRaw = z.infer<typeof AiSdkRuntimeConfigSchema>;

export class AiSdkRuntime implements AgentRuntime {
  readonly name = "ai-sdk";
  readonly capabilities: RuntimeCapabilities = {
    nativeSkillDiscovery: true,
    streaming: false,
    mcpSupport: false,
    maxContextTokens: 200_000,
  };

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly runsDir: string;
  private readonly modelMap: ReadonlyMap<string, string>;
  private readonly maxSteps: number;
  private readonly bypassCache: boolean;
  private readonly modelOverride: MastraModelConfig | undefined;
  private readonly mastraTracing: MastraTracingFactory | undefined;
  private readonly parentTraceId: string | undefined;
  private readonly parentSpanId: string | undefined;
  private readonly broker: BrokerClient;

  constructor(config: AiSdkRuntimeConfig) {
    this.baseUrl = config.baseUrl ?? "http://localhost:4000";
    this.apiKey = config.apiKey ?? "unset";
    this.runsDir = config.runsDir ?? join(homedir(), ".ordin", "runs");
    this.modelMap = config.modelMap ?? new Map();
    this.maxSteps = config.maxSteps ?? 40;
    this.bypassCache = config.bypassCache ?? false;
    this.modelOverride = config.model;
    this.mastraTracing = config.mastraTracing;
    this.parentTraceId = config.parentTraceId;
    this.parentSpanId = config.parentSpanId;
    this.broker = config.broker;
  }

  static fromConfig(
    raw: unknown,
    extras: Pick<
      AiSdkRuntimeConfig,
      "runsDir" | "mastraTracing" | "parentTraceId" | "parentSpanId" | "broker"
    >,
  ): AiSdkRuntime {
    const parsed = AiSdkRuntimeConfigSchema.parse(raw ?? {});
    const apiKey = parsed.api_key_env ? process.env[parsed.api_key_env] : parsed.api_key;
    return new AiSdkRuntime({
      ...extras,
      ...(parsed.base_url ? { baseUrl: parsed.base_url } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(parsed.runs_dir ? { runsDir: parsed.runs_dir } : {}),
      ...(parsed.max_steps !== undefined ? { maxSteps: parsed.max_steps } : {}),
      ...(parsed.bypass_cache !== undefined ? { bypassCache: parsed.bypass_cache } : {}),
    });
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const runDir = req.runDir ?? resolve(this.runsDir, req.runId);
    const transcriptPath = join(runDir, `${req.prompt.phaseId}.jsonl`);
    await mkdir(runDir, { recursive: true });

    const transcript = createWriteStream(transcriptPath, { flags: "a" });
    const emit = (event: RuntimeEvent): void => {
      req.onEvent?.(event);
      transcript.write(`${JSON.stringify({ kind: "event", event })}\n`);
    };

    // Mutable accumulator; we emit frozen TokenUsage snapshots on each step.
    const tokens = { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0, totalInput: 0 };

    const modelId = this.modelMap.get(req.prompt.model) ?? req.prompt.model;
    const model = this.modelOverride ?? this.buildModel(modelId);

    const toolNames = [...new Set(req.prompt.tools.map((spec) => parseToolSpec(spec).name))];
    const tools = buildDispatcherTools(toolNames, {
      cwd: req.prompt.cwd,
      skills: req.prompt.skills,
      broker: this.broker,
      runId: req.runId,
      phaseId: req.prompt.phaseId,
      allowedTools: toolNames,
      onEvent: emit,
    });
    const mastra = this.mastraTracing?.(emit);
    const agent = new Agent({
      id: `ordin.${req.prompt.phaseId}`,
      name: `ordin.${req.prompt.phaseId}`,
      instructions: req.prompt.systemPrompt,
      model,
      tools,
      ...(mastra ? { mastra } : {}),
    });

    const started = Date.now();
    let status: "ok" | "failed" = "ok";
    let errorText: string | undefined;
    let exitCode = 0;

    try {
      const output = await agent.stream(req.prompt.userPrompt, {
        maxSteps: this.maxSteps,
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
        onStepFinish: (step) => {
          this.emitStep(step, tokens, emit);
        },
        tracingOptions: {
          metadata: {
            "ordin.run_id": req.runId,
            "ordin.phase_id": req.prompt.phaseId,
            "ordin.model": req.prompt.model,
            "ordin.runtime": "ai-sdk",
            "ordin.base_url": this.baseUrl,
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

    return {
      status,
      exitCode,
      transcriptPath,
      tokens: { ...tokens },
      durationMs: Date.now() - started,
      ...(errorText ? { error: errorText } : {}),
    };
  }

  private buildModel(modelId: string): MastraModelConfig {
    // `includeUsage: true` opts the underlying OpenAI Chat Completions
    // request into `stream_options.include_usage: true`, so the final
    // SSE chunk carries token counts. Without this, streaming responses
    // skip usage and ordin's per-phase token totals collapse to zero —
    // generateText (doGenerate) always returned usage; Agent.stream
    // (doStream) does not.
    const provider = createOpenAICompatible({
      name: "ai-sdk-runtime",
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
      includeUsage: true,
      ...(this.bypassCache ? { headers: { "cache-control": "no-cache" } } : {}),
    });
    return provider.chatModel(modelId);
  }

  private emitStep(
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
    if (step.text) emit({ type: "assistant.text", text: step.text });
    if (Array.isArray(step.reasoning) && step.reasoning.length > 0) {
      emit({ type: "assistant.thinking" });
    }
    const u = step.usage;
    if (u) {
      tokens.input = Math.max(tokens.input, u.inputTokens ?? 0);
      tokens.output += u.outputTokens ?? 0;
      tokens.cacheReadInput = Math.max(tokens.cacheReadInput, u.cachedInputTokens ?? 0);
      tokens.totalInput = tokens.input + tokens.cacheReadInput + tokens.cacheCreationInput;
      emit({ type: "tokens", usage: { ...tokens } });
    }
  }
}

interface MastraStepLike {
  readonly text?: string;
  readonly reasoning?: ReadonlyArray<unknown>;
  readonly usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
}
