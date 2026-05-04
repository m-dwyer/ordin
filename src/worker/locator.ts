import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve how the parent should invoke the worker. Returns the argv
 * prefix; the parent appends `--plan <path>`. Lives here (in the worker
 * subtree) because "how do I run this worker" is the worker's public
 * contract — analogous to a package's `bin` field. It is the only
 * worker-side module the parent value-imports.
 *
 * Resolution order:
 *
 *   1. `ORDIN_WORKER_BIN` env override — absolute path to a worker
 *      binary. Operator escape hatch.
 *   2. `<harnessRoot>/dist/ordin-worker` if present — the bundled
 *      distribution (Phase D in the sandboxing roadmap).
 *   3. `bun src/worker/entry.ts` — dev fallback against the source tree.
 *
 * The locator decouples the parent from the worker's on-disk shape, so
 * swapping in a compiled binary is a packaging change, not a code
 * change.
 */
export interface WorkerLocatorOptions {
  readonly harnessRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly hasFile?: (path: string) => boolean;
}

export function workerArgv(opts: WorkerLocatorOptions): readonly string[] {
  const env = opts.env ?? process.env;
  const hasFile = opts.hasFile ?? existsSync;

  const override = env["ORDIN_WORKER_BIN"];
  if (override) return [override];

  const bundled = join(opts.harnessRoot, "dist", "ordin-worker");
  if (hasFile(bundled)) return [bundled];

  return [process.execPath, join(opts.harnessRoot, "src", "worker", "entry.ts")];
}
