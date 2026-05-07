import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { HttpProxyAgent } from "http-proxy-agent";

/**
 * OTel bootstrap for the worker subprocess (Phase D). Only relevant
 * under HTTP transport (`--sandbox srt`) — passthrough mode runs the
 * runtime in the parent, which has its own `startTracing` from
 * `src/observability/tracing.ts`.
 *
 * Worker spans (Mastra-translated chat / tool, `ordin.provider.turn`,
 * `ordin.tool.<name>`) flow through this SDK directly to Langfuse via
 * the broker — no parent-side timing-event reconstruction.
 *
 * The trace context propagates from the parent's active phase span
 * via the W3C `TRACEPARENT` env var the harness stamps at worker
 * spawn. We set it as the root context for everything the worker does
 * after `startWorkerTracing` returns, so any span the runtime starts
 * is a child of the parent's `ordin.phase.<id>` span.
 *
 * Shutdown is bounded at 5s; a wedged Langfuse export must never hang
 * the worker exit (and through it the parent's blocking `await
 * handle.exit`).
 */

const SERVICE_VERSION = "0.1.0";
const OTEL_BROKER_URL = "http://otel/api/public/otel/v1/traces";
const SHUTDOWN_TIMEOUT_MS = 5_000;

let sdk: NodeSDK | undefined;

export interface WorkerTracingResult {
  /**
   * Bootstrapping was attempted. If false, no SDK was started — call
   * sites should skip context propagation.
   */
  readonly enabled: boolean;
}

/**
 * Start the worker's OTel SDK and (if `TRACEPARENT` is set) install
 * the parent's trace context as the worker process's active context
 * via `context.with`. Idempotent on repeated calls.
 *
 * Returns immediately on shutdown failure — observability is
 * supplementary; the worker keeps running. The parent's audit chain
 * remains the load-bearing record.
 */
export function startWorkerTracing(): WorkerTracingResult {
  if (sdk) return { enabled: true };
  const proxyUrl = process.env["HTTP_PROXY"];
  if (!proxyUrl) return { enabled: false };

  const exporter = new OTLPTraceExporter({
    url: OTEL_BROKER_URL,
    httpAgentOptions: () => new HttpProxyAgent(proxyUrl),
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env["OTEL_SERVICE_NAME"] ?? "ordin-worker",
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    "deployment.environment": process.env["ORDIN_ENV"] ?? "local",
  });

  try {
    sdk = new NodeSDK({
      traceExporter: exporter,
      resource,
      // No auto-instrumentations: the worker only emits spans the
      // harness explicitly creates. Auto-instrumentations would add
      // attack surface (HTTP / DNS / fs hooks) inside the sandbox.
      instrumentations: [],
    });
    sdk.start();
  } catch (err) {
    console.warn(
      `[worker-tracing] disabled — SDK init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sdk = undefined;
    return { enabled: false };
  }

  applyTraceparent(process.env["TRACEPARENT"]);
  return { enabled: true };
}

export async function shutdownWorkerTracing(): Promise<void> {
  if (!sdk) return;
  const flush = sdk.shutdown().catch((err) => {
    console.warn(
      `[worker-tracing] shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS).unref();
  });
  const outcome = await Promise.race([flush.then(() => "ok" as const), timeout]);
  if (outcome === "timeout") {
    console.warn(
      `[worker-tracing] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — dropping pending spans`,
    );
  }
  sdk = undefined;
}

/**
 * Adopt the W3C `TRACEPARENT` value the parent stamped into the env
 * as the worker's active context. Spans started after this call nest
 * under the parent's `ordin.phase.*` span in Langfuse.
 *
 * Mutates the global active context — the parent of all subsequent
 * spans is the extracted phase context. Per the plan's Risk #4 we
 * extract per-invoke (rather than at SDK init), but with one worker
 * per phase invocation that's the same point in the lifecycle.
 */
function applyTraceparent(value: string | undefined): void {
  if (!value) return;
  const carrier = { traceparent: value };
  const extracted = propagation.extract(ROOT_CONTEXT, carrier);
  // `context.bind` returns a function bound to the extracted context;
  // `context.with` runs a callback inside it. We need the spans
  // started during `runtime.invoke` to inherit the context, so we
  // attach it permanently for the worker's lifetime by replacing the
  // root with the extracted context as the default carrier.
  // OTel doesn't expose a "set active globally" — instead we wrap
  // every subsequent span creation in `context.with(extracted, ...)`.
  // The cleanest spot is the worker's `main()` — we expose the
  // extracted context here for callers to use.
  workerActiveContext = extracted;
}

let workerActiveContext: ReturnType<typeof propagation.extract> | undefined;

/**
 * Run `fn` inside the parent-derived context if one was extracted,
 * otherwise as-is. Keeps the call site clean in `main()`.
 */
export async function withWorkerContext<T>(fn: () => Promise<T>): Promise<T> {
  if (!workerActiveContext) return fn();
  return context.with(workerActiveContext, fn);
}
