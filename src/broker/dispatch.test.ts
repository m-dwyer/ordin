import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Skill } from "../domain/skill";
import { ToolPolicy } from "../domain/tool-policy";
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

describe("BrokerDispatch.requestApproval", () => {
  it("rejects tool calls outside the per-phase ACL and audits the deny", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    broker.registerPhase("run1", "build", ["Read"]);
    const cwd = await mkdtemp(join(tmpdir(), "broker-acl-"));

    const approval = await broker.requestApproval({
      tool: "Bash",
      input: { command: "echo nope" },
      runId: "run1",
      phaseId: "build",
      cwd,
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(false);
    if (approval.ok) throw new Error("expected deny");
    expect(approval.error.kind).toBe("denied");
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
    broker.registerPhase("run1", "build", ["Hammer"]);
    const cwd = await mkdtemp(join(tmpdir(), "broker-unknown-"));

    const approval = await broker.requestApproval({
      tool: "Hammer",
      input: {},
      runId: "run1",
      phaseId: "build",
      cwd,
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(false);
    if (approval.ok) throw new Error("expected deny");
    expect(approval.error.kind).toBe("unknown_tool");
    expect(audit.calls[0]?.payload).toMatchObject({ decision: "deny" });
  });

  it("rejects intents for phases the harness never registered", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });

    const approval = await broker.requestApproval({
      tool: "Read",
      input: { file_path: "note.md" },
      runId: "run-unknown",
      phaseId: "build",
      cwd: "/tmp",
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(false);
    if (approval.ok) throw new Error("expected deny");
    expect(approval.error.kind).toBe("denied");
    expect(approval.error.message).toContain("No ACL registered");
  });

  it("approves and audits an in-ACL intent", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    broker.registerPhase("run1", "build", ["Read"]);
    const cwd = await mkdtemp(join(tmpdir(), "broker-allow-"));

    const approval = await broker.requestApproval({
      tool: "Read",
      input: { file_path: "note.md" },
      runId: "run1",
      phaseId: "build",
      cwd,
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(true);
    expect(audit.calls[0]?.payload).toMatchObject({
      tool: "Read",
      phaseId: "build",
      decision: "allow",
    });
  });

  it("denies a pattern-mismatched intent and audits the deny", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    const cwd = await mkdtemp(join(tmpdir(), "broker-pattern-deny-"));
    broker.registerPhase(
      "run1",
      "build",
      ToolPolicy.from({ allowedTools: ["Bash(git diff*)"], hasSkills: false, cwd }),
    );

    const approval = await broker.requestApproval({
      tool: "Bash",
      input: { command: "npm install" },
      runId: "run1",
      phaseId: "build",
      cwd,
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(false);
    if (approval.ok) throw new Error("expected deny");
    expect(approval.error.kind).toBe("denied");
    expect(audit.calls[0]?.payload).toMatchObject({
      tool: "Bash",
      decision: "deny",
      errorKind: "denied",
    });
  });

  it("releasePhase drops the ACL — subsequent intents are denied", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    broker.registerPhase("run1", "build", ["Read"]);
    broker.releasePhase("run1", "build");

    const approval = await broker.requestApproval({
      tool: "Read",
      input: { file_path: "note.md" },
      runId: "run1",
      phaseId: "build",
      cwd: "/tmp",
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(false);
    if (approval.ok) throw new Error("expected deny");
    expect(approval.error.message).toContain("No ACL registered");
  });
});

describe("BrokerDispatch.recordResult", () => {
  it("appends an ok-result envelope with the worker-reported duration", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });

    await broker.recordResult(
      {
        tool: "Read",
        input: { file_path: "note.md" },
        runId: "run1",
        phaseId: "build",
        cwd: "/tmp",
        skills: NO_SKILLS,
      },
      { result: { ok: true, output: "hello" }, durationMs: 12 },
    );

    expect(audit.calls).toEqual([
      {
        runId: "run1",
        kind: "broker.tool.result",
        payload: { tool: "Read", phaseId: "build", ok: true, durationMs: 12 },
      },
    ]);
  });

  it("appends an error-result envelope carrying the typed error kind + message", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });

    await broker.recordResult(
      {
        tool: "Read",
        input: { file_path: "missing.md" },
        runId: "run1",
        phaseId: "build",
        cwd: "/tmp",
        skills: NO_SKILLS,
      },
      {
        result: { ok: false, error: { kind: "executor", message: "ENOENT: missing.md" } },
        durationMs: 4,
      },
    );

    expect(audit.calls[0]?.payload).toMatchObject({
      ok: false,
      durationMs: 4,
      errorKind: "executor",
      errorMessage: "ENOENT: missing.md",
    });
  });
});
