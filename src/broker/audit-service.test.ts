import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChainText } from "./audit-chain";
import { AuditService } from "./audit-service";

describe("AuditService", () => {
  let runStoreDir: string;
  let audit: AuditService;

  beforeEach(async () => {
    runStoreDir = await mkdtemp(join(tmpdir(), "audit-svc-"));
    audit = new AuditService({
      runStoreDir,
      onWarn: () => {},
      now: () => "2026-05-02T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    await audit.closeAll();
    await rm(runStoreDir, { recursive: true, force: true });
  });

  it("appends events to per-run audit.jsonl and produces a verifiable chain", async () => {
    await audit.appendEvent({ runId: "run-A", kind: "run.started", payload: { runId: "run-A" } });
    await audit.appendEvent({
      runId: "run-A",
      kind: "phase.started",
      payload: { runId: "run-A", phaseId: "plan", iteration: 1 },
    });
    await audit.appendEvent({
      runId: "run-A",
      kind: "run.completed",
      payload: { runId: "run-A", status: "completed" },
    });

    const text = await readFile(join(runStoreDir, "run-A", "audit.jsonl"), "utf8");
    expect(verifyChainText(text)).toEqual({ ok: true, entries: 3 });
  });

  it("isolates concurrent runs into separate chain files", async () => {
    await audit.appendEvent({ runId: "run-X", kind: "run.started", payload: {} });
    await audit.appendEvent({ runId: "run-Y", kind: "run.started", payload: {} });
    await audit.appendEvent({ runId: "run-X", kind: "phase.started", payload: {} });
    await audit.appendEvent({ runId: "run-Y", kind: "phase.started", payload: {} });

    const x = await readFile(join(runStoreDir, "run-X", "audit.jsonl"), "utf8");
    const y = await readFile(join(runStoreDir, "run-Y", "audit.jsonl"), "utf8");
    expect(verifyChainText(x)).toEqual({ ok: true, entries: 2 });
    expect(verifyChainText(y)).toEqual({ ok: true, entries: 2 });
  });

  it("egressSink records broker.* events into the active run's chain", async () => {
    await audit.appendEvent({ runId: "run-B", kind: "run.started", payload: { runId: "run-B" } });
    audit.egressSink()({
      kind: "broker.connect",
      payload: { host: "github.com", port: 443 },
    });
    // egressSink is fire-and-forget; allow the append to land before
    // the closing event.
    await new Promise((r) => setTimeout(r, 10));
    await audit.appendEvent({
      runId: "run-B",
      kind: "run.completed",
      payload: { runId: "run-B", status: "completed" },
    });

    const text = await readFile(join(runStoreDir, "run-B", "audit.jsonl"), "utf8");
    expect(verifyChainText(text)).toEqual({ ok: true, entries: 3 });
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string });
    expect(lines.map((l) => l.kind)).toEqual(["run.started", "broker.connect", "run.completed"]);
  });

  it("egressSink drops events when no run is active and warns", async () => {
    const warnings: string[] = [];
    const orphaned = new AuditService({
      runStoreDir,
      onWarn: (m) => warnings.push(m),
      now: () => "2026-05-02T00:00:00.000Z",
    });
    orphaned.egressSink()({
      kind: "broker.connect",
      payload: { host: "x", port: 1 },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(warnings).toContain("dropped pre-run broker observation: broker.connect");
    await orphaned.closeAll();
  });

  it("serializes concurrent first-touch appends — single writer per run", async () => {
    // Production shape: audit emitter posts run.started while broker
    // egressSink fires broker.connect, both before any writer is in
    // the cache. Without Promise-caching in writerFor, both create
    // separate writers, both start at seq=0 → corrupted chain.
    const all = await Promise.all([
      audit.appendEvent({ runId: "run-Z", kind: "run.started", payload: {} }),
      audit.appendEvent({ runId: "run-Z", kind: "phase.started", payload: {} }),
      audit.appendEvent({ runId: "run-Z", kind: "agent.tool.use", payload: {} }),
      audit.appendEvent({ runId: "run-Z", kind: "agent.tool.result", payload: {} }),
      audit.appendEvent({ runId: "run-Z", kind: "phase.completed", payload: {} }),
    ]);
    expect(all).toHaveLength(5);
    const text = await readFile(join(runStoreDir, "run-Z", "audit.jsonl"), "utf8");
    expect(verifyChainText(text)).toEqual({ ok: true, entries: 5 });
  });

  it("captures trailing broker.* events that arrive after run.completed", async () => {
    // Real-world shape: OTel BatchSpanProcessor flushes during process
    // shutdown, AFTER the engine has emitted run.completed. The broker
    // receives those forwards and emits broker.forward. Those events
    // must land in the chain — dropping them would erase the telemetry
    // egress audit trail.
    await audit.appendEvent({ runId: "run-T", kind: "run.started", payload: {} });
    await audit.appendEvent({
      runId: "run-T",
      kind: "run.completed",
      payload: { status: "completed" },
    });
    audit.egressSink()({
      kind: "broker.forward",
      payload: { service: "otel", method: "POST", path: "/api/public/otel/v1/traces" },
    });
    await new Promise((r) => setTimeout(r, 10));

    const text = await readFile(join(runStoreDir, "run-T", "audit.jsonl"), "utf8");
    expect(verifyChainText(text)).toEqual({ ok: true, entries: 3 });
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string });
    expect(lines.map((l) => l.kind)).toEqual(["run.started", "run.completed", "broker.forward"]);
  });
});
