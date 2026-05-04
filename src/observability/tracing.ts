import { DiagLogLevel, diag } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/**
 * OpenTelemetry bootstrap. The only file in the harness that imports
 * `@opentelemetry/sdk-node` — every other module uses the public API
 * tracer (`trace.getTracer("ordin")`).
 *
 * Parent-run wiring passes the broker proxy URL explicitly once the
 * broker is listening. The worker has no Langfuse credentials or
 * broker URL of its own — spans go from the parent to
 * `http://otel/api/public/otel/v1/traces` (a broker hostname), the
 * broker injects the Basic-auth header on the way out, and Langfuse
 * never sees the worker directly.
 *
 * Tracing is supplementary — never load-bearing. SDK init, exporter
 * errors, and transport rejections are caught here so a Langfuse
 * outage / misconfig / network failure can warn but never crash an
 * ordin run. The harness keeps working; the user just doesn't see
 * traces in Langfuse for that run.
 */

let sdk: NodeSDK | undefined;
let shutdownPromise: Promise<void> | undefined;
let rejectionGuardInstalled = false;
let shutdownHooksInstalled = false;

const SERVICE_VERSION = "0.1.0";
const OTEL_BROKER_URL = "http://otel/api/public/otel/v1/traces";

export interface TracingOptions {
  readonly enabled?: boolean;
  readonly proxyUrl?: string;
}

export function startTracing(opts: TracingOptions = {}): boolean {
  if (sdk) return true;
  if (process.env["ORDIN_TRACING_DISABLED"] === "1") return false;
  const enabled = opts.enabled ?? process.env["ORDIN_TRACING_ENABLED"] === "1";
  if (!enabled) return false;

  installRejectionGuard();
  diag.setLogger(
    {
      verbose: () => {},
      debug: () => {},
      info: () => {},
      warn: (msg, ...args) => console.warn(`[tracing] ${msg}`, ...args),
      error: (msg, ...args) => console.warn(`[tracing] ${msg}`, ...args),
    },
    DiagLogLevel.WARN,
  );

  // OTel HTTP exporter routes via the broker proxy. In the parent-run
  // path this is passed explicitly after the broker has bound; the env
  // fallback is kept for standalone/dev invocations.
  //
  // We supply httpAgentOptions as a factory so the OTel SDK uses a
  // ProxyAgent for the proxy URL. The OTel base accepts a function
  // value here: `typeof === "function"` is treated as the agent
  // factory directly (see otlp-exporter-base/.../convert-legacy-
  // node-http-options.js).
  const proxyUrl = opts.proxyUrl ?? process.env["HTTPS_PROXY"] ?? process.env["HTTP_PROXY"];
  const exporter = new OTLPTraceExporter({
    url: OTEL_BROKER_URL,
    ...(proxyUrl ? { httpAgentOptions: proxyAgentFactory(proxyUrl) } : {}),
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env["OTEL_SERVICE_NAME"] ?? "ordin",
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    "deployment.environment": process.env["ORDIN_ENV"] ?? "local",
  });

  try {
    shutdownPromise = undefined;
    sdk = new NodeSDK({ traceExporter: exporter, resource });
    sdk.start();
  } catch (err) {
    console.warn(
      `[tracing] disabled — SDK init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sdk = undefined;
    return false;
  }

  installShutdownHooks();
  return true;
}

/**
 * Bound the OTel shutdown — `sdk.shutdown()` flushes pending spans
 * over HTTP, and an unreachable Langfuse host (network blip, dev
 * machine off-VPN, wrong env vars) can leave the request hanging
 * until the OTLP exporter's own timeout fires (often 30s+). That
 * blocks every CLI exit until the user gives up. Cap the wait at
 * 2s; if the flush hasn't completed by then, drop the spans with a
 * warning and let the process exit cleanly.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  if (!shutdownPromise) {
    const flush = sdk.shutdown().catch((err) => {
      console.warn(
        `[tracing] shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS).unref();
    });
    shutdownPromise = Promise.race([flush.then(() => "ok" as const), timeout])
      .then((outcome) => {
        if (outcome === "timeout") {
          console.warn(
            `[tracing] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — dropping pending spans`,
          );
        }
      })
      .finally(() => {
        sdk = undefined;
        shutdownPromise = undefined;
      });
  }
  await shutdownPromise;
}

/**
 * Process-level guard: OTel exporters can reject in-flight HTTP
 * promises (e.g. Langfuse 5xx, network blip). Without this, Node 22
 * surfaces them as unhandled rejections and exits the process — even
 * though the run logically succeeded. We swallow telemetry-shaped
 * rejections with a warning and let everything else through to Node's
 * default behavior.
 */
function proxyAgentFactory(proxyUrl: string) {
  return async (protocol: string) => {
    if (protocol === "https:") {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      return new HttpsProxyAgent(proxyUrl);
    }
    const { HttpProxyAgent } = await import("http-proxy-agent");
    return new HttpProxyAgent(proxyUrl);
  };
}

function installRejectionGuard(): void {
  if (rejectionGuardInstalled) return;
  rejectionGuardInstalled = true;
  process.on("unhandledRejection", (reason) => {
    if (isTelemetryError(reason)) {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.warn(`[tracing] export error suppressed: ${message}`);
      return;
    }
    setImmediate(() => {
      throw reason;
    });
  });
}

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  const flush = (): void => {
    void shutdownTracing();
  };
  process.once("beforeExit", flush);
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
}

function isTelemetryError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const name = (reason as { name?: unknown }).name;
  if (typeof name === "string" && /OTLP|OTel|OpenTelemetry/i.test(name)) return true;
  const stack = (reason as { stack?: unknown }).stack;
  if (typeof stack === "string" && /@opentelemetry\//.test(stack)) return true;
  return false;
}
