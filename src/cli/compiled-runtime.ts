import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  PARSER_WORKER_JS_BASE64,
  TREE_SITTER_WASM_BASE64,
  TREE_SITTER_WASM_FILENAME,
} from "./embedded-assets.generated";

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
 *   - Extracts the tree-sitter Worker JS + wasm (embedded in the
 *     binary as base64 by `scripts/package.ts`) to a cache dir under
 *     `~/.cache/ordin/lib-<hash>/`. `@opentui/core` spawns the worker
 *     as a Web Worker; Bun's --compile VFS can't host a Worker entry,
 *     so we materialize both files on real disk at first run and
 *     point OpenTUI at them via `OTUI_TREE_SITTER_WORKER_PATH`. Cache
 *     key includes the content hash, so binary upgrades repopulate
 *     and stale caches get garbage-collected by `~/.cache` cleanup.
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
  const workerPath = extractTreeSitterWorker();
  if (workerPath) process.env["OTUI_TREE_SITTER_WORKER_PATH"] = workerPath;
}

/**
 * Decode the embedded worker + wasm to `~/.cache/ordin/lib-<hash>/` if
 * not already present. Returns the worker path, or undefined when the
 * binary was built without embedded assets (e.g. unit tests against
 * the dev-tree stub).
 */
function extractTreeSitterWorker(): string | undefined {
  if (!PARSER_WORKER_JS_BASE64 || !TREE_SITTER_WASM_BASE64) return undefined;
  const cacheRoot = join(homedir(), ".cache", "ordin");
  // Hash worker + wasm bytes together so cache invalidates whenever
  // either changes. 12 hex chars is plenty for collision-avoidance at
  // our content-volume scale (one binary version per user).
  const hash = createHash("sha256")
    .update(PARSER_WORKER_JS_BASE64)
    .update(TREE_SITTER_WASM_BASE64)
    .digest("hex")
    .slice(0, 12);
  const libDir = join(cacheRoot, `lib-${hash}`);
  const workerPath = join(libDir, "parser.worker.js");
  const wasmPath = join(libDir, TREE_SITTER_WASM_FILENAME);
  if (!existsSync(workerPath) || !existsSync(wasmPath)) {
    mkdirSync(libDir, { recursive: true });
    writeFileSync(workerPath, Buffer.from(PARSER_WORKER_JS_BASE64, "base64"));
    writeFileSync(wasmPath, Buffer.from(TREE_SITTER_WASM_BASE64, "base64"));
  }
  return workerPath;
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
