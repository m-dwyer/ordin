import { Mastra } from "@mastra/core/mastra";
import {
  type AnyExportedSpan,
  SpanType,
  type TracingEvent,
  TracingEventType,
} from "@mastra/core/observability";
import { BaseExporter, Observability } from "@mastra/observability";
import {
  type Span as OtelSpan,
  context as otelContext,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

/**
 * Sole import site for `@mastra/observability` inside the worker.
 * Mastra's tracing pipeline notifies this exporter on every span
 * lifecycle event; we translate those into native OpenTelemetry spans
 * so Langfuse renders the natural hierarchy without parent-side
 * reconstruction (ADR-017 / Phase D).
 *
 * Why we maintain our own Mastra-id → OTel-Span map: Mastra emits
 * spans inside its own pipeline, but the SDK's "active span" context
 * during exporter callbacks is whatever the parent caller had set —
 * not Mastra's nested span. We need to wire the parent–child edges
 * explicitly using Mastra's own `id` / `parentSpanId` references so
 * Mastra's hierarchy survives the OTel translation.
 *
 * Map lifecycle:
 *   - SPAN_STARTED: create an OTel span. Parent = mapped OTel span if
 *     `parentSpanId` is in the map, else the currently-active OTel
 *     context (the caller's `ordin.phase.*` span in passthrough; the
 *     TRACEPARENT-derived context in the worker).
 *   - SPAN_ENDED: stamp final attributes / status, end the span,
 *     drop it from the map.
 *
 * Lives under `worker/observability/` because the worker (in HTTP-
 * transport mode) value-imports it; the harness (in passthrough mode)
 * value-imports it too via the `worker-isolation` deps exception so
 * the same factory threads through both modes.
 */

const TRACER_NAME = "ordin.mastra";
const TRACER_VERSION = "0.1.0";

class OtelMastraExporter extends BaseExporter {
  readonly name = "ordin.otel-mastra";

  /** Mastra `id` → live OTel span we created on its behalf. */
  private readonly active = new Map<string, OtelSpan>();

  protected override async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type === TracingEventType.SPAN_STARTED) {
      this.startSpan(event.exportedSpan);
      return;
    }
    if (event.type === TracingEventType.SPAN_ENDED) {
      this.endSpan(event.exportedSpan);
    }
  }

  private startSpan(span: AnyExportedSpan): void {
    const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
    const parentOtel = span.parentSpanId ? this.active.get(span.parentSpanId) : undefined;
    const parentCtx = parentOtel
      ? trace.setSpan(otelContext.active(), parentOtel)
      : otelContext.active();
    const startTime = toEpochMillis(span.startTime);
    const otelSpan = tracer.startSpan(
      spanName(span),
      {
        attributes: spanAttributes(span),
        ...(startTime !== undefined ? { startTime } : {}),
      },
      parentCtx,
    );
    this.active.set(span.id, otelSpan);
  }

  private endSpan(span: AnyExportedSpan): void {
    const otelSpan = this.active.get(span.id);
    if (!otelSpan) return;
    otelSpan.setAttributes(spanFinalAttributes(span));
    if (span.errorInfo) {
      otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        ...(span.errorInfo.message ? { message: span.errorInfo.message } : {}),
      });
    }
    const endTime = toEpochMillis(span.endTime);
    if (endTime !== undefined) otelSpan.end(endTime);
    else otelSpan.end();
    this.active.delete(span.id);
  }
}

/**
 * Static attributes derived from the span at start time.
 */
function spanAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  switch (span.type) {
    case SpanType.MODEL_GENERATION:
    case SpanType.MODEL_STEP:
      return chatStartAttributes(span);
    case SpanType.TOOL_CALL:
    case SpanType.MCP_TOOL_CALL:
      return toolStartAttributes(span);
    default:
      return {};
  }
}

/**
 * Final attributes derived once the span has ended (output, finish
 * reason, usage breakdowns). Set in `setAttributes` after the OTel
 * span has been created so the exporter sees the closed-over state.
 */
function spanFinalAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  switch (span.type) {
    case SpanType.MODEL_GENERATION:
    case SpanType.MODEL_STEP:
      return chatFinalAttributes(span);
    case SpanType.TOOL_CALL:
    case SpanType.MCP_TOOL_CALL:
      return toolFinalAttributes(span);
    default:
      return {};
  }
}

function spanName(span: AnyExportedSpan): string {
  if (span.type === SpanType.MODEL_GENERATION || span.type === SpanType.MODEL_STEP) {
    const model = (span.attributes as { model?: string } | undefined)?.model;
    return model ? `chat ${model}` : "chat";
  }
  if (span.type === SpanType.TOOL_CALL || span.type === SpanType.MCP_TOOL_CALL) {
    return `tool ${span.name}`;
  }
  return span.name;
}

function chatStartAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  const attrs = (span.attributes ?? {}) as {
    model?: string;
    provider?: string;
    streaming?: boolean;
  };
  const out: Record<string, string | number | boolean> = {};
  if (attrs.model) {
    out["gen_ai.request.model"] = attrs.model;
  }
  if (attrs.provider) out["gen_ai.system"] = attrs.provider;
  if (attrs.streaming !== undefined) out["gen_ai.response.streaming"] = attrs.streaming;
  const input = serializeForLangfuse(span.input);
  if (input !== undefined) out["langfuse.observation.input"] = input;
  return out;
}

function chatFinalAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  const attrs = (span.attributes ?? {}) as {
    model?: string;
    finishReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
    };
  };
  const out: Record<string, string | number | boolean> = {};
  if (attrs.model) out["gen_ai.response.model"] = attrs.model;
  if (attrs.finishReason) out["gen_ai.response.finish_reason"] = attrs.finishReason;
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
  const output = serializeForLangfuse(span.output);
  if (output !== undefined) out["langfuse.observation.output"] = output;
  return out;
}

function toolStartAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    "gen_ai.tool.name": span.name,
  };
  const attrs = (span.attributes ?? {}) as { toolType?: string };
  if (attrs.toolType) out["gen_ai.tool.type"] = attrs.toolType;
  const input = serializeForLangfuse(span.input);
  if (input !== undefined) out["langfuse.observation.input"] = input;
  return out;
}

function toolFinalAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  const attrs = (span.attributes ?? {}) as { success?: boolean };
  const out: Record<string, string | number | boolean> = {};
  if (attrs.success !== undefined) out["ordin.tool.success"] = attrs.success;
  const output = serializeForLangfuse(span.output);
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

function toEpochMillis(value: Date | undefined): number | undefined {
  if (!value) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(ms) ? undefined : ms;
}

export type MastraTracingFactory = () => Mastra;

/**
 * Build a `Mastra` container with the OTel exporter wired in. Both
 * passthrough (parent-side runtime) and srt (worker-side runtime)
 * route through this factory; whichever side's OTel SDK is active
 * receives the spans.
 */
export const buildMastraTracingContainer: MastraTracingFactory = () =>
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
          exporters: [new OtelMastraExporter()],
        },
      },
    }),
  });
