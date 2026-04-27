import { describe, expect, it } from "vitest";
import { buildRenderPlan, linkUrl, prettifyDetail } from "../../src/cli/tui/format";
import type { FeedRow } from "../../src/cli/tui/types";

/**
 * Pure helpers extracted from `run-app.tsx` so they can be unit-tested
 * without standing up the OpenTUI/Solid render machinery. Anything that
 * reaches into JSX or @opentui/core stays on the rendering side; this
 * file owns the logic regressions worth catching at unit level.
 */

function tool(id: number, name: string, detail?: string): FeedRow {
  return { id, kind: "tool", tool: name, ...(detail !== undefined ? { detail } : {}) };
}

function note(id: number, body: string): FeedRow {
  return { id, kind: "note", detail: body };
}

describe("buildRenderPlan", () => {
  it("emits a single 'row' item per non-collapsible row, preserving order", () => {
    const rows: FeedRow[] = [
      tool(1, "Bash", "ls"),
      note(2, "starting up"),
      tool(3, "Skill", "rfc-template"),
    ];

    const plan = buildRenderPlan(rows);

    expect(plan).toHaveLength(3);
    expect(plan.map((p) => p.kind)).toEqual(["row", "row", "row"]);
    expect((plan[0] as { row: FeedRow }).row.id).toBe(1);
    expect((plan[2] as { row: FeedRow }).row.id).toBe(3);
  });

  it("groups 3+ adjacent Read/Glob/Grep tools under a single 'group' item anchored at the first row", () => {
    const rows: FeedRow[] = [
      tool(1, "Read", "/a.ts"),
      tool(2, "Glob", "**/*.md"),
      tool(3, "Grep", "TODO"),
    ];

    const plan = buildRenderPlan(rows);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.kind).toBe("group");
    const group = plan[0] as { kind: "group"; id: number; rows: readonly FeedRow[] };
    expect(group.id).toBe(1);
    expect(group.rows).toHaveLength(3);
    expect(group.rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("does NOT group runs of 2 (under threshold) — they emit as standalone rows", () => {
    const rows: FeedRow[] = [tool(1, "Read", "/a.ts"), tool(2, "Read", "/b.ts")];

    const plan = buildRenderPlan(rows);

    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.kind === "row")).toBe(true);
  });

  it("breaks groups when a non-exploration tool interrupts the run", () => {
    const rows: FeedRow[] = [
      tool(1, "Read", "/a.ts"),
      tool(2, "Glob", "**/*.md"),
      tool(3, "Bash", "ls"), // breaks the run
      tool(4, "Read", "/b.ts"),
      tool(5, "Read", "/c.ts"),
      tool(6, "Read", "/d.ts"),
    ];

    const plan = buildRenderPlan(rows);

    // Read + Glob: 2 explorers under threshold → 2 standalone rows
    // Bash: standalone row
    // Three Reads: meets threshold, collapsed into one group anchored at id 4
    expect(plan).toHaveLength(4);
    expect(plan.map((p) => p.kind)).toEqual(["row", "row", "row", "group"]);
    const group = plan[3] as { kind: "group"; id: number; rows: readonly FeedRow[] };
    expect(group.id).toBe(4);
    expect(group.rows).toHaveLength(3);
  });

  it("preserves the original FeedRow object identity inside groups (no copying)", () => {
    const a = tool(1, "Read", "/a.ts");
    const rows: FeedRow[] = [a, tool(2, "Glob", "**/*.md"), tool(3, "Grep", "TODO")];

    const plan = buildRenderPlan(rows);
    const group = plan[0] as { kind: "group"; rows: readonly FeedRow[] };

    expect(group.rows[0]).toBe(a);
  });
});

describe("linkUrl", () => {
  it("file tools get a file:// URI for cmd-click", () => {
    expect(linkUrl("Read", "/abs/path/foo.ts")).toBe("file:///abs/path/foo.ts");
    expect(linkUrl("Edit", "/abs/path/bar.ts")).toBe("file:///abs/path/bar.ts");
    expect(linkUrl("Write", "/abs/path/baz.ts")).toBe("file:///abs/path/baz.ts");
    expect(linkUrl("MultiEdit", "/abs/path/qux.ts")).toBe("file:///abs/path/qux.ts");
    expect(linkUrl("NotebookEdit", "/abs/path/nb.ipynb")).toBe("file:///abs/path/nb.ipynb");
  });

  it("URL-encodes path segments so spaces and unicode don't break the OSC 8 escape", () => {
    expect(linkUrl("Read", "/with spaces/é.ts")).toBe("file:///with%20spaces/%C3%A9.ts");
  });

  it("WebFetch passes the URL through unchanged", () => {
    expect(linkUrl("WebFetch", "https://example.com/docs")).toBe("https://example.com/docs");
  });

  it("non-file, non-WebFetch tools get no link (Glob, Grep, Bash, Skill)", () => {
    expect(linkUrl("Glob", "**/*.ts")).toBeUndefined();
    expect(linkUrl("Grep", "TODO")).toBeUndefined();
    expect(linkUrl("Bash", "ls -la")).toBeUndefined();
    expect(linkUrl("Skill", "rfc-template")).toBeUndefined();
  });

  it("returns undefined when detail is missing", () => {
    expect(linkUrl("Read", undefined)).toBeUndefined();
    expect(linkUrl("Read", "")).toBeUndefined();
  });
});

describe("prettifyDetail", () => {
  it("file tool path is shortened relative to repoPath", () => {
    expect(prettifyDetail("Read", "/repo/src/foo.ts", "/repo")).toBe("src/foo.ts");
    expect(prettifyDetail("Edit", "/repo/a/b/c.ts", "/repo")).toBe("a/b/c.ts");
  });

  it("file tool path stays absolute when repoPath is omitted or doesn't match", () => {
    expect(prettifyDetail("Read", "/elsewhere/foo.ts", "/repo")).toBe("/elsewhere/foo.ts");
    expect(prettifyDetail("Read", "/abs/foo.ts")).toBe("/abs/foo.ts");
  });

  it("non-file tools pass detail through unchanged (Bash command, Glob pattern, Skill name)", () => {
    expect(prettifyDetail("Bash", "ls -la", "/repo")).toBe("ls -la");
    expect(prettifyDetail("Glob", "**/*.test.ts", "/repo")).toBe("**/*.test.ts");
    expect(prettifyDetail("Skill", "rfc-template", "/repo")).toBe("rfc-template");
  });

  it("returns empty string when detail is missing — caller treats it as 'no detail'", () => {
    expect(prettifyDetail("Read", undefined)).toBe("");
    expect(prettifyDetail("Bash", undefined)).toBe("");
  });

  it("returns detail unchanged when tool name is unknown", () => {
    expect(prettifyDetail(undefined, "/some/path")).toBe("/some/path");
  });
});
