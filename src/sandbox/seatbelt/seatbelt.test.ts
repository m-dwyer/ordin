import { describe, expect, it, vi } from "vitest";
import { SeatbeltSandbox } from "./index";
import type { ReexecArgs } from "./reexec";

const FAKE_DEPS = {
  platform: () => "darwin",
  hasFile: (path: string) => path === "/usr/bin/sandbox-exec",
  homeDir: () => "/Users/test",
  tempDir: () => "/var/folders/test",
};

describe("SeatbeltSandbox", () => {
  it("is named 'seatbelt'", () => {
    expect(new SeatbeltSandbox(FAKE_DEPS).name).toBe("seatbelt");
  });

  describe("enterIfNeeded", () => {
    it("returns without reexecing when ORDIN_SANDBOXED=1 (already inside)", async () => {
      const reexecSpy = vi.fn(() => {
        throw new Error("reexec should not have been called");
      }) as unknown as (args: ReexecArgs) => never;
      const sandbox = new SeatbeltSandbox({
        ...FAKE_DEPS,
        env: () => ({ ORDIN_SANDBOXED: "1" }),
        reexec: reexecSpy,
      });
      await expect(
        sandbox.enterIfNeeded({
          workspaceRoot: "/Users/test/work",
          runStoreDir: "/Users/test/.ordin/runs",
          harnessRoot: "/Users/test/src/harness",
        }),
      ).resolves.toBeUndefined();
      expect(reexecSpy).not.toHaveBeenCalled();
    });

    it("invokes reexec with the rendered profile and current argv when not yet sandboxed", async () => {
      let captured: ReexecArgs | undefined;
      const reexecStub = vi.fn((args: ReexecArgs) => {
        captured = args;
        // Production path doesn't return; test stub returns to let
        // the awaiter complete.
      }) as unknown as (args: ReexecArgs) => never;
      const sandbox = new SeatbeltSandbox({
        ...FAKE_DEPS,
        env: () => ({}),
        argv: () => ["/path/to/bun", "/path/to/cli.ts", "run", "--sandbox", "seatbelt"],
        reexec: reexecStub,
      });
      await sandbox.enterIfNeeded({
        workspaceRoot: "/Users/test/work",
        runStoreDir: "/Users/test/.ordin/runs",
        harnessRoot: "/Users/test/src/harness",
      });
      expect(reexecStub).toHaveBeenCalledOnce();
      expect(captured?.argv).toEqual([
        "/path/to/bun",
        "/path/to/cli.ts",
        "run",
        "--sandbox",
        "seatbelt",
      ]);
      expect(captured?.profile).toContain("(version 1)");
      expect(captured?.profile).toContain('(subpath "/Users/test/work")');
      expect(captured?.profile).toContain('(subpath "/Users/test/src/harness")');
    });
  });

  describe("readiness", () => {
    it("reports ok on darwin with sandbox-exec present", async () => {
      const sandbox = new SeatbeltSandbox(FAKE_DEPS);
      await expect(sandbox.readiness()).resolves.toEqual({ ok: true, reasons: [] });
    });

    it("reports not-ok on linux", async () => {
      const sandbox = new SeatbeltSandbox({ ...FAKE_DEPS, platform: () => "linux" });
      const result = await sandbox.readiness();
      expect(result.ok).toBe(false);
      expect(result.reasons.join(" ")).toContain("requires macOS");
    });

    it("reports not-ok when sandbox-exec is missing", async () => {
      const sandbox = new SeatbeltSandbox({ ...FAKE_DEPS, hasFile: () => false });
      const result = await sandbox.readiness();
      expect(result.ok).toBe(false);
      expect(result.reasons.join(" ")).toContain("sandbox-exec binary not found");
    });

    it("collects multiple reasons when multiple checks fail", async () => {
      const sandbox = new SeatbeltSandbox({
        ...FAKE_DEPS,
        platform: () => "linux",
        hasFile: () => false,
      });
      const result = await sandbox.readiness();
      expect(result.ok).toBe(false);
      expect(result.reasons).toHaveLength(2);
    });
  });

  describe("renderProfile", () => {
    it("substitutes the workspace + run-store + harness root + injected home/temp", () => {
      const sandbox = new SeatbeltSandbox(FAKE_DEPS);
      const out = sandbox.renderProfile({
        workspaceRoot: "/Users/test/work/myproj",
        runStoreDir: "/Users/test/.ordin/runs",
        harnessRoot: "/Users/test/src/harness",
      });
      expect(out).toContain('(subpath "/Users/test/work/myproj")');
      expect(out).toContain('(subpath "/Users/test/.ordin/runs")');
      expect(out).toContain('(subpath "/Users/test/src/harness")');
      expect(out).toContain('(subpath "/var/folders/test")');
      expect(out).toContain('(subpath "/Users/test/.ssh")');
    });

    it("respects an explicit tempDir over the injected default", () => {
      const sandbox = new SeatbeltSandbox(FAKE_DEPS);
      const out = sandbox.renderProfile({
        workspaceRoot: "/x",
        runStoreDir: "/y",
        harnessRoot: "/h",
        tempDir: "/explicit/tmp",
      });
      expect(out).toContain('(subpath "/explicit/tmp")');
      expect(out).not.toContain('(subpath "/var/folders/test")');
    });
  });
});
