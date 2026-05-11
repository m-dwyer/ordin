import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClaudeBin } from "./resolve-claude-bin";

describe("resolveClaudeBin", () => {
  it("resolves a bare override through the parent PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-bin-"));
    const bin = join(dir, "claude");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(bin, 0o755);

    expect(resolveClaudeBin("claude", { PATH: dir })).toBe(bin);
  });

  it("lets CLAUDE_BIN provide the command when no override is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-bin-"));
    const bin = join(dir, "custom-claude");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(bin, 0o755);

    expect(resolveClaudeBin(undefined, { PATH: dir, CLAUDE_BIN: "custom-claude" })).toBe(bin);
  });

  it("preserves absolute paths and unknown bare commands", () => {
    expect(resolveClaudeBin("/opt/claude", { PATH: "" })).toBe("/opt/claude");
    expect(resolveClaudeBin("missing-claude", { PATH: "" })).toBe("missing-claude");
  });
});
