import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../worker/runtimes/types";
import { diagnoseMissingOutputs } from "./phase-diagnostics";

const missing = [{ label: "RFC", path: "docs/rfcs/foo-rfc.md" }];

describe("diagnoseMissingOutputs", () => {
  it("explains when no write-like tool targeted the missing output", () => {
    const events: RuntimeEvent[] = [
      { type: "tool.use", id: "1", name: "Glob", input: { pattern: "**/*" } },
      { type: "assistant.text", text: "I have enough context and will draft the RFC now." },
    ];

    expect(diagnoseMissingOutputs(missing, events, "/runs/foo/plan.jsonl")).toContain(
      "No Write/Edit/Bash tool call appears to target the missing output path(s)",
    );
    expect(diagnoseMissingOutputs(missing, events, "/runs/foo/plan.jsonl")).toContain(
      "Tools used: Glob.",
    );
    expect(diagnoseMissingOutputs(missing, events, "/runs/foo/plan.jsonl")).toContain(
      "Last assistant text: I have enough context",
    );
  });

  it("surfaces a relevant failed write tool", () => {
    const events: RuntimeEvent[] = [
      {
        type: "tool.use",
        id: "1",
        name: "Write",
        input: { file_path: "docs/rfcs/foo-rfc.md", content: "..." },
      },
      { type: "tool.result", id: "1", ok: false, result: "permission denied" },
    ];

    expect(diagnoseMissingOutputs(missing, events, undefined)).toBe(
      "Relevant Write tool call failed for docs/rfcs/foo-rfc.md. Tool error: permission denied",
    );
  });

  it("explains when a relevant tool targeted the path but verification still failed", () => {
    const events: RuntimeEvent[] = [
      {
        type: "tool.use",
        id: "1",
        name: "Write",
        input: { file_path: "/tmp/repo/docs/rfcs/foo-rfc.md", content: "..." },
      },
      { type: "tool.result", id: "1", ok: true },
    ];

    expect(diagnoseMissingOutputs(missing, events, undefined)).toContain(
      "A tool call targeted /tmp/repo/docs/rfcs/foo-rfc.md, but the file was still missing",
    );
  });
});
