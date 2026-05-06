import { afterEach, describe, expect, it } from "vitest";
import { Broker } from "../../src/broker";
import { HttpBrokerClient } from "../../src/broker/client/http";
import { InProcessBrokerClient } from "../../src/broker/client/in-process";
import type { ApprovalResult, RecordedResult, ToolIntent } from "../../src/broker/client/types";
import { BrokerDispatch } from "../../src/broker/dispatch";
import { makeToolServiceHandler } from "../../src/broker/tool-service";

/**
 * Contract test (per Phase B sequencing). Drives the same set of
 * `(intent, recorded)` pairs through both `InProcessBrokerClient`
 * (direct method calls) and `HttpBrokerClient` (HTTP+JSON over
 * localhost) against fresh `BrokerDispatch` instances. Asserts that
 * the audit envelope sequences match exactly across transports for
 * both legs (`requestApproval` + `recordResult`).
 *
 * Failure modes this test catches:
 *   - JSON serialization mutating field order / shapes that the audit
 *     chain hashes over.
 *   - HTTP framing dropping/altering audit payload fields.
 *   - Either transport mistranslating typed errors.
 *
 * The contract is the load-bearing invariant for ADR-018: "transport
 * is a layer above policy". Divergence here is a bug.
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
        { kind: "internal", name: "tools", handler: makeToolServiceHandler(httpDispatch) },
      ],
    },
  );
  await broker.start();

  return {
    inProcess: { client: new InProcessBrokerClient(inDispatch), audit: inAudit },
    http: {
      client: new HttpBrokerClient({
        proxyUrl: `http://ordin:parity-secret@${broker.host}:${broker.port}`,
      }),
      audit: httpAudit,
      stop: () => broker.stop(),
    },
  };
}

interface Step {
  readonly intent: ToolIntent;
  /** What the worker would report after running the executor. */
  readonly recorded: RecordedResult;
}

describe("broker transport parity", () => {
  let stopBroker: () => Promise<void> = async () => {};

  afterEach(async () => {
    await stopBroker();
    stopBroker = async () => {};
  });

  it("emits identical audit envelopes across transports for a sequence of approval + result pairs", async () => {
    const pair = await buildPair();
    stopBroker = pair.http.stop;

    const steps: readonly Step[] = [
      // 1. Allowed read — broker approves, worker reports success.
      {
        intent: makeIntent({
          tool: "Read",
          input: { file_path: "hello.txt" },
          allowedTools: ["Read"],
        }),
        recorded: { result: { ok: true, output: "hi\n" }, durationMs: 4 },
      },
      // 2. Tool not in ACL — broker denies; the worker would not run
      //    anything, but we still record the (denied) outcome to keep
      //    the result envelope alongside the dispatch envelope.
      {
        intent: makeIntent({
          tool: "Bash",
          input: { command: "echo nope" },
          allowedTools: ["Read"],
        }),
        recorded: {
          result: { ok: false, error: { kind: "denied", message: "denied by ACL" } },
          durationMs: 0,
        },
      },
      // 3. Unknown tool name — broker denies with a different kind.
      {
        intent: makeIntent({ tool: "Hammer", input: {}, allowedTools: ["Hammer"] }),
        recorded: {
          result: { ok: false, error: { kind: "unknown_tool", message: "unknown" } },
          durationMs: 0,
        },
      },
      // 4. Allowed read whose executor failed — broker approves;
      //    worker reports executor error.
      {
        intent: makeIntent({
          tool: "Read",
          input: { file_path: "missing.txt" },
          allowedTools: ["Read"],
        }),
        recorded: {
          result: {
            ok: false,
            error: { kind: "executor", message: "ENOENT: missing.txt" },
          },
          durationMs: 7,
        },
      },
    ];

    const inApprovals: ApprovalResult[] = [];
    for (const step of steps) {
      inApprovals.push(await pair.inProcess.client.requestApproval(step.intent));
      await pair.inProcess.client.recordResult(step.intent, step.recorded);
    }
    const httpApprovals: ApprovalResult[] = [];
    for (const step of steps) {
      httpApprovals.push(await pair.http.client.requestApproval(step.intent));
      await pair.http.client.recordResult(step.intent, step.recorded);
    }

    expect(httpApprovals).toEqual(inApprovals);
    expect(pair.http.audit.calls).toEqual(pair.inProcess.audit.calls);
  });
});

function makeIntent(
  overrides: Partial<ToolIntent> & Pick<ToolIntent, "tool" | "input" | "allowedTools">,
): ToolIntent {
  return {
    runId: "run-A",
    phaseId: "phase",
    cwd: "/tmp",
    skills: [],
    ...overrides,
  };
}
