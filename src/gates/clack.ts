import { spawn } from "node:child_process";
import { cancel, confirm, isCancel, log, note, select, text } from "@clack/prompts";
import type { Gate, GateArtefact, GateContext, GateDecision } from "./types";

type GateAction = "approve" | "reject" | "view" | "edit";

/**
 * Interactive human gate. Opens the artefact in $EDITOR when requested,
 * then loops until the reviewer approves or rejects. Stage 1 default.
 */
export interface ClackGateConfig {
  /** Override the editor. Defaults to $EDITOR, then $VISUAL, then `vi`. */
  readonly editor?: string;
}

export class ClackGate implements Gate {
  readonly kind = "clack";
  private readonly editor: string;

  constructor(config: ClackGateConfig = {}) {
    this.editor = config.editor ?? process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
  }

  async request(ctx: GateContext): Promise<GateDecision> {
    note(this.buildSummary(ctx), `Gate — ${ctx.phaseId}`);

    while (true) {
      const action = await select<GateAction>({
        message: "How would you like to proceed?",
        options: [
          { value: "approve", label: "Approve and continue" },
          { value: "reject", label: "Reject (triggers iteration or halt)" },
          { value: "view", label: "View an artefact" },
          { value: "edit", label: "Edit an artefact, then re-prompt" },
        ],
      });

      if (isCancel(action)) {
        cancel("Gate cancelled");
        return { status: "rejected", reason: "user cancelled" };
      }

      switch (action) {
        case "approve": {
          const noteValue = await text({
            message: "Optional note (press Enter to skip)",
            placeholder: "",
          });
          if (isCancel(noteValue)) continue;
          const trimmed = noteValue.trim();
          return trimmed ? { status: "approved", note: trimmed } : { status: "approved" };
        }
        case "reject": {
          const reason = await text({
            message: "Why are you rejecting?",
            validate: (v) => (v?.trim() ? undefined : "A reason is required."),
          });
          if (isCancel(reason)) continue;
          return { status: "rejected", reason: reason.trim() };
        }
        case "view": {
          const artefact = await this.chooseArtefact(ctx.artefacts, "View which artefact?");
          if (!artefact) continue;
          await this.openInPager(artefact.path);
          break;
        }
        case "edit": {
          const artefact = await this.chooseArtefact(ctx.artefacts, "Edit which artefact?");
          if (!artefact) continue;
          await this.openInEditor(artefact.path);
          const continueEdit = await confirm({
            message: `Saved edits to ${artefact.label}. Ready to re-prompt?`,
          });
          if (isCancel(continueEdit)) continue;
          break;
        }
      }
    }
  }

  private buildSummary(ctx: GateContext): string {
    const lines: string[] = [];
    if (ctx.summary) {
      lines.push(ctx.summary);
      lines.push("");
    }
    if (ctx.artefacts.length === 0) {
      lines.push("No declared artefacts produced.");
    } else {
      lines.push("Artefacts produced:");
      for (const a of ctx.artefacts) {
        lines.push(`  • ${a.label}: ${a.path}`);
      }
    }
    return lines.join("\n");
  }

  private async chooseArtefact(
    artefacts: readonly GateArtefact[],
    message: string,
  ): Promise<GateArtefact | undefined> {
    if (artefacts.length === 0) {
      log.warn("No artefacts to choose from.");
      return undefined;
    }
    if (artefacts.length === 1) return artefacts[0];

    const chosen = await select<string>({
      message,
      options: artefacts.map((a) => ({ value: a.path, label: `${a.label} — ${a.path}` })),
    });
    if (isCancel(chosen)) return undefined;
    return artefacts.find((a) => a.path === chosen);
  }

  private openInEditor(path: string): Promise<void> {
    return this.spawnInteractive(this.editor, [path]);
  }

  private openInPager(path: string): Promise<void> {
    const pager = process.env["PAGER"] ?? "less";
    return this.spawnInteractive(pager, [path]);
  }

  private spawnInteractive(bin: string, args: string[]): Promise<void> {
    return new Promise((resolveExec) => {
      const child = spawn(bin, args, { stdio: "inherit" });
      child.on("close", () => resolveExec());
      child.on("error", (err) => {
        log.error(`Failed to run ${bin}: ${err.message}`);
        resolveExec();
      });
    });
  }
}
