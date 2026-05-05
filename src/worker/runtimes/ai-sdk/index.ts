import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { z } from "zod";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
  RuntimeEvent,
} from "../types";
import { buildTools } from "./tools";

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

  constructor(config: AiSdkRuntimeConfig = {}) {
    this.baseUrl = config.baseUrl ?? "http://localhost:4000";
    this.apiKey = config.apiKey ?? "unset";
    this.runsDir = config.runsDir ?? join(homedir(), ".ordin", "runs");
    this.modelMap = config.modelMap ?? new Map();
    this.maxSteps = config.maxSteps ?? 40;
    this.bypassCache = config.bypassCache ?? false;
    this.modelOverride = config.model;
  }

  static fromConfig(raw: unknown, extras: Pick<AiSdkRuntimeConfig, "runsDir"> = {}): AiSdkRuntime {
    const parsed = AiSdkRuntimeConfigSchema.parse(raw ?? {});
    const apiKey = parsed.api_key_env ? process.env[parsed.api_key_env] : parsed.api_key;
    return new AiSdkRuntime({
      ...(parsed.base_url ? { baseUrl: parsed.base_url } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(parsed.runs_dir ? { runsDir: parsed.runs_dir } : extras),
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
    const tokens = { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 };

    const modelId = this.modelMap.get(req.prompt.model) ?? req.prompt.model;
    const model = this.modelOverride ?? this.buildModel(modelId);

    const tools = buildTools(req.prompt.cwd, req.prompt.tools, req.prompt.skills);
    const agent = new Agent({
      id: `ordin.${req.prompt.phaseId}`,
      name: `ordin.${req.prompt.phaseId}`,
      instructions: req.prompt.systemPrompt,
      model,
      tools,
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
    tokens: { input: number; output: number; cacheReadInput: number; cacheCreationInput: number },
    emit: (e: RuntimeEvent) => void,
  ): void {
    if (step.text) emit({ type: "assistant.text", text: step.text });
    if (Array.isArray(step.reasoning) && step.reasoning.length > 0) {
      emit({ type: "assistant.thinking" });
    }

    for (const call of step.toolCalls ?? []) {
      emit({
        type: "tool.use",
        id: call.payload.toolCallId,
        name: call.payload.toolName,
        input: call.payload.args,
      });
    }
    for (const r of step.toolResults ?? []) {
      const output = typeof r.payload.result === "string" ? r.payload.result : undefined;
      emit({
        type: "tool.result",
        id: r.payload.toolCallId,
        ok: !r.payload.isError,
        ...(output ? { result: output } : {}),
      });
    }
    // Mastra (like AI SDK v6) reports tool execution failures as
    // `content` entries with `type === "tool-error"`, not in
    // `toolResults`. Surface those as ok:false so a thrown
    // tool.execute (e.g. Read on a directory) doesn't silently
    // disappear from the transcript.
    for (const part of step.content ?? []) {
      if (part.type !== "tool-error") continue;
      const error = (part as { error?: unknown }).error;
      const message = error instanceof Error ? error.message : String(error ?? "tool failed");
      const id = (part as { toolCallId?: string }).toolCallId ?? "";
      emit({ type: "tool.result", id, ok: false, result: message });
    }

    const u = step.usage;
    if (u) {
      tokens.input = Math.max(tokens.input, u.inputTokens ?? 0);
      tokens.output += u.outputTokens ?? 0;
      tokens.cacheReadInput = Math.max(tokens.cacheReadInput, u.cachedInputTokens ?? 0);
      emit({ type: "tokens", usage: { ...tokens } });
    }
  }
}

interface MastraStepLike {
  readonly text?: string;
  readonly reasoning?: ReadonlyArray<unknown>;
  readonly toolCalls?: ReadonlyArray<MastraStepCallLike>;
  readonly toolResults?: ReadonlyArray<MastraStepResultLike>;
  readonly content?: ReadonlyArray<{ type: string; toolCallId?: string; error?: unknown }>;
  readonly usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
}

interface MastraStepCallLike {
  readonly payload: { toolCallId: string; toolName: string; args?: unknown };
}

interface MastraStepResultLike {
  readonly payload: { toolCallId: string; result?: unknown; isError?: boolean };
}
