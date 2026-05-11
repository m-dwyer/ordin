import { describe, expect, it } from "vitest";
import { deriveToolPolicy, parseToolSpec } from "./tool-authority";

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
