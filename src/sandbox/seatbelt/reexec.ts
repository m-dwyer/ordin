import { type SpawnSyncReturns, spawnSync } from "node:child_process";

/**
 * Self-reexec mechanic for B-process sandboxing (ADR-001, ADR-009).
 *
 * On the OUTER invocation, ordin renders the profile, then reexecs
 * itself under `sandbox-exec`. The kernel applies the profile from
 * that point on; the inner invocation runs the harness logic with
 * its filesystem syscalls filtered.
 *
 * Implemented as spawn-and-wait (parent stays alive, forwards stdio,
 * exits with the child's code). Considered execve-style replacement;
 * rejected for v1 because spawn-and-wait gives cleaner stdio
 * forwarding and matches how every other ordin subprocess is launched.
 *
 * `ORDIN_SANDBOXED=1` is the loop-breaker (ADR-009): the outer process
 * sets it before spawning so the inner one knows it's already inside.
 * The env var is *not* a security boundary — kernel `sandbox-exec`
 * enforcement does the actual confinement.
 */

export const REEXEC_GUARD_ENV = "ORDIN_SANDBOXED";
export const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

export interface ReexecArgs {
  readonly profile: string;
  /** Original argv to re-invoke (typically `process.argv`). */
  readonly argv: readonly string[];
}

/**
 * True iff the current process is the OUTER invocation that needs to
 * reexec under sandbox-exec. False once we've already entered.
 */
export function shouldReexec(env: NodeJS.ProcessEnv): boolean {
  return env[REEXEC_GUARD_ENV] !== "1";
}

/**
 * Build the argv array for `spawnSync(sandbox-exec, …)`. Pure helper
 * exposed for unit tests.
 */
export function buildReexecArgv(args: ReexecArgs): readonly string[] {
  return [SANDBOX_EXEC_BIN, "-p", args.profile, "--", ...args.argv];
}

/**
 * Construct the env for the inner invocation: existing env plus the
 * loop-breaker plus a small set of accommodations for libraries that
 * walk parent directories looking for config files (which the
 * sandbox profile would otherwise have to allow with metadata reads
 * up to /).
 *
 * `BROWSERSLIST=defaults` short-circuits browserslist's `findConfigFile`
 * scan — without it, `@opentui/solid`'s runtime JSX transformation (via
 * `@babel/core` + `babel-preset-solid`) walks up from somewhere in
 * `~/.bun/install/cache/` looking for `.browserslistrc`, calling
 * `statSync` on every ancestor and throwing fatal `EPERM`. Setting the
 * env var makes browserslist use the literal value as its query and
 * skip the file scan entirely.
 *
 * `BROWSERSLIST_DISABLE_CACHE=1` complements this by skipping the on-
 * disk cache lookup that would also try to write to a parent-related
 * cache file.
 *
 * Pure helper exposed for unit tests.
 */
export function buildReexecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    [REEXEC_GUARD_ENV]: "1",
    BROWSERSLIST: "defaults",
    BROWSERSLIST_DISABLE_CACHE: "1",
  };
}

export type SyncSpawner = (
  command: string,
  args: readonly string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
) => Pick<SpawnSyncReturns<Buffer>, "status" | "signal" | "error">;

export interface ReexecDeps {
  readonly spawner?: SyncSpawner;
  readonly env?: NodeJS.ProcessEnv;
  readonly exit?: (code: number) => never;
  readonly stderr?: { write: (msg: string) => void };
}

const defaultSpawner: SyncSpawner = (cmd, args, opts) => spawnSync(cmd, args as string[], opts);

/**
 * Reexec the current process under sandbox-exec with the given profile.
 * Spawn-and-wait: parent forwards stdio, blocks until child exits,
 * exits with the child's status code. Does not return on the happy
 * path; returns only if `process.exit` is overridden (test seam).
 */
export function reexec(args: ReexecArgs, deps: ReexecDeps = {}): never {
  const spawner = deps.spawner ?? defaultSpawner;
  const env = deps.env ?? process.env;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const stderr = deps.stderr ?? process.stderr;

  const [command, ...rest] = buildReexecArgv(args);
  if (!command) {
    stderr.write("reexec: empty argv (unreachable)\n");
    return exit(1);
  }
  const result = spawner(command, rest, {
    stdio: "inherit",
    env: buildReexecEnv(env),
  });
  if (result.error) {
    stderr.write(`Failed to spawn sandbox-exec: ${result.error.message}\n`);
    return exit(1);
  }
  return exit(result.status ?? 1);
}
