#!/usr/bin/env bun
/**
 * Package the ordin CLI into a single-file executable via `Bun.build`.
 *
 * Uses the programmatic API rather than `bun build --compile` because
 * the CLI form has no `--plugin` flag, and `@opentui/solid` JSX needs
 * the babel-preset-solid transform at build time (the `bunfig.toml`
 * preload only fires at runtime, not under AOT compile).
 *
 * Target defaults to the host platform; override via `--target=<spec>`
 * e.g. `bun-darwin-arm64`, `bun-linux-x64`.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import createSolidTransformPlugin from "@opentui/solid/bun-plugin";

interface BuildOpts {
  readonly target: string;
  readonly outfile: string;
}

function parseArgs(argv: readonly string[]): BuildOpts {
  let target = `bun-${process.platform === "darwin" ? "darwin" : "linux"}-${
    process.arch === "arm64" ? "arm64" : "x64"
  }`;
  let outfile = "dist/ordin";
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--target=")) target = arg.slice("--target=".length);
    else if (arg.startsWith("--outfile=")) outfile = arg.slice("--outfile=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { target, outfile };
}

const opts = parseArgs(process.argv);
await mkdir("dist", { recursive: true });

const start = Date.now();
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "src", "cli", "index.ts")],
  target: "bun",
  plugins: [createSolidTransformPlugin],
  // Compile-time marker the runtime checks to distinguish installed
  // binary from dev runs. Dev runs (`bun src/cli/index.ts`) never see
  // this define, so the identifier resolves to `undefined` and the
  // typeof guard branches to the source-tree walk-up.
  define: {
    __ORDIN_COMPILED__: "true",
  },
  compile: {
    target: opts.target as Bun.Build.CompileTarget,
    outfile: opts.outfile,
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`✓ ${opts.outfile} (${opts.target}, ${Date.now() - start}ms)`);

// @opentui/core spawns a Worker from `./parser.worker.js` for tree-sitter
// syntax highlighting. `bun --compile` puts source in a VFS that can't
// be a Worker entry point, so we ship the worker as a sibling file and
// point OpenTUI at it via `OTUI_TREE_SITTER_WORKER_PATH` at runtime.
const workerStart = Date.now();
const workerOutDir = dirname(opts.outfile);
const workerEntry = join(
  import.meta.dir,
  "..",
  "node_modules",
  "@opentui",
  "core",
  "parser.worker.js",
);
const workerResult = await Bun.build({
  entrypoints: [workerEntry],
  target: "bun",
  outdir: workerOutDir,
  naming: "parser.worker.js",
});
if (!workerResult.success) {
  for (const log of workerResult.logs) console.error(log);
  process.exit(1);
}

// Bun bundles the tree-sitter wasm sibling and exports its path as
// `"./tree-sitter-<hash>.wasm"` — a relative string. emscripten's
// readBinary resolves that against `process.cwd()`, not the worker's
// own location, so the worker spawned by an installed binary fails
// with ENOENT when launched from any cwd outside ~/.ordin/lib/.
//
// Patch the emit so the wasm path is resolved against `import.meta.url`
// (the worker file's URL) at load time. Yields an absolute path
// regardless of where the parent process was launched.
const workerPath = join(workerOutDir, "parser.worker.js");
const workerJs = await Bun.file(workerPath).text();
const patched = workerJs.replace(
  /module2\.exports\s*=\s*"(\.\/tree-sitter-[a-z0-9]+\.wasm)";/,
  'module2.exports = new URL("$1", import.meta.url).pathname;',
);
if (patched === workerJs) {
  console.error(
    "✗ failed to patch tree-sitter wasm path in parser.worker.js — Bun bundler output changed shape?",
  );
  process.exit(1);
}
await Bun.write(workerPath, patched);
console.log(`✓ ${workerPath} (${Date.now() - workerStart}ms, wasm path patched)`);
