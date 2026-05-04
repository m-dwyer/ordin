import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolDispatcher } from "./dispatcher";

describe("ToolDispatcher", () => {
  it("normalizes absolute file paths inside cwd before executing file tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dispatcher-cwd-"));
    await mkdir(join(cwd, "docs"), { recursive: true });
    const dispatcher = new ToolDispatcher();

    const result = await dispatcher.dispatch(
      "Write",
      { file_path: join(cwd, "docs", "note.md"), content: "hello" },
      { cwd, skills: [] },
    );

    expect(result).toBe("Wrote 5 bytes to docs/note.md");
    expect(await readFile(join(cwd, "docs", "note.md"), "utf8")).toBe("hello");
  });

  it("rejects absolute file paths outside cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dispatcher-cwd-"));
    const outside = await mkdtemp(join(tmpdir(), "dispatcher-outside-"));
    const dispatcher = new ToolDispatcher();

    await expect(
      dispatcher.dispatch(
        "Write",
        { file_path: join(outside, "note.md"), content: "hello" },
        { cwd, skills: [] },
      ),
    ).rejects.toThrow(/outside the workspace/);
  });
});
