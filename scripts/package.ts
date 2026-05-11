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
import { join } from "node:path";
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
