import { dirname } from "node:path";
import { workerArgv } from "../worker/locator";

/**
 * Policy for the worker process boundary. `srt` workers are the
 * untrusted side of the sandbox, so they receive only the process vars
 * and read roots needed for ordinary execution.
 */
export type WorkerPolicyInfra =
  | { readonly kind: "override" }
  | {
      readonly kind: "managed";
      readonly sandbox: { readonly name: string };
      readonly broker: { proxyUrl(): string };
    };

const EXACT_SRT_WORKER_ENV_ALLOWLIST = new Set([
  "HOME",
  "PATH",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  // W3C Trace Context. The parent stamps the active OTel span here so
  // the worker can hand it to Mastra's `tracingOptions` and Mastra-
  // emitted Langfuse spans nest under `ordin.phase.*`. Tracing data
  // only — no credentials.
  "TRACEPARENT",
]);

export function buildWorkerEnv(
  infra: WorkerPolicyInfra,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (infra.kind !== "managed") return parentEnv;
  if (infra.sandbox.name !== "srt") {
    // Non-srt subprocess (currently unused — passthrough runs in-process
    // post-Phase A — but kept robust for future): broker URL with auth
    // goes in via HTTP_PROXY. The worker's `HttpBrokerClient` reads
    // HTTP_PROXY and tunnels tool dispatches through the broker.
    return { ...parentEnv, HTTP_PROXY: infra.broker.proxyUrl() };
  }
  // srt: srt's wrapper populates HTTP_PROXY with its own internal
  // filter proxy (no auth — srt injects `Proxy-Authorization` from
  // its `parentProxy` userinfo). The per-run secret never enters the
  // worker env.
  return allowlistedSrtWorkerEnv(parentEnv);
}

export function workerReadRoots(harnessRoot: string): readonly string[] {
  return workerArgv({ harnessRoot })
    .filter((arg) => arg.startsWith("/"))
    .map(dirname);
}

function allowlistedSrtWorkerEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (EXACT_SRT_WORKER_ENV_ALLOWLIST.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }
  return env;
}
