import type { RunEvent } from "../orchestrator/events";
import type { RuntimeEvent } from "./runtimes/types";

/**
 * Promote a runtime-local event into a tagged RunEvent. Lives worker-
 * side because only the worker emits these, but the produced shape
 * (RunEvent) is the orchestrator-owned union — the parent consumes the
 * type unchanged when it reads them off the audit/JSONL channel. Each
 * case spreads the runtime event and overrides the discriminator + adds
 * the run/phase tags; the RunEvent variants are deliberately a superset
 * of the RuntimeEvent shapes so this is just a tag rewrite.
 */
export function promoteRuntimeEvent(event: RuntimeEvent, runId: string, phaseId: string): RunEvent {
  switch (event.type) {
    case "assistant.text":
      return { ...event, type: "agent.text", runId, phaseId };
    case "assistant.thinking":
      return { ...event, type: "agent.thinking", runId, phaseId };
    case "tool.use":
      return { ...event, type: "agent.tool.use", runId, phaseId };
    case "tool.result":
      return { ...event, type: "agent.tool.result", runId, phaseId };
    case "tokens":
      return { ...event, type: "agent.tokens", runId, phaseId };
    case "error":
      return { ...event, type: "agent.error", runId, phaseId };
  }
}
