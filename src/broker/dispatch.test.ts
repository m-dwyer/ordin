import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Skill } from "../domain/skill";
import { BrokerDispatch } from "./dispatch";

interface AuditAppendCall {
  readonly runId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

class RecordingAudit {
  readonly calls: AuditAppendCall[] = [];
  append(event: AuditAppendCall): void {
    this.calls.push(event);
  }
}

const NO_SKILLS: readonly Skill[] = [];

describe("BrokerDispatch", () => {
  it("rejects tool calls outside the per-phase ACL and audits the deny", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    const cwd = await mkdtemp(join(tmpdir(), "broker-acl-"));

    const result = await broker.dispatchTool({
      tool: "Bash",
      input: { command: "echo nope" },
      runId: "run1",
      phaseId: "build",
      cwd,
      allowedTools: ["Read"],
      skills: NO_SKILLS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected deny");
    expect(result.error.kind).toBe("denied");
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]?.kind).toBe("broker.tool.dispatch");
    expect(audit.calls[0]?.payload).toMatchObject({
      tool: "Bash",
      decision: "deny",
      errorKind: "denied",
    });
  });

  it("rejects unknown tool names with audit envelope", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    const cwd = await mkdtemp(join(tmpdir(), "broker-unknown-"));

    const result = await broker.dispatchTool({
      tool: "Hammer",
      input: {},
      runId: "run1",
      phaseId: "build",
      cwd,
      allowedTools: ["Hammer"],
      skills: NO_SKILLS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected deny");
    expect(result.error.kind).toBe("unknown_tool");
    expect(audit.calls[0]?.payload).toMatchObject({ decision: "deny" });
  });

  it("normalizes absolute file paths inside cwd before executing file tools", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    const cwd = await mkdtemp(join(tmpdir(), "broker-write-"));
    await mkdir(join(cwd, "docs"), { recursive: true });

    const result = await broker.dispatchTool({
      tool: "Write",
      input: { file_path: join(cwd, "docs", "note.md"), content: "hello" },
      runId: "run1",
      phaseId: "build",
      cwd,
      allowedTools: ["Write"],
      skills: NO_SKILLS,
    });

    if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
    expect(result.output).toBe("Wrote 5 bytes to docs/note.md");
    expect(await readFile(join(cwd, "docs", "note.md"), "utf8")).toBe("hello");
  });

  it("rejects absolute file paths outside cwd as input errors", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    const cwd = await mkdtemp(join(tmpdir(), "broker-cwd-"));
    const outside = await mkdtemp(join(tmpdir(), "broker-outside-"));

    const result = await broker.dispatchTool({
      tool: "Write",
      input: { file_path: join(outside, "note.md"), content: "hello" },
      runId: "run1",
      phaseId: "build",
      cwd,
      allowedTools: ["Write"],
      skills: NO_SKILLS,
    });

    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("input");
    expect(result.error.message).toMatch(/outside the workspace/);
  });

  it("appends a chained dispatch + result envelope on success", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    const cwd = await mkdtemp(join(tmpdir(), "broker-chain-"));

    const result = await broker.dispatchTool({
      tool: "Bash",
      input: { command: "echo hello" },
      runId: "run1",
      phaseId: "build",
      cwd,
      allowedTools: ["Bash"],
      skills: NO_SKILLS,
    });

    if (!result.ok) throw new Error("expected ok");
    expect(result.output).toContain("hello");
    expect(audit.calls.map((c) => c.kind)).toEqual(["broker.tool.dispatch", "broker.tool.result"]);
    expect(audit.calls[0]?.payload).toMatchObject({
      tool: "Bash",
      phaseId: "build",
      decision: "allow",
    });
    expect(audit.calls[1]?.payload).toMatchObject({
      tool: "Bash",
      phaseId: "build",
      ok: true,
    });
  });
});
