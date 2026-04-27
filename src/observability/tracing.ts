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
 * Wiring is opt-in via env vars. With no `LANGFUSE_*` set, no exporter
 * is registered and the global tracer stays the no-op proxy: spans
 * cost effectively nothing.
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

const SERVICE_VERSION = "0.1.0";

export function startTracing(): void {
  if (sdk) return;
  if (process.env["ORDIN_TRACING_DISABLED"] === "1") return;

  const host = process.env["LANGFUSE_HOST"];
  const publicKey = process.env["LANGFUSE_PUBLIC_KEY"];
  const secretKey = process.env["LANGFUSE_SECRET_KEY"];
  if (!host || !publicKey || !secretKey) return;

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

  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const exporter = new OTLPTraceExporter({
    url: `${host.replace(/\/$/, "")}/api/public/otel/v1/traces`,
    headers: { Authorization: `Basic ${auth}` },
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env["OTEL_SERVICE_NAME"] ?? "ordin",
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    "deployment.environment": process.env["ORDIN_ENV"] ?? "local",
  });

  try {
    sdk = new NodeSDK({ traceExporter: exporter, resource });
    sdk.start();
  } catch (err) {
    console.warn(
      `[tracing] disabled — SDK init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sdk = undefined;
    return;
  }

  const flush = (): void => {
    void shutdownTracing();
  };
  process.once("beforeExit", flush);
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
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
const SHUTDOWN_TIMEOUT_MS = 2_000;

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

function isTelemetryError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const name = (reason as { name?: unknown }).name;
  if (typeof name === "string" && /OTLP|OTel|OpenTelemetry/i.test(name)) return true;
  const stack = (reason as { stack?: unknown }).stack;
  if (typeof stack === "string" && /@opentelemetry\//.test(stack)) return true;
  return false;
}
