import { log, spinner } from "@clack/prompts";
import { InvalidArgumentError } from "commander";
import { HarnessRuntime, type RunEvent } from "../runtime/harness";

export function parseTier(value: string): "S" | "M" | "L" {
  if (value === "S" || value === "M" || value === "L") return value;
  throw new InvalidArgumentError("Tier must be S, M, or L");
}

export function ordin(): HarnessRuntime {
  return new HarnessRuntime();
}

/**
 * Clack-based event sink for CLI use. Renders the unified `RunEvent`
 * stream as:
 *
 *   • one spinner per active phase, message updated for the current
 *     activity (`thinking…`, `running: Read /path`)
 *   • `log.step` line committed when each tool completes successfully
 *   • `log.error` line for tool failures and runtime errors
 *   • `log.info` for any assistant text
 *
 * Phase transitions stop the spinner with a summary, so the clack gate
 * flow (which owns the terminal interactively) renders cleanly.
 *
 * Returns `{ onEvent, finish }`. The caller must invoke `finish()` if
 * the run ends outside a natural `run.completed` (e.g. an exception)
 * to guarantee the spinner tears down.
 */
export function clackEventSink(): {
  onEvent: (event: RunEvent) => void;
  finish: () => void;
} {
  const toolMeta = new Map<string, { name: string; preview?: string }>();

  let activeSpin: ReturnType<typeof spinner> | undefined;

  const startPhase = (phaseId: string, model: string, iteration: number): void => {
    activeSpin?.stop();
    const label = iteration === 1 ? phaseId : `${phaseId} (iteration ${iteration})`;
    activeSpin = spinner();
    activeSpin.start(`${label} — ${model} — starting`);
  };

  const endPhase = (message: string, ok: boolean): void => {
    if (activeSpin) {
      if (ok) activeSpin.stop(message);
      else activeSpin.error(message);
    }
    activeSpin = undefined;
  };

  const onEvent = (event: RunEvent): void => {
    switch (event.type) {
      case "run.started":
        break;
      case "run.completed":
        break;
      case "phase.started":
        startPhase(event.phaseId, event.model, event.iteration);
        break;
      case "phase.completed":
        endPhase(
          `${event.phaseId} complete — ${formatDuration(event.durationMs)} · out ${event.tokens.output.toLocaleString()} tok`,
          true,
        );
        break;
      case "phase.failed":
        endPhase(`${event.phaseId} failed — ${firstLine(event.error)}`, false);
        break;
      case "gate.requested":
        // clack gate flow takes over from here; spinner is already stopped.
        break;
      case "gate.decided":
        // Gate decision is also surfaced by clack's own prompts.
        break;
      case "agent.thinking":
        activeSpin?.message("thinking…");
        break;
      case "agent.text": {
        const text = event.text.trim();
        if (text) log.info(text);
        break;
      }
      case "agent.tool.use": {
        // Commit each tool as it starts, not on completion. This makes
        // rendering env-robust (clack's spinner/log interleaving gets
        // weird across terminals, pnpm stdout pipes, and non-TTY
        // environments — committing once per tool avoids the duplication
        // entirely). Failures surface below as a separate log.error.
        const preview = summariseToolInput(event.name, event.input);
        const label = `${event.name}${preview ? ` · ${preview}` : ""}`;
        toolMeta.set(event.id, { name: event.name, ...(preview ? { preview } : {}) });
        log.step(label);
        activeSpin?.message(`${event.name} running…`);
        break;
      }
      case "agent.tool.result": {
        if (!event.ok) {
          const meta = toolMeta.get(event.id);
          const label = meta ? `${meta.name}${meta.preview ? ` · ${meta.preview}` : ""}` : event.id;
          const reason = event.preview ? ` — ${firstLine(event.preview)}` : "";
          log.error(`${label} failed${reason}`);
        }
        // Successful tools already committed on use; nothing to commit here.
        activeSpin?.message("thinking…");
        break;
      }
      case "agent.tokens":
        // Tokens summary shown at phase-completion / gate, not inline.
        break;
      case "agent.error":
        log.error(event.message.trim());
        break;
    }
  };

  return {
    onEvent,
    finish: () => {
      activeSpin?.stop();
      activeSpin = undefined;
    },
  };
}

/**
 * Pick the most informative single-line preview for a tool invocation.
 * Stable Claude Code tool contracts; fall back to JSON-stringified first
 * line for anything unknown.
 */
function summariseToolInput(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = rec[key];
    return typeof v === "string" ? v : undefined;
  };
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return str("file_path");
    case "Bash": {
      const cmd = str("command");
      return cmd ? firstLine(cmd) : undefined;
    }
    case "Grep":
    case "Glob":
      return str("pattern");
    case "Skill":
      return str("skill");
    case "WebFetch":
      return str("url");
    default: {
      const json = JSON.stringify(input);
      return json.length > 80 ? `${json.slice(0, 77)}...` : json;
    }
  }
}

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
