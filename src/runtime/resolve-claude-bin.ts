import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Resolve which `claude` binary the harness will invoke. The parent
 * owns this — it serializes the resolved path into the worker's plan
 * so the worker doesn't need PATH lookup or env access. The CLI's
 * `doctor` command also uses it to probe the same binary the runtime
 * would actually launch.
 *
 * Resolution order:
 *
 *   1. Caller-supplied override (the workflow's `claude-cli.bin`
 *      config field).
 *   2. `CLAUDE_BIN` env — operator override (mise shims, multiple
 *      installs of `claude`, etc.)
 *   3. Bare `"claude"`.
 *
 * Bare command names are expanded through the parent's PATH so the
 * worker does not depend on its own stripped/sandboxed PATH.
 */
export function resolveClaudeBin(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override) return resolveExecutable(override, env);
  const fromEnv = env["CLAUDE_BIN"];
  if (fromEnv) return resolveExecutable(fromEnv, env);
  return resolveExecutable("claude", env);
}

function resolveExecutable(candidate: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(candidate) || candidate.includes("/")) return candidate;
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, candidate);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Keep looking.
    }
  }
  return candidate;
}
