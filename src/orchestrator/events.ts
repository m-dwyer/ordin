import type { TokenUsage } from "../worker/runtimes/types";

/**
 * Unified event stream the orchestrator emits for a run. Consumers get
 * a single temporally-ordered stream that interleaves:
 *
 *   • run lifecycle          (run.started, run.completed)
 *   • phase lifecycle        (phase.started, phase.runtime.completed,
 *                             phase.completed, phase.failed)
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
      readonly type: "phase.runtime.completed";
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
      /** Set when this tool use belongs to a subagent (Task tool). */
      readonly parentToolUseId?: string;
    }
  | {
      readonly type: "agent.tool.result";
      readonly runId: string;
      readonly phaseId: string;
      readonly id: string;
      readonly ok: boolean;
      /**
       * Full tool output as a string. The runtime emits the complete
       * result; consumers (CLI footer, HTTP responses, …) handle their
       * own truncation for display.
       */
      readonly result?: string;
      /** Set when this tool result belongs to a subagent (Task tool). */
      readonly parentToolUseId?: string;
    }
  | {
      readonly type: "agent.timing";
      readonly runId: string;
      readonly phaseId: string;
      readonly name: string;
      readonly durationMs: number;
      readonly status?: "ok" | "error";
      readonly error?: string;
      readonly attributes?: Record<string, string | number | boolean>;
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
