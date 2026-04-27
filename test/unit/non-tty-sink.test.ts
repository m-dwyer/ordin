import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonTtyRunSession } from "../../src/cli/tui/non-tty-sink";
import type { RunEvent } from "../../src/runtime/harness";

/**
 * Tests the non-TTY fallback's RunEvent → stdout-line mapping. This
 * is the path `ordin run` takes when stdout isn't a TTY (CI logs,
 * `| tee out.log`, redirected, ssh w/o -t). The lines flowing to
 * stdout are the user-facing contract — assert on them directly.
 *
 * Also verifies the `NonInteractiveGatePrompter` throws with a
 * helpful message pointing at HTTP + `ordin remote decide`, since
 * that's the only signal a CI user gets when a run hits a gate.
 */

const RUN_ID = "run-test";

describe("nonTtyRunSession", () => {
  let writes: string[];
  let original: typeof process.stdout.write;

  beforeEach(() => {
    writes = [];
    original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = original;
  });

  function lines(): string[] {
    return writes.join("").split("\n").filter(Boolean);
  }

  it("phase.started writes a '▶ <id> — <model>' line", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "phase.started",
      runId: RUN_ID,
      phaseId: "plan",
      iteration: 1,
      model: "claude-sonnet-4-6",
      runtime: "claude-cli",
    });
    expect(lines()).toEqual(["▶ plan — claude-sonnet-4-6"]);
  });

  it("phase.started annotates iteration > 1", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "phase.started",
      runId: RUN_ID,
      phaseId: "build",
      iteration: 3,
      model: "claude-sonnet-4-6",
      runtime: "claude-cli",
    });
    expect(lines()).toEqual(["▶ build (iteration 3) — claude-sonnet-4-6"]);
  });

  it("phase.runtime.completed writes a '✓ <id> — <duration> · out <tokens>' line", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "phase.runtime.completed",
      runId: RUN_ID,
      phaseId: "plan",
      iteration: 1,
      durationMs: 32_400,
      tokens: { input: 100, output: 1840, total: 1940 },
    });
    expect(lines()).toEqual(["✓ plan — 32.4s · out 1,840 tok"]);
  });

  it("phase.failed writes a '✗ <id> failed — <error>' line", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "phase.failed",
      runId: RUN_ID,
      phaseId: "plan",
      iteration: 1,
      error: "boom: something exploded\nstack trace…",
    });
    expect(lines()).toEqual(["✗ plan failed — boom: something exploded"]);
  });

  it("agent.text writes the trimmed text indented", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "agent.text",
      runId: RUN_ID,
      phaseId: "plan",
      text: "  Drafting the RFC.  ",
    });
    expect(lines()).toEqual(["  Drafting the RFC."]);
  });

  it("agent.tool.use writes a '  ▸ <name> · <preview>' line", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "agent.tool.use",
      runId: RUN_ID,
      phaseId: "plan",
      id: "t1",
      name: "Read",
      input: { file_path: "src/auth.ts" },
    });
    expect(lines()).toEqual(["  ▸ Read · src/auth.ts"]);
  });

  it("agent.tool.result writes a failure line only when ok=false", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "agent.tool.use",
      runId: RUN_ID,
      phaseId: "plan",
      id: "t1",
      name: "Bash",
      input: { command: "exit 1" },
    });
    session.onEvent({
      type: "agent.tool.result",
      runId: RUN_ID,
      phaseId: "plan",
      id: "t1",
      ok: false,
      preview: "exited with code 1",
    });
    expect(lines()).toEqual(["  ▸ Bash · exit 1", "  ✗ Bash · exit 1 failed — exited with code 1"]);
  });

  it("agent.tool.result is silent when ok=true (use line already covers it)", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "agent.tool.use",
      runId: RUN_ID,
      phaseId: "plan",
      id: "t1",
      name: "Read",
      input: { file_path: "x.md" },
    });
    session.onEvent({
      type: "agent.tool.result",
      runId: RUN_ID,
      phaseId: "plan",
      id: "t1",
      ok: true,
    });
    expect(lines()).toEqual(["  ▸ Read · x.md"]);
  });

  it("agent.error writes a '  ✗ <message>' line", () => {
    const session = nonTtyRunSession();
    session.onEvent({
      type: "agent.error",
      runId: RUN_ID,
      phaseId: "plan",
      message: "context window exceeded",
    });
    expect(lines()).toEqual(["  ✗ context window exceeded"]);
  });

  it("ignores noisy lifecycle events (run.started / run.completed / agent.tokens / agent.thinking / phase.completed / gate.*)", () => {
    const session = nonTtyRunSession();
    const noisy: RunEvent[] = [
      { type: "run.started", runId: RUN_ID },
      { type: "run.completed", runId: RUN_ID, status: "completed" },
      {
        type: "phase.completed",
        runId: RUN_ID,
        phaseId: "plan",
        iteration: 1,
        durationMs: 1,
        tokens: { input: 0, output: 0, total: 0 },
      },
      { type: "agent.thinking", runId: RUN_ID, phaseId: "plan" },
      {
        type: "agent.tokens",
        runId: RUN_ID,
        phaseId: "plan",
        usage: { input: 10, output: 20, total: 30 },
      },
      { type: "gate.requested", runId: RUN_ID, phaseId: "plan" },
      { type: "gate.decided", runId: RUN_ID, phaseId: "plan", decision: "approved" },
    ];
    for (const ev of noisy) session.onEvent(ev);
    expect(writes).toEqual([]);
  });

  it("gate prompter throws with a message pointing at the HTTP/remote flow", async () => {
    const session = nonTtyRunSession();
    const gate = session.gateForKind("human");
    await expect(
      gate.request({
        runId: RUN_ID,
        phaseId: "plan",
        cwd: "/tmp",
        artefacts: [],
      }),
    ).rejects.toThrow(/cannot prompt for gate at phase "plan" without a TTY.*ordin remote decide/i);
  });
});
