import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("ordin");

/**
 * Standard span wrapper for harness instrumentation. Opens an active
 * span with the given name and attributes, yields it to `fn`, and:
 *
 *   - records exceptions and sets ERROR status on throw
 *   - ends the span in a `finally`
 *
 * Domain failures returned (not thrown) by `fn` are *not* errors —
 * `fn` should set its own outcome attributes via `span.setAttribute`
 * before returning.
 */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function recordSpan(
  name: string,
  attributes: Attributes,
  durationMs: number,
  status: "ok" | "error" = "ok",
  error?: string,
): void {
  const startedAt = Date.now() - Math.max(0, durationMs);
  const span = tracer.startSpan(name, { attributes, startTime: startedAt });
  if (status === "error") {
    span.setStatus({ code: SpanStatusCode.ERROR, ...(error ? { message: error } : {}) });
    if (error) span.setAttribute("ordin.error", error);
  }
  span.end();
}
