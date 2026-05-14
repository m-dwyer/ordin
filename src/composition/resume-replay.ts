import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "../orchestrator/events";
import type { RunMeta } from "../orchestrator/run-store";
import { promoteRuntimeEvent } from "../orchestrator/runtime-events";
import type { RuntimeEvent, TokenUsage } from "../worker/runtimes/types";

const ZERO_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  cacheReadInput: 0,
  cacheCreationInput: 0,
  totalInput: 0,
};

/**
 * Replay a resumed run's prior history into a TUI controller (or any
 * `RunEvent` sink) so the live display rebuilds the phase sections,
 * tool calls, and gate decisions that streamed during the original
 * run. Reads `meta.phases` for the lifecycle skeleton and each
 * `<runDir>/<phaseId>.jsonl` for the transcript of agent.* events.
 *
 * For the pending-gate phase the replay stops after
 * `phase.runtime.completed` — `MastraEngine.resume` then emits
 * `gate.requested` live so the prompter (and its `requestGate` UI hook)
 * can take over from the same point a fresh run would reach.
 *
 * All errors are swallowed per-phase: a missing or partially-written
 * transcript shouldn't block resume. The phase section just renders
 * with the meta summary and no rows.
 */
export async function replayResumedHistory(opts: {
  readonly meta: RunMeta;
  readonly runDir: string;
  readonly pushEvent: (event: RunEvent) => void;
}): Promise<void> {
  const { meta, runDir, pushEvent } = opts;
  const pendingGatePhaseId = meta.pendingGate?.phaseId;

  for (const phase of meta.phases) {
    pushEvent({
      type: "phase.started",
      runId: meta.runId,
      phaseId: phase.phaseId,
      iteration: phase.iteration,
      model: phase.model ?? "?",
      runtime: phase.runtime ?? "?",
    });

    await replayTranscript(
      join(runDir, `${phase.phaseId}.jsonl`),
      meta.runId,
      phase.phaseId,
      pushEvent,
    );

    if (phase.tokens && phase.durationMs !== undefined) {
      pushEvent({
        type: "phase.runtime.completed",
        runId: meta.runId,
        phaseId: phase.phaseId,
        iteration: phase.iteration,
        tokens: phase.tokens,
        durationMs: phase.durationMs,
      });
    }

    // Pending-gate phase: stop short of the terminal lifecycle event.
    // The engine will emit gate.requested live for this same phase.
    if (phase.phaseId === pendingGatePhaseId && phase.status === "running") continue;

    if (phase.status === "completed") {
      pushEvent({
        type: "phase.completed",
        runId: meta.runId,
        phaseId: phase.phaseId,
        iteration: phase.iteration,
        tokens: phase.tokens ?? ZERO_TOKENS,
        durationMs: phase.durationMs ?? 0,
      });
    } else if (phase.status === "failed") {
      pushEvent({
        type: "phase.failed",
        runId: meta.runId,
        phaseId: phase.phaseId,
        iteration: phase.iteration,
        error: phase.error ?? "unknown",
      });
    }
    // "rejected" leaves the section without a terminal event — the
    // rejecter's next iteration's phase.started overwrites the row.
  }
}

async function replayTranscript(
  path: string,
  runId: string,
  phaseId: string,
  pushEvent: (event: RunEvent) => void,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    if (!line) continue;
    const event = parseTranscriptLine(line);
    if (!event) continue;
    pushEvent(promoteRuntimeEvent(event, runId, phaseId));
  }
}

function parseTranscriptLine(line: string): RuntimeEvent | undefined {
  try {
    const parsed = JSON.parse(line) as { kind?: string; event?: RuntimeEvent };
    if (parsed.kind !== "event" || !parsed.event) return undefined;
    return parsed.event;
  } catch {
    return undefined;
  }
}
