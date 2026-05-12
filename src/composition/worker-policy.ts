/**
 * Policy for the worker process boundary. `srt` workers are the
 * untrusted side of the sandbox, so they receive only the process vars
 * and read roots needed for ordinary execution.
 */
export interface WorkerPolicyInfra {
  readonly sandbox: { readonly name: string };
  readonly broker: { proxyUrl(): string };
}

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
  if (infra.sandbox.name !== "srt") {
    // `broker` mode (and any future non-srt subprocess mode): the
    // broker URL is pinned in both HTTP_PROXY and HTTPS_PROXY so
    // claude-cli's `--settings` injection (claude-language-model-v2)
    // can propagate it into claude's own per-API-call settings.
    // `HttpBrokerClient` also reads HTTP_PROXY for its own tool
    // dispatch tunnel — single env block, two consumers.
    const proxyUrl = infra.broker.proxyUrl();
    return { ...parentEnv, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
  }
  // srt: srt's wrapper populates HTTP_PROXY with its own internal
  // filter proxy (no auth — srt injects `Proxy-Authorization` from
  // its `parentProxy` userinfo). The per-run secret never enters the
  // worker env.
  return allowlistedSrtWorkerEnv(parentEnv);
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
