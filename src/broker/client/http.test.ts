import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  return {
    broker,
    client,
    cleanup: () => broker.stop(),
  };
}

describe("HttpBrokerClient", () => {
  let cwd: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "http-broker-"));
    cleanup = async () => {};
  });

  afterEach(async () => {
    await cleanup();
  });

  it("round-trips a successful tool dispatch through HTTP", async () => {
    await writeFile(join(cwd, "note.md"), "hello\n", "utf8");
    const audit = new RecordingAudit();
    const setup = await startBroker(audit);
    cleanup = setup.cleanup;

    const result = await setup.client.dispatchTool({
      tool: "Read",
      input: { file_path: "note.md" },
      runId: "run1",
      phaseId: "probe",
      cwd,
      allowedTools: ["Read"],
      skills: [],
    });

    if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
    expect(result.output).toBe("hello\n");
    expect(audit.calls.map((c) => c.kind)).toEqual(["broker.tool.dispatch", "broker.tool.result"]);
    expect(audit.calls[0]?.payload).toMatchObject({ tool: "Read", decision: "allow" });
    expect(audit.calls[1]?.payload).toMatchObject({ tool: "Read", ok: true });
  });

  it("serializes a denied result over HTTP without throwing", async () => {
    const audit = new RecordingAudit();
    const setup = await startBroker(audit);
    cleanup = setup.cleanup;

    const result = await setup.client.dispatchTool({
      tool: "Bash",
      input: { command: "echo nope" },
      runId: "run1",
      phaseId: "probe",
      cwd,
      allowedTools: ["Read"],
      skills: [],
    });

    if (result.ok) throw new Error("expected deny");
    expect(result.error.kind).toBe("denied");
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]?.payload).toMatchObject({
      tool: "Bash",
      decision: "deny",
      errorKind: "denied",
    });
  });

  it("serializes an executor error result over HTTP without throwing", async () => {
    const audit = new RecordingAudit();
    const setup = await startBroker(audit);
    cleanup = setup.cleanup;

    const result = await setup.client.dispatchTool({
      tool: "Read",
      input: { file_path: "missing.md" },
      runId: "run1",
      phaseId: "probe",
      cwd,
      allowedTools: ["Read"],
      skills: [],
    });

    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("executor");
    expect(result.error.message).toMatch(/ENOENT|missing/i);
  });

  it("rejects unauthenticated requests at the proxy layer", async () => {
    const audit = new RecordingAudit();
    const setup = await startBroker(audit);
    cleanup = setup.cleanup;

    const wrongAuthClient = new HttpBrokerClient({
      proxyUrl: `http://ordin:wrong-secret@${setup.broker.host}:${setup.broker.port}`,
    });

    await expect(
      wrongAuthClient.dispatchTool({
        tool: "Read",
        input: { file_path: "note.md" },
        runId: "run1",
        phaseId: "probe",
        cwd,
        allowedTools: ["Read"],
        skills: [],
      }),
    ).rejects.toBeInstanceOf(BrokerTransportError);
    expect(audit.calls).toHaveLength(0);
  });
});
