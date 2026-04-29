import { describe, expect, it, vi } from "vitest";
import {
  buildReexecArgv,
  buildReexecEnv,
  REEXEC_GUARD_ENV,
  reexec,
  SANDBOX_EXEC_BIN,
  type SyncSpawner,
  shouldReexec,
} from "./reexec";

describe("shouldReexec", () => {
  it("returns true when ORDIN_SANDBOXED is unset", () => {
    expect(shouldReexec({})).toBe(true);
  });

  it("returns true when ORDIN_SANDBOXED is some other value", () => {
    expect(shouldReexec({ [REEXEC_GUARD_ENV]: "0" })).toBe(true);
    expect(shouldReexec({ [REEXEC_GUARD_ENV]: "" })).toBe(true);
  });

  it("returns false when ORDIN_SANDBOXED=1 (we're already inside)", () => {
    expect(shouldReexec({ [REEXEC_GUARD_ENV]: "1" })).toBe(false);
  });
});

describe("buildReexecArgv", () => {
  it("places sandbox-exec first, then -p <profile>, then --, then the original argv", () => {
    const argv = buildReexecArgv({
      profile: "(version 1)\n(deny default)",
      argv: ["/path/to/bun", "/path/to/cli.ts", "run", "--sandbox", "seatbelt"],
    });
    expect(argv).toEqual([
      SANDBOX_EXEC_BIN,
      "-p",
      "(version 1)\n(deny default)",
      "--",
      "/path/to/bun",
      "/path/to/cli.ts",
      "run",
      "--sandbox",
      "seatbelt",
    ]);
  });

  it("handles empty argv (degenerate but well-defined)", () => {
    const argv = buildReexecArgv({ profile: "(version 1)", argv: [] });
    expect(argv).toEqual([SANDBOX_EXEC_BIN, "-p", "(version 1)", "--"]);
  });
});

describe("buildReexecEnv", () => {
  it("preserves the existing env and adds ORDIN_SANDBOXED=1", () => {
    const out = buildReexecEnv({ PATH: "/usr/bin", FOO: "bar" });
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["FOO"]).toBe("bar");
    expect(out[REEXEC_GUARD_ENV]).toBe("1");
  });

  it("overwrites a pre-existing ORDIN_SANDBOXED value (consistency)", () => {
    const out = buildReexecEnv({ [REEXEC_GUARD_ENV]: "anything" });
    expect(out[REEXEC_GUARD_ENV]).toBe("1");
  });

  it("sets BROWSERSLIST=defaults to short-circuit browserslist's parent walk", () => {
    const out = buildReexecEnv({});
    expect(out["BROWSERSLIST"]).toBe("defaults");
    expect(out["BROWSERSLIST_DISABLE_CACHE"]).toBe("1");
  });
});

describe("reexec", () => {
  function fakeDeps(spawner: SyncSpawner) {
    const exitCalls: number[] = [];
    const stderrLines: string[] = [];
    const exit = vi.fn((code: number) => {
      exitCalls.push(code);
      throw new Error(`__exit_${code}__`);
    }) as unknown as (code: number) => never;
    const stderr = { write: (msg: string) => stderrLines.push(msg) };
    return {
      deps: { spawner, env: { PATH: "/usr/bin" }, exit, stderr },
      exitCalls,
      stderrLines,
    };
  }

  it("invokes the spawner with sandbox-exec, the profile, the argv, and the guard env", () => {
    const spawner: SyncSpawner = vi.fn(() => ({ status: 0, signal: null })) as SyncSpawner;
    const { deps } = fakeDeps(spawner);

    expect(() => reexec({ profile: "(version 1)", argv: ["bun", "cli.ts", "run"] }, deps)).toThrow(
      "__exit_0__",
    );

    expect(spawner).toHaveBeenCalledWith(
      SANDBOX_EXEC_BIN,
      ["-p", "(version 1)", "--", "bun", "cli.ts", "run"],
      {
        stdio: "inherit",
        env: {
          PATH: "/usr/bin",
          [REEXEC_GUARD_ENV]: "1",
          BROWSERSLIST: "defaults",
          BROWSERSLIST_DISABLE_CACHE: "1",
        },
      },
    );
  });

  it("exits with the child's status code on success", () => {
    const spawner: SyncSpawner = () => ({ status: 0, signal: null });
    const { deps, exitCalls } = fakeDeps(spawner);
    expect(() => reexec({ profile: "x", argv: ["a"] }, deps)).toThrow();
    expect(exitCalls).toEqual([0]);
  });

  it("exits with the child's non-zero status code on failure", () => {
    const spawner: SyncSpawner = () => ({ status: 42, signal: null });
    const { deps, exitCalls } = fakeDeps(spawner);
    expect(() => reexec({ profile: "x", argv: ["a"] }, deps)).toThrow();
    expect(exitCalls).toEqual([42]);
  });

  it("exits 1 when the spawner returns null status (signal-killed child)", () => {
    const spawner: SyncSpawner = () => ({ status: null, signal: "SIGTERM" });
    const { deps, exitCalls } = fakeDeps(spawner);
    expect(() => reexec({ profile: "x", argv: ["a"] }, deps)).toThrow();
    expect(exitCalls).toEqual([1]);
  });

  it("exits 1 and writes to stderr when spawn fails outright", () => {
    const spawnError = new Error("ENOENT: sandbox-exec not found");
    const spawner: SyncSpawner = () => ({ status: null, signal: null, error: spawnError });
    const { deps, exitCalls, stderrLines } = fakeDeps(spawner);
    expect(() => reexec({ profile: "x", argv: ["a"] }, deps)).toThrow();
    expect(exitCalls).toEqual([1]);
    expect(stderrLines.join("")).toContain("Failed to spawn sandbox-exec");
    expect(stderrLines.join("")).toContain("ENOENT: sandbox-exec not found");
  });
});
