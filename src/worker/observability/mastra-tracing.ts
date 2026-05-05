import { Mastra } from "@mastra/core/mastra";
import {
  type AnyExportedSpan,
  SpanType,
  type TracingEvent,
  TracingEventType,
} from "@mastra/core/observability";
import { BaseExporter, Observability } from "@mastra/observability";
import type { RuntimeEvent } from "../runtimes/types";

/**
 * Sole import site for `@mastra/observability` inside the worker.
 * Runtimes accept a typed `Mastra` container and stay free of
 * Mastra's observability subpackage — vendor wiring stays on one
 * side of the seam.
 *
 * The container's `RuntimeEventTracingExporter` translates Mastra's
 * span lifecycle events into `RuntimeEvent` `timing` entries on the
 * runtime's existing event channel. The worker stays OTel-free; the
 * parent's `phase-runner.ts` already maps `timing` events into OTel
 * child spans under the active `ordin.phase.*` context, so Mastra's
 * chat / tool activity nests correctly in Langfuse without a worker-
 * side SDK.
 *
 * Why custom translation rather than `@mastra/langfuse`'s
 * `LangfuseExporter`: that path needs `@langfuse/core` /
 * `@langfuse/client` running in the worker, which write log lines to
 * stdout via singletons we can't reliably suppress before they
 * snapshot — and worker stdout is the JSONL channel the parent reads
 * as `RuntimeEvent`s. Translating to `timing` events sidesteps the
 * whole vendor-stdout fight.
 *
 * Lives under `worker/observability/` rather than `runtimes/ai-sdk/`
 * because the same container is shared across Mastra-Agent-based
 * runtimes (today AiSdkRuntime; Phase C adds ClaudeCliProviderRuntime).
 * Lives under `src/worker/**` rather than `src/observability/**`
 * because the worker-isolation rule in `dependency-cruiser.config.cjs`
 * forbids the worker reaching into parent-side observability code.
 */

class RuntimeEventTracingExporter extends BaseExporter {
  readonly name = "ordin.runtime-event";

  constructor(private readonly onEvent: (event: RuntimeEvent) => void) {
    super();
  }

  protected override async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type !== TracingEventType.SPAN_ENDED) return;
    const timing = translateSpan(event.exportedSpan);
    if (timing) this.onEvent(timing);
  }
}

function translateSpan(span: AnyExportedSpan): RuntimeEvent | undefined {
  const durationMs = computeDuration(span);
  if (durationMs === undefined) return undefined;
  const status = span.errorInfo ? "error" : "ok";
  const error = span.errorInfo?.message;
  switch (span.type) {
    case SpanType.MODEL_GENERATION:
    case SpanType.MODEL_STEP:
      return {
        type: "timing",
        name: chatSpanName(span),
        durationMs,
        status,
        ...(error ? { error } : {}),
        attributes: chatAttributes(span),
      };
    case SpanType.TOOL_CALL:
    case SpanType.MCP_TOOL_CALL:
      return {
        type: "timing",
        name: `tool ${span.name}`,
        durationMs,
        status,
        ...(error ? { error } : {}),
        attributes: toolAttributes(span),
      };
    default:
      return undefined;
  }
}

function chatSpanName(span: AnyExportedSpan): string {
  const attrs = span.attributes as { model?: string } | undefined;
  return attrs?.model ? `chat ${attrs.model}` : "chat";
}

function chatAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  const attrs = (span.attributes ?? {}) as {
    model?: string;
    provider?: string;
    finishReason?: string;
    streaming?: boolean;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
    };
  };
  const out: Record<string, string | number | boolean> = {};
  if (attrs.model) {
    out["gen_ai.request.model"] = attrs.model;
    out["gen_ai.response.model"] = attrs.model;
  }
  if (attrs.provider) out["gen_ai.system"] = attrs.provider;
  if (attrs.finishReason) out["gen_ai.response.finish_reason"] = attrs.finishReason;
  if (attrs.streaming !== undefined) out["gen_ai.response.streaming"] = attrs.streaming;
  if (attrs.usage?.inputTokens !== undefined) {
    out["gen_ai.usage.input_tokens"] = attrs.usage.inputTokens;
  }
  if (attrs.usage?.outputTokens !== undefined) {
    out["gen_ai.usage.output_tokens"] = attrs.usage.outputTokens;
  }
  if (attrs.usage?.totalTokens !== undefined) {
    out["gen_ai.usage.total_tokens"] = attrs.usage.totalTokens;
  }
  if (attrs.usage?.cachedInputTokens !== undefined) {
    out["gen_ai.usage.cached_input_tokens"] = attrs.usage.cachedInputTokens;
  }
  const input = serializeForLangfuse(span.input);
  const output = serializeForLangfuse(span.output);
  if (input !== undefined) out["langfuse.observation.input"] = input;
  if (output !== undefined) out["langfuse.observation.output"] = output;
  return out;
}

function toolAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    "gen_ai.tool.name": span.name,
  };
  const attrs = (span.attributes ?? {}) as { toolType?: string; success?: boolean };
  if (attrs.toolType) out["gen_ai.tool.type"] = attrs.toolType;
  if (attrs.success !== undefined) out["ordin.tool.success"] = attrs.success;
  const input = serializeForLangfuse(span.input);
  const output = serializeForLangfuse(span.output);
  if (input !== undefined) out["langfuse.observation.input"] = input;
  if (output !== undefined) out["langfuse.observation.output"] = output;
  return out;
}

/**
 * Stringify Mastra's structured span input/output for Langfuse's
 * `observation.input`/`observation.output` attributes. Strings pass
 * through; everything else gets JSON-encoded so messages arrays /
 * tool argument objects render in Langfuse's trace view. Returns
 * undefined for empty values so we don't stamp empty attributes.
 */
function serializeForLangfuse(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function computeDuration(span: AnyExportedSpan): number | undefined {
  if (!span.endTime) return undefined;
  const start =
    span.startTime instanceof Date ? span.startTime.getTime() : Date.parse(String(span.startTime));
  const end =
    span.endTime instanceof Date ? span.endTime.getTime() : Date.parse(String(span.endTime));
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

export type MastraTracingFactory = (onEvent: (event: RuntimeEvent) => void) => Mastra;

export const buildMastraTracingContainer: MastraTracingFactory = (onEvent) =>
  new Mastra({
    // Worker stdout is the JSONL channel the parent reads as
    // `RuntimeEvent`s. Mastra's default `ConsoleLogger` writes to
    // stdout, which corrupts that stream and surfaces parent-side as
    // "[worker] dropped malformed event line". `false` disables
    // Mastra's logger entirely; harness-side observability is the
    // source of truth.
    logger: false,
    observability: new Observability({
      configs: {
        default: {
          serviceName: "ordin",
          exporters: [new RuntimeEventTracingExporter(onEvent)],
        },
      },
    }),
  });
