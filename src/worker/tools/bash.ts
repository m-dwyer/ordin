import { spawn } from "node:child_process";

export interface BashInput {
  readonly command: string;
}

/**
 * Narrow allowlist for the env the bash subprocess inherits. Bash now
 * runs broker-side (parent process), so its env *is* the parent's env
 * unless we filter — which would leak Langfuse / model-provider /
 * source-control credentials to whatever the agent shells out to. The
 * allowlist mirrors `EXACT_SRT_WORKER_ENV_ALLOWLIST` in
 * `src/runtime/worker-policy.ts`: the basics needed for shell
 * commands (HOME / PATH / TERM / locale) plus tracing context.
 *
 * Independent allowlist (no cross-layer import) so the broker layer
 * stays self-contained — `src/runtime/` is the harness, broker shouldn't
 * reach into it.
 */
const BASH_ENV_ALLOWLIST = new Set([
  "HOME",
  "PATH",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TRACEPARENT",
  // HTTP_PROXY is the worker → broker tunnel under non-srt subprocess
  // mode; harmless inside the broker's bash since the broker IS the
  // proxy target. Allowed so bash-spawned tooling that honors
  // HTTP_PROXY (curl etc.) sees a consistent environment.
  "HTTP_PROXY",
]);

export async function executeBash(cwd: string, input: BashInput): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", ["-c", input.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: bashToolEnv(process.env),
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout?.on("data", (b: Buffer) => out.push(b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => err.push(b.toString("utf8")));
    child.on("close", (code) => {
      const stdout = out.join("");
      const stderr = err.join("");
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        const msg = [stdout, stderr].filter(Boolean).join("\n");
        reject(new Error(`${msg}\n(exit ${code ?? "?"})`.trim()));
      }
    });
  });
}

function bashToolEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (BASH_ENV_ALLOWLIST.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }
  // Disable bashrc/.profile loading and global git config so subprocess
  // behaviour is reproducible regardless of the parent's shell setup.
  delete env["BASH_ENV"];
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  return env;
}
