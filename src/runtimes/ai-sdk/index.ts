import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type StepResult, stepCountIs, type ToolSet } from "ai";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
  RuntimeEvent,
} from "../types";
import { buildTools } from "./tools";

/**
 * In-process runtime driven by the Vercel AI SDK against any
 * OpenAI-compatible provider. Today's default is the LiteLLM proxy
 * (Phase 4 eval); swap `baseUrl` to hit OpenAI, Ollama direct, or any
 * other compatible gateway — runtime code doesn't change.
 *
 * The AI SDK owns the tool loop, retries, abort semantics, and step
 * events. This class handles: capability declaration, prompt shaping,
 * step → `RuntimeEvent` mapping, transcript persistence. ClaudeCliRuntime
 * is the production counterpart (subprocess `claude -p` on Max plan); the
 * orchestrator is indifferent to which runs a phase.
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
}

export class AiSdkRuntime implements AgentRuntime {
  readonly name = "ai-sdk";
  readonly capabilities: RuntimeCapabilities = {
    nativeSkillDiscovery: false,
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

  constructor(config: AiSdkRuntimeConfig = {}) {
    this.baseUrl = config.baseUrl ?? "http://localhost:4000";
    this.apiKey = config.apiKey ?? "unset";
    this.runsDir = config.runsDir ?? join(homedir(), ".ordin", "runs");
    this.modelMap = config.modelMap ?? new Map();
    this.maxSteps = config.maxSteps ?? 40;
    this.bypassCache = config.bypassCache ?? false;
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
    const provider = createOpenAICompatible({
      name: "ai-sdk-runtime",
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
      ...(this.bypassCache ? { headers: { "cache-control": "no-cache" } } : {}),
    });

    const started = Date.now();
    let status: "ok" | "failed" = "ok";
    let errorText: string | undefined;
    let exitCode = 0;

    try {
      await generateText({
        model: provider.chatModel(modelId),
        system: req.prompt.systemPrompt,
        prompt: req.prompt.userPrompt,
        tools: buildTools(req.prompt.cwd, req.prompt.tools),
        stopWhen: stepCountIs(this.maxSteps),
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
        onStepFinish: (step) => this.onStep(step, tokens, emit),
      });
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

  private onStep(
    step: StepResult<ToolSet>,
    tokens: { input: number; output: number; cacheReadInput: number; cacheCreationInput: number },
    emit: (e: RuntimeEvent) => void,
  ): void {
    if (step.text) emit({ type: "assistant.text", text: step.text });
    if (step.reasoningText) emit({ type: "assistant.thinking" });

    for (const call of step.toolCalls) {
      emit({ type: "tool.use", id: call.toolCallId, name: call.toolName, input: call.input });
    }
    for (const result of step.toolResults) {
      const preview = typeof result.output === "string" ? previewLines(result.output) : undefined;
      const hasError = "error" in result && result.error !== undefined;
      emit({
        type: "tool.result",
        id: result.toolCallId,
        ok: !hasError,
        ...(preview ? { preview } : {}),
      });
    }

    const u = step.usage;
    if (u) {
      tokens.input = Math.max(tokens.input, u.inputTokens ?? 0);
      tokens.output += u.outputTokens ?? 0;
      tokens.cacheReadInput = Math.max(
        tokens.cacheReadInput,
        u.inputTokenDetails?.cacheReadTokens ?? 0,
      );
      tokens.cacheCreationInput = Math.max(
        tokens.cacheCreationInput,
        u.inputTokenDetails?.cacheWriteTokens ?? 0,
      );
      emit({ type: "tokens", usage: { ...tokens } });
    }
  }
}

function previewLines(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 160)}…`;
}
