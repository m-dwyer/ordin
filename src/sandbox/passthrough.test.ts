import { describe, expect, it } from "vitest";
import { type SandboxMode, selectSandbox } from "./index";
import { PassthroughSandbox } from "./passthrough";
import { SeatbeltSandbox } from "./seatbelt";

describe("PassthroughSandbox", () => {
  it("is named 'passthrough'", () => {
    expect(new PassthroughSandbox().name).toBe("passthrough");
  });

  it("enterIfNeeded resolves without effect", async () => {
    const sandbox = new PassthroughSandbox();
    await expect(
      sandbox.enterIfNeeded({
        workspaceRoot: "/tmp/test-workspace",
        runStoreDir: "/tmp/test-runs",
        harnessRoot: "/tmp/test-harness",
      }),
    ).resolves.toBeUndefined();
  });

  it("readiness reports ok with no reasons", async () => {
    const sandbox = new PassthroughSandbox();
    await expect(sandbox.readiness()).resolves.toEqual({ ok: true, reasons: [] });
  });
});

describe("selectSandbox", () => {
  it("returns a PassthroughSandbox for mode 'passthrough'", () => {
    const sandbox = selectSandbox("passthrough");
    expect(sandbox).toBeInstanceOf(PassthroughSandbox);
    expect(sandbox.name).toBe("passthrough");
  });

  it("returns a SeatbeltSandbox for mode 'seatbelt'", () => {
    const sandbox = selectSandbox("seatbelt");
    expect(sandbox).toBeInstanceOf(SeatbeltSandbox);
    expect(sandbox.name).toBe("seatbelt");
  });

  it("throws on unknown modes", () => {
    expect(() => selectSandbox("bogus" as SandboxMode)).toThrow(/Unknown sandbox mode/);
  });
});
