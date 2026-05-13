import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolPolicy } from "./tool-policy";

describe("ToolPolicy.from", () => {
  it("dedupes specs and exposes the unique tool names", () => {
    const policy = ToolPolicy.from({
      allowedTools: ["Read", "Read", "Bash(git diff*)", "Bash(git status*)"],
      hasSkills: false,
      cwd: "/cwd",
    });
    expect([...policy.toolNames()].sort()).toEqual(["Bash", "Read"]);
  });

  it("auto-adds Skill when phase has skills", () => {
    const policy = ToolPolicy.from({
      allowedTools: ["Read"],
      hasSkills: true,
      cwd: "/cwd",
    });
    expect([...policy.toolNames()].sort()).toEqual(["Read", "Skill"]);
  });

  it("preserves unknown tool names so the broker's catalog check still rejects them", () => {
    const policy = ToolPolicy.from({
      allowedTools: ["Hammer"],
      hasSkills: false,
      cwd: "/cwd",
    });
    expect(policy.toolNames()).toEqual(["Hammer"]);
  });
});

describe("ToolPolicy.decide", () => {
  it("rejects tools that aren't in the allowlist", () => {
    const policy = ToolPolicy.from({
      allowedTools: ["Read"],
      hasSkills: false,
      cwd: "/cwd",
    });
    const decision = policy.decide({ tool: "Bash", input: { command: "echo hi" } });
    expect(decision).toEqual({
      ok: false,
      reason: "tool_not_allowed",
      message: expect.stringContaining("Bash"),
    });
  });

  it("allows a bare name spec without checking patterns", () => {
    const policy = ToolPolicy.from({
      allowedTools: ["Read"],
      hasSkills: false,
      cwd: "/cwd",
    });
    expect(policy.decide({ tool: "Read", input: { file_path: "README.md" } })).toEqual({
      ok: true,
    });
  });

  it("allows pattern matches and rejects non-matches with reason pattern_mismatch", () => {
    const policy = ToolPolicy.from({
      allowedTools: ["Bash(git diff*)"],
      hasSkills: false,
      cwd: "/cwd",
    });
    expect(policy.decide({ tool: "Bash", input: { command: "git diff --stat" } })).toEqual({
      ok: true,
    });
    expect(policy.decide({ tool: "Bash", input: { command: "npm install" } })).toEqual({
      ok: false,
      reason: "pattern_mismatch",
      message: expect.stringContaining("does not match"),
    });
  });

  it("rejects with reason missing_match_field when the pattern has nothing to match against", () => {
    const policy = ToolPolicy.from({
      allowedTools: ["Grep(src/*)"],
      hasSkills: false,
      cwd: "/cwd",
    });
    expect(policy.decide({ tool: "Grep", input: { pattern: "TODO" } })).toEqual({
      ok: false,
      reason: "missing_match_field",
      message: expect.stringContaining("no matchable field"),
    });
  });

  it("normalizes absolute path inputs against the policy cwd before pattern matching", () => {
    const cwd = "/workspace/project";
    const policy = ToolPolicy.from({
      allowedTools: ["Write(docs/rfcs/*)"],
      hasSkills: false,
      cwd,
    });
    expect(
      policy.decide({
        tool: "Write",
        input: { file_path: join(cwd, "docs/rfcs/abs.md"), content: "ok" },
      }),
    ).toEqual({ ok: true });
  });
});
