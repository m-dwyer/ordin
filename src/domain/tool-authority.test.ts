import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveToolPolicy,
  isKnownToolName,
  knownToolNames,
  normalizeToolMatchValue,
  normalizeToolPathInput,
  parseToolSpec,
  toolMatchValue,
} from "./tool-authority";

describe("parseToolSpec", () => {
  it("parses name-only tool specs", () => {
    expect(parseToolSpec("Read")).toEqual({ name: "Read", pattern: undefined });
  });

  it("preserves scoped patterns", () => {
    expect(parseToolSpec("Bash(git diff*)")).toEqual({
      name: "Bash",
      pattern: "git diff*",
    });
  });

  it("keeps malformed specs as names for downstream rejection", () => {
    expect(parseToolSpec("Read(broken")).toEqual({
      name: "Read(broken",
      pattern: undefined,
    });
  });
});

describe("deriveToolPolicy", () => {
  it("derives unique exposed tool names while preserving specs", () => {
    expect(
      deriveToolPolicy({
        allowedTools: ["Read", "Read", "Bash(git diff*)", "Bash(git status*)"],
        hasSkills: false,
        cwd: "/cwd",
      }),
    ).toEqual({
      specs: [
        { name: "Read", pattern: undefined },
        { name: "Bash", pattern: "git diff*" },
        { name: "Bash", pattern: "git status*" },
      ],
      toolNames: ["Read", "Bash"],
      cwd: "/cwd",
    });
  });

  it("auto-adds Skill when phase skills exist", () => {
    expect(
      deriveToolPolicy({
        allowedTools: ["Read"],
        hasSkills: true,
        cwd: "/cwd",
      }).toolNames,
    ).toEqual(["Read", "Skill"]);
  });

  it("does not duplicate explicit Skill", () => {
    expect(
      deriveToolPolicy({
        allowedTools: ["Skill"],
        hasSkills: true,
        cwd: "/cwd",
      }).toolNames,
    ).toEqual(["Skill"]);
  });

  it("preserves unknown tool names for the broker to reject", () => {
    expect(
      deriveToolPolicy({
        allowedTools: ["Hammer"],
        hasSkills: false,
        cwd: "/cwd",
      }),
    ).toEqual({
      specs: [{ name: "Hammer", pattern: undefined }],
      toolNames: ["Hammer"],
      cwd: "/cwd",
    });
  });
});

describe("tool catalog", () => {
  it("reports the canonical built-in tool names", () => {
    expect(knownToolNames()).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill"]);
    expect(isKnownToolName("Read")).toBe(true);
    expect(isKnownToolName("Hammer")).toBe(false);
  });

  it("reads match fields from the catalog", () => {
    expect(toolMatchValue("Bash", { command: "git diff --stat" })).toBe("git diff --stat");
    expect(toolMatchValue("Write", { file_path: "docs/rfc.md", content: "ok" })).toBe(
      "docs/rfc.md",
    );
    expect(toolMatchValue("Grep", { pattern: "TODO" })).toBeUndefined();
  });

  it("normalizes absolute path match values relative to cwd for path-bearing tools", () => {
    const cwd = "/workspace/project";
    expect(normalizeToolMatchValue("Write", join(cwd, "docs/rfc.md"), cwd)).toBe("docs/rfc.md");
    expect(normalizeToolMatchValue("Bash", "git diff", cwd)).toBe("git diff");
  });

  it("normalizes absolute execution path input and rejects paths outside cwd", () => {
    const cwd = "/workspace/project";
    expect(normalizeToolPathInput("Read", { file_path: join(cwd, "README.md") }, cwd)).toEqual({
      file_path: "README.md",
    });
    expect(() =>
      normalizeToolPathInput("Read", { file_path: "/workspace/other/README.md" }, cwd),
    ).toThrow(/outside the workspace/);
  });
});
