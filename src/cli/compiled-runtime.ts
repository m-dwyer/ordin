import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `__ORDIN_COMPILED__` is replaced with the literal `true` at build
 * time by `scripts/package.ts` via Bun.build's `define` option. In dev
 * runs the identifier doesn't exist; the `typeof` guard yields
 * `"undefined"` and this function is a no-op.
 */
declare const __ORDIN_COMPILED__: boolean | undefined;

/**
 * Runtime patches applied once at CLI startup, BEFORE any module that
 * might capture the affected state. Currently:
 *
 *   - Loads `~/.ordin/.env` (if present) into `process.env`. Dev runs
 *     get their env via mise's `.env.local`; installed users have no
 *     equivalent so the binary picks up `LITELLM_MASTER_KEY`, API
 *     tokens, etc. from a stable file under the config root. Existing
 *     env vars win (file values don't clobber a shell export).
 *
 *   - `OTUI_TREE_SITTER_WORKER_PATH` → the bundled `parser.worker.js`
 *     we ship alongside the binary. `@opentui/core` spawns this as a
 *     Worker; Bun's compile VFS can't host a Worker entry point, so
 *     we keep the worker as a sibling file (installed under
 *     `~/.ordin/lib/`) and point OpenTUI at it via env. The TreeSitter
 *     client reads this env var on construction — must be set before
 *     any `.tsx` import that pulls in OpenTUI's renderables.
 *
 * No-op in dev runs (the bundle exports a real worker via
 * `import.meta.url` lookup, and mise handles env).
 */
export function setupCompiledRuntime(): void {
  if (typeof __ORDIN_COMPILED__ === "undefined" || !__ORDIN_COMPILED__) return;
  const home = process.env["ORDIN_HOME"]
    ? resolve(process.env["ORDIN_HOME"])
    : join(homedir(), ".ordin");
  const envFile = join(home, ".env");
  if (existsSync(envFile)) loadEnvFile(envFile);
  const workerPath = join(home, "lib", "parser.worker.js");
  if (existsSync(workerPath)) {
    process.env["OTUI_TREE_SITTER_WORKER_PATH"] = workerPath;
  }
}

/**
 * Tiny .env loader — parses `KEY=value` (and `KEY="quoted value"`)
 * lines, skipping blanks and `#` comments. Avoids pulling in a
 * dependency for what's a 20-line problem. Existing `process.env`
 * values win so explicit shell exports always override file defaults.
 */
function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
