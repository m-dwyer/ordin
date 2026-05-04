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
 *   3. Bare `"claude"` — let the OS resolve from PATH.
 */
export function resolveClaudeBin(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override) return override;
  const fromEnv = env["CLAUDE_BIN"];
  if (fromEnv) return fromEnv;
  return "claude";
}
