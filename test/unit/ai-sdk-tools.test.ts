import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallOptions } from "ai";
import { describe, expect, it } from "vitest";
import { buildTools, parseToolSpec } from "../../src/runtimes/ai-sdk/tools";

/**
 * Narrow coverage for pure behaviour and the two tool contracts that
 * aren't just thin wrappers on Node APIs:
 *   - allowlist parsing + filtering,
 *   - Edit's unique-match invariant,
 *   - Bash's non-zero-exit error path.
 *
 * The runtime's tool-loop orchestration is covered by the eval suite
 * end-to-end — mocking generateText here would just test the mock.
 */

// The AI SDK's ToolCallOptions shape is rich; our tools don't consult it,
// so this stub is type-safe-enough without constructing real context.
const NO_OPTS = {} as unknown as ToolCallOptions;

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

describe("buildTools", () => {
  it("keeps only tools whose base name is allowed", () => {
    const tools = buildTools("/tmp", ["Read", "Write(docs/rfcs/*)"]);
    expect(Object.keys(tools).sort()).toEqual(["Read", "Write"]);
  });

  it("silently drops unknown tool names", () => {
    const tools = buildTools("/tmp", ["Read", "NotATool"]);
    expect(Object.keys(tools)).toEqual(["Read"]);
  });

  it("returns an empty map for an empty allowlist", () => {
    expect(Object.keys(buildTools("/tmp", []))).toEqual([]);
  });
});

describe("Edit tool", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ordin-edit-"));
  const tools = buildTools(cwd, ["Edit"]);
  const edit = tools["Edit"]?.execute;
  if (!edit) throw new Error("Edit tool missing execute handler");

  it("rejects when old_string appears multiple times", async () => {
    writeFileSync(join(cwd, "a.txt"), "foo foo bar");
    await expect(
      edit({ file_path: "a.txt", old_string: "foo", new_string: "baz" }, NO_OPTS),
    ).rejects.toThrow(/appears 2×/);
  });

  it("rejects when old_string is not found", async () => {
    writeFileSync(join(cwd, "b.txt"), "hello world");
    await expect(
      edit({ file_path: "b.txt", old_string: "nope", new_string: "x" }, NO_OPTS),
    ).rejects.toThrow(/not found/);
  });

  it("edits when old_string is unique", async () => {
    const file = join(cwd, "c.txt");
    writeFileSync(file, "one two three");
    await edit({ file_path: "c.txt", old_string: "two", new_string: "TWO" }, NO_OPTS);
    expect(readFileSync(file, "utf8")).toBe("one TWO three");
  });
});

describe("Bash tool", () => {
  const tools = buildTools("/tmp", ["Bash"]);
  const bash = tools["Bash"]?.execute;
  if (!bash) throw new Error("Bash tool missing execute handler");

  it("returns stdout on success", async () => {
    const out = await bash({ command: "echo hello" }, NO_OPTS);
    expect(out).toContain("hello");
  });

  it("rejects with exit code on non-zero exit", async () => {
    await expect(bash({ command: "exit 7" }, NO_OPTS)).rejects.toThrow(/exit 7/);
  });
});
