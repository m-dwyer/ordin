/**
 * Environment visible to worker processes. `srt` workers are the
 * untrusted side of the sandbox boundary, so they receive only the
 * process vars needed for ordinary execution. Passthrough preserves
 * historical ambient-env behavior.
 */
export type WorkerEnvInfra =
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
]);

export function buildWorkerEnv(
  infra: WorkerEnvInfra,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (infra.kind !== "managed") return parentEnv;
  if (infra.sandbox.name !== "srt") {
    return { ...parentEnv, HTTP_PROXY: infra.broker.proxyUrl() };
  }
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
