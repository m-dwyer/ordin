import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeBash } from "../../src/broker/tools/bash";
import { executeEdit } from "../../src/broker/tools/edit";
import { parseToolSpec } from "../../src/worker/runtimes/shared/tools";

describe("parseToolSpec", () => {
  it("parses a bare name", () => {
    expect(parseToolSpec("Read")).toEqual({ name: "Read", pattern: undefined });
  });

  it("parses a name with pattern", () => {
    expect(parseToolSpec("Write(docs/rfcs/*)")).toEqual({
      name: "Write",
      pattern: "docs/rfcs/*",
    });
  });

  it("trims outer whitespace", () => {
    expect(parseToolSpec("  Bash  ")).toEqual({ name: "Bash", pattern: undefined });
  });

  it("preserves nested content in patterns", () => {
    expect(parseToolSpec("Bash(git log --pretty=format:%H)")).toEqual({
      name: "Bash",
      pattern: "git log --pretty=format:%H",
    });
  });

  it("falls back to the raw string when malformed", () => {
    expect(parseToolSpec("Read(broken")).toEqual({
      name: "Read(broken",
      pattern: undefined,
    });
  });
});

describe("executeEdit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ordin-edit-"));

  it("rejects when old_string appears multiple times", async () => {
    writeFileSync(join(cwd, "a.txt"), "foo foo bar");
    await expect(
      executeEdit(cwd, { file_path: "a.txt", old_string: "foo", new_string: "baz" }),
    ).rejects.toThrow(/appears 2×/);
  });

  it("rejects when old_string is not found", async () => {
    writeFileSync(join(cwd, "b.txt"), "hello world");
    await expect(
      executeEdit(cwd, { file_path: "b.txt", old_string: "nope", new_string: "x" }),
    ).rejects.toThrow(/not found/);
  });

  it("edits when old_string is unique", async () => {
    const file = join(cwd, "c.txt");
    writeFileSync(file, "one two three");
    await executeEdit(cwd, { file_path: "c.txt", old_string: "two", new_string: "TWO" });
    expect(readFileSync(file, "utf8")).toBe("one TWO three");
  });
});

describe("executeBash", () => {
  it("returns stdout on success", async () => {
    const out = await executeBash("/tmp", { command: "echo hello" });
    expect(out).toContain("hello");
  });

  it("rejects with exit code on non-zero exit", async () => {
    await expect(executeBash("/tmp", { command: "exit 7" })).rejects.toThrow(/exit 7/);
  });

  it("runs without shell startup files and disables git global config", async () => {
    const out = await executeBash("/tmp", {
      command:
        'test -z "$BASH_ENV" && test "$GIT_CONFIG_GLOBAL" = /dev/null && test "$GIT_CONFIG_NOSYSTEM" = 1 && echo clean-env',
    });
    expect(out).toContain("clean-env");
  });
});
