import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Broker } from "../../src/broker";
import { HttpBrokerClient } from "../../src/broker/client/http";
import { InProcessBrokerClient } from "../../src/broker/client/in-process";
import type { ToolIntent } from "../../src/broker/client/types";
import { BrokerDispatch } from "../../src/broker/dispatch";
import { makeToolServiceHandler } from "../../src/broker/tool-service";

/**
 * Contract test (per Phase B sequencing). Drives the same set of
 * `ToolIntent`s through both `InProcessBrokerClient` (direct method
 * calls) and `HttpBrokerClient` (HTTP+JSON over localhost) against
 * fresh `BrokerDispatch` instances. Asserts that audit envelopes,
 * `ToolResult` shapes, and error kinds match exactly across transports.
 *
 * Failure modes this test catches:
 *   - JSON serialization mutating field order / shapes that the audit
 *     chain hashes over.
 *   - HTTP framing dropping/altering audit payload fields.
 *   - Either transport mistranslating typed errors.
 *
 * The contract is the load-bearing invariant for ADR-018: "transport
 * is a layer above policy". A divergence here is a bug.
 */

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

async function buildPair(): Promise<{
  inProcess: { client: InProcessBrokerClient; audit: RecordingAudit };
  http: { client: HttpBrokerClient; audit: RecordingAudit; stop: () => Promise<void> };
}> {
  const inAudit = new RecordingAudit();
  const inDispatch = new BrokerDispatch({ audit: inAudit });

  const httpAudit = new RecordingAudit();
  const httpDispatch = new BrokerDispatch({ audit: httpAudit });
  const broker = new Broker(
    {},
    {
      proxyAuth: "parity-secret",
      internalServices: [
        {
          kind: "internal",
          name: "tools",
          handler: makeToolServiceHandler(httpDispatch),
        },
      ],
    },
  );
  await broker.start();

  return {
    inProcess: {
      client: new InProcessBrokerClient(inDispatch),
      audit: inAudit,
    },
    http: {
      client: new HttpBrokerClient({
        proxyUrl: `http://ordin:parity-secret@${broker.host}:${broker.port}`,
      }),
      audit: httpAudit,
      stop: () => broker.stop(),
    },
  };
}

describe("broker transport parity", () => {
  let stopBroker: () => Promise<void> = async () => {};

  afterEach(async () => {
    await stopBroker();
    stopBroker = async () => {};
  });

  it("emits identical audit envelopes and ToolResults across transports for a series of intents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "broker-parity-"));
    await writeFile(join(cwd, "hello.txt"), "hi\n", "utf8");

    const pair = await buildPair();
    stopBroker = pair.http.stop;

    const intents: readonly ToolIntent[] = [
      // 1. Allowed read — exercises allow + result envelopes.
      {
        tool: "Read",
        input: { file_path: "hello.txt" },
        runId: "run-A",
        phaseId: "phase",
        cwd,
        allowedTools: ["Read"],
        skills: [],
      },
      // 2. Tool not in ACL — exercises deny envelope.
      {
        tool: "Bash",
        input: { command: "echo nope" },
        runId: "run-A",
        phaseId: "phase",
        cwd,
        allowedTools: ["Read"],
        skills: [],
      },
      // 3. Unknown tool name — exercises unknown_tool error.
      {
        tool: "Hammer",
        input: {},
        runId: "run-A",
        phaseId: "phase",
        cwd,
        allowedTools: ["Hammer"],
        skills: [],
      },
      // 4. Allowed read missing file — exercises executor error.
      {
        tool: "Read",
        input: { file_path: "missing.txt" },
        runId: "run-A",
        phaseId: "phase",
        cwd,
        allowedTools: ["Read"],
        skills: [],
      },
    ];

    const inResults = await Promise.all(
      intents.map((intent) => pair.inProcess.client.dispatchTool(intent)),
    );
    const httpResults = await Promise.all(
      intents.map((intent) => pair.http.client.dispatchTool(intent)),
    );

    expect(httpResults).toEqual(inResults);
    expect(stripDurations(pair.http.audit.calls)).toEqual(
      stripDurations(pair.inProcess.audit.calls),
    );
  });
});

/**
 * `broker.tool.result` envelopes carry a `durationMs` field that
 * naturally varies between transports (HTTP adds round-trip overhead).
 * Strip before equality checking — the parity guard is shape +
 * decision + error kinds, not wall-clock timing.
 */
function stripDurations(calls: readonly AuditCall[]): AuditCall[] {
  return calls.map((c) => {
    if (c.kind !== "broker.tool.result") return c;
    const { durationMs: _ignored, ...rest } = c.payload;
    return { ...c, payload: rest };
  });
}
