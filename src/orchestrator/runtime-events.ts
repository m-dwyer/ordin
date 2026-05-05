import type { RuntimeEvent } from "../worker/runtimes/types";
import type { RunEvent } from "./events";

/**
 * Promote a runtime-local event into a tagged RunEvent. Lives parent-
 * side because runtime events arrive over the worker's stdout JSONL
 * channel and the parent is what stamps run/phase identity onto each
 * one before fanning out to TUI / audit. The RunEvent variants are a
 * deliberate superset of the RuntimeEvent shapes so this is a tag
 * rewrite, not a translation.
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
    case "timing":
      return { ...event, type: "agent.timing", runId, phaseId };
    case "tokens":
      return { ...event, type: "agent.tokens", runId, phaseId };
    case "error":
      return { ...event, type: "agent.error", runId, phaseId };
  }
}
