/**
 * Non-TTY fallback for `ordin run`. When stdout isn't a TTY (CI logs,
 * `| tee out.log`, redirected to a file, ssh without -t), the OpenTUI
 * footer renderer can't paint, so we degrade to plain stdout lines.
 *
 * Gates can't be answered interactively here — there's no keyboard to
 * read from. The prompter rejects with a message pointing at the HTTP
 * + `ordin remote decide` flow, which is the right path for headless
 * gate handling.
 */
import type { Phase } from "../../domain/workflow";
import { gateResolverFor } from "../../gates/resolver";
import type { Gate, GateContext, GateDecision, GatePrompter } from "../../gates/types";
import type { RunEvent } from "../../runtime/harness";
import { firstLine, formatDuration, summariseToolInput } from "./format";

export interface NonTtySession {
  readonly onEvent: (event: RunEvent) => void;
  readonly finish: () => void;
  readonly gateForKind: (kind: Phase["gate"]) => Gate;
}

export function nonTtyRunSession(): NonTtySession {
  const toolMeta = new Map<string, { name: string; preview?: string }>();

  const writeLine = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const onEvent = (event: RunEvent): void => {
    switch (event.type) {
      case "run.started":
      case "run.completed":
      case "phase.completed":
      case "agent.tokens":
      case "agent.thinking":
      case "gate.requested":
      case "gate.decided":
        return;
      case "phase.started": {
        const tag = event.iteration > 1 ? ` (iteration ${event.iteration})` : "";
        writeLine(`▶ ${event.phaseId}${tag} — ${event.model}`);
        return;
      }
      case "phase.runtime.completed":
        writeLine(
          `✓ ${event.phaseId} — ${formatDuration(event.durationMs)} · out ${event.tokens.output.toLocaleString()} tok`,
        );
        return;
      case "phase.failed":
        writeLine(`✗ ${event.phaseId} failed — ${firstLine(event.error)}`);
        return;
      case "agent.text": {
        const text = event.text.trim();
        if (text) writeLine(`  ${text}`);
        return;
      }
      case "agent.tool.use": {
        const preview = summariseToolInput(event.name, event.input);
        toolMeta.set(event.id, { name: event.name, ...(preview ? { preview } : {}) });
        writeLine(`  ▸ ${event.name}${preview ? ` · ${preview}` : ""}`);
        return;
      }
      case "agent.tool.result":
        if (!event.ok) {
          const meta = toolMeta.get(event.id);
          const label = meta ? `${meta.name}${meta.preview ? ` · ${meta.preview}` : ""}` : event.id;
          const reason = event.preview ? ` — ${firstLine(event.preview)}` : "";
          writeLine(`  ✗ ${label} failed${reason}`);
        }
        return;
      case "agent.error":
        writeLine(`  ✗ ${event.message.trim()}`);
        return;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  };

  const finish = (): void => {
    // Nothing to tear down for a stateless line writer.
  };

  return {
    onEvent,
    finish,
    gateForKind: gateResolverFor(new NonInteractiveGatePrompter()),
  };
}

class NonInteractiveGatePrompter implements GatePrompter {
  async prompt(ctx: GateContext): Promise<GateDecision> {
    throw new Error(
      `Cannot prompt for gate at phase "${ctx.phaseId}" without a TTY. ` +
        "For non-interactive gate handling, run an HTTP server with `ordin serve` " +
        "and decide gates over the wire with `ordin remote decide`.",
    );
  }
}
