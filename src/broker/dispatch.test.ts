import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Skill } from "../domain/skill";
import { deriveToolPolicy } from "./client/tool-authority";
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

  it("approves a command matching a Bash pattern", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    broker.registerPhase("run1", "build", ["Bash(git diff*)"]);
    const cwd = await mkdtemp(join(tmpdir(), "broker-bash-pattern-"));

    const approval = await broker.requestApproval({
      tool: "Bash",
      input: { command: "git diff --stat" },
      runId: "run1",
      phaseId: "build",
      cwd,
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(true);
    expect(audit.calls[0]?.payload).toMatchObject({
      tool: "Bash",
      decision: "allow",
    });
  });

  it("denies a command outside a Bash pattern", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    broker.registerPhase("run1", "build", ["Bash(git diff*)"]);
    const cwd = await mkdtemp(join(tmpdir(), "broker-bash-deny-"));

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
    expect(approval.error.message).toContain("does not match");
    expect(audit.calls[0]?.payload).toMatchObject({
      tool: "Bash",
      decision: "deny",
      errorKind: "denied",
    });
  });

  it("approves a file tool matching a path pattern", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    broker.registerPhase("run1", "plan", ["Write(docs/rfcs/*)"]);
    const cwd = await mkdtemp(join(tmpdir(), "broker-write-pattern-"));

    const approval = await broker.requestApproval({
      tool: "Write",
      input: { file_path: "docs/rfcs/example-rfc.md", content: "ok" },
      runId: "run1",
      phaseId: "plan",
      cwd,
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(true);
  });

  it("resolves absolute file paths against the phase cwd before pattern matching", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    const cwd = await mkdtemp(join(tmpdir(), "broker-abs-path-"));
    broker.registerPhase(
      "run1",
      "plan",
      deriveToolPolicy({
        allowedTools: ["Write(docs/rfcs/*)"],
        hasSkills: false,
        cwd,
      }),
    );

    const approval = await broker.requestApproval({
      tool: "Write",
      input: { file_path: join(cwd, "docs/rfcs/abs-rfc.md"), content: "ok" },
      runId: "run1",
      phaseId: "plan",
      cwd,
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(true);
  });

  it("denies a patterned tool when the match field is missing", async () => {
    const audit = new RecordingAudit();
    const broker = new BrokerDispatch({ audit });
    broker.registerPhase("run1", "review", ["Grep(src/*)"]);
    const cwd = await mkdtemp(join(tmpdir(), "broker-missing-pattern-field-"));

    const approval = await broker.requestApproval({
      tool: "Grep",
      input: { pattern: "TODO" },
      runId: "run1",
      phaseId: "review",
      cwd,
      skills: NO_SKILLS,
    });

    expect(approval.ok).toBe(false);
    if (approval.ok) throw new Error("expected deny");
    expect(approval.error.kind).toBe("denied");
    expect(approval.error.message).toContain("no matchable field");
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
