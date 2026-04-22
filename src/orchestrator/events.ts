import type { RuntimeEvent, TokenUsage } from "../runtimes/types";

/**
 * Unified event stream the orchestrator emits for a run. Consumers get
 * a single temporally-ordered stream that interleaves:
 *
 *   • run lifecycle          (run.started, run.completed)
 *   • phase lifecycle        (phase.started, phase.completed, phase.failed)
 *   • gate lifecycle         (gate.requested, gate.decided)
 *   • runtime observations   (agent.*), tagged with the active phaseId
 *
 * Layer boundary: runtimes don't know about phases — they emit
 * `RuntimeEvent`. The orchestrator wraps those as `agent.*` variants
 * here, tagged with runId + phaseId, and merges them with its own
 * lifecycle events into this single stream.
 */
export type RunEvent =
  | { readonly type: "run.started"; readonly runId: string }
  | {
      readonly type: "run.completed";
      readonly runId: string;
      readonly status: "completed" | "failed" | "halted";
    }
  | {
      readonly type: "phase.started";
      readonly runId: string;
      readonly phaseId: string;
      readonly iteration: number;
      readonly model: string;
      readonly runtime: string;
    }
  | {
      readonly type: "phase.completed";
      readonly runId: string;
      readonly phaseId: string;
      readonly iteration: number;
      readonly tokens: TokenUsage;
      readonly durationMs: number;
    }
  | {
      readonly type: "phase.failed";
      readonly runId: string;
      readonly phaseId: string;
      readonly iteration: number;
      readonly error: string;
    }
  | { readonly type: "gate.requested"; readonly runId: string; readonly phaseId: string }
  | {
      readonly type: "gate.decided";
      readonly runId: string;
      readonly phaseId: string;
      readonly decision: "approved" | "rejected" | "auto";
      readonly note?: string;
      readonly reason?: string;
    }
  | {
      readonly type: "agent.text";
      readonly runId: string;
      readonly phaseId: string;
      readonly text: string;
    }
  | { readonly type: "agent.thinking"; readonly runId: string; readonly phaseId: string }
  | {
      readonly type: "agent.tool.use";
      readonly runId: string;
      readonly phaseId: string;
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "agent.tool.result";
      readonly runId: string;
      readonly phaseId: string;
      readonly id: string;
      readonly ok: boolean;
      readonly preview?: string;
    }
  | {
      readonly type: "agent.tokens";
      readonly runId: string;
      readonly phaseId: string;
      readonly usage: TokenUsage;
    }
  | {
      readonly type: "agent.error";
      readonly runId: string;
      readonly phaseId: string;
      readonly message: string;
    };

/**
 * Promote a runtime-local event into a tagged RunEvent. The orchestrator
 * is the merging point — this function lives here, not in the runtimes
 * layer (which must stay unaware of runId/phaseId).
 */
export function promoteRuntimeEvent(event: RuntimeEvent, runId: string, phaseId: string): RunEvent {
  switch (event.type) {
    case "assistant.text":
      return { type: "agent.text", runId, phaseId, text: event.text };
    case "assistant.thinking":
      return { type: "agent.thinking", runId, phaseId };
    case "tool.use":
      return {
        type: "agent.tool.use",
        runId,
        phaseId,
        id: event.id,
        name: event.name,
        input: event.input,
      };
    case "tool.result":
      return {
        type: "agent.tool.result",
        runId,
        phaseId,
        id: event.id,
        ok: event.ok,
        ...(event.preview !== undefined ? { preview: event.preview } : {}),
      };
    case "tokens":
      return { type: "agent.tokens", runId, phaseId, usage: event.usage };
    case "error":
      return { type: "agent.error", runId, phaseId, message: event.message };
  }
}
