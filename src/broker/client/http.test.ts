import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Skill } from "../../domain/skill";
import { BrokerDispatch } from "../dispatch";
import { Broker } from "../index";
import { makeToolServiceHandler } from "../tool-service";
import { BrokerTransportError, HttpBrokerClient } from "./http";

interface AuditCall {
  readonly runId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

class RecordingAudit {
  readonly calls: AuditCall[] = [];
  append(event: AuditCall): void {
    this.calls.push(event);
  }
}

async function startBroker(audit: RecordingAudit): Promise<{
  broker: Broker;
  dispatch: BrokerDispatch;
  client: HttpBrokerClient;
  cleanup: () => Promise<void>;
}> {
  const dispatch = new BrokerDispatch({ audit });
  const broker = new Broker(
    {},
    {
      proxyAuth: "test-secret",
      internalServices: [
        {
          kind: "internal",
          name: "tools",
          handler: makeToolServiceHandler(dispatch),
        },
      ],
    },
  );
  await broker.start();
  const client = new HttpBrokerClient({
    proxyUrl: `http://ordin:test-secret@${broker.host}:${broker.port}`,
  });
  return { broker, dispatch, client, cleanup: () => broker.stop() };
}

const NO_SKILLS: readonly Skill[] = [];

describe("HttpBrokerClient.requestApproval", () => {
  let cleanup: () => Promise<void>;
  beforeEach(() => {
    cleanup = async () => {};
  });
  afterEach(async () => {
    await cleanup();
  });

  it("returns an approval for an in-ACL intent and audits the dispatch envelope", async () => {
    const audit = new RecordingAudit();
    const setup = await startBroker(audit);
    cleanup = setup.cleanup;

    setup.dispatch.registerPhase("run1", "probe", ["Read"]);
    const approval = await setup.client.requestApproval({
      tool: "Read",
      input: { file_path: "note.md" },
      runId: "run1",
      phaseId: "probe",
      cwd: "/tmp",
      skills: NO_SKILLS,
    });

    expect(approval).toEqual({ ok: true });
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]?.payload).toMatchObject({ tool: "Read", decision: "allow" });
  });

  it("serializes a typed deny over HTTP without throwing", async () => {
    const audit = new RecordingAudit();
    const setup = await startBroker(audit);
    cleanup = setup.cleanup;

    setup.dispatch.registerPhase("run1", "probe", ["Read"]);
    const approval = await setup.client.requestApproval({
      tool: "Bash",
      input: { command: "echo nope" },
      runId: "run1",
      phaseId: "probe",
      cwd: "/tmp",
      skills: NO_SKILLS,
    });

    if (approval.ok) throw new Error("expected deny");
    expect(approval.error.kind).toBe("denied");
    expect(audit.calls[0]?.payload).toMatchObject({
      tool: "Bash",
      decision: "deny",
      errorKind: "denied",
    });
  });

  it("rejects unauthenticated requests at the proxy layer", async () => {
    const audit = new RecordingAudit();
    const setup = await startBroker(audit);
    cleanup = setup.cleanup;

    const wrongAuthClient = new HttpBrokerClient({
      proxyUrl: `http://ordin:wrong-secret@${setup.broker.host}:${setup.broker.port}`,
    });

    await expect(
      wrongAuthClient.requestApproval({
        tool: "Read",
        input: { file_path: "note.md" },
        runId: "run1",
        phaseId: "probe",
        cwd: "/tmp",
        skills: NO_SKILLS,
      }),
    ).rejects.toBeInstanceOf(BrokerTransportError);
    expect(audit.calls).toHaveLength(0);
  });
});

describe("HttpBrokerClient.recordResult", () => {
  let cleanup: () => Promise<void>;
  beforeEach(() => {
    cleanup = async () => {};
  });
  afterEach(async () => {
    await cleanup();
  });

  it("appends a result envelope with the worker-reported duration", async () => {
    const audit = new RecordingAudit();
    const setup = await startBroker(audit);
    cleanup = setup.cleanup;

    const intent = {
      tool: "Read",
      input: { file_path: "note.md" },
      runId: "run1",
      phaseId: "probe",
      cwd: "/tmp",
      skills: NO_SKILLS,
    };
    await setup.client.recordResult(intent, {
      result: { ok: true, output: "hello" },
      durationMs: 17,
    });

    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      kind: "broker.tool.result",
      payload: { tool: "Read", ok: true, durationMs: 17 },
    });
  });
});
