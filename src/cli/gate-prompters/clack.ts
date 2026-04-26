import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { cancel, confirm, isCancel, log, note, select, text } from "@clack/prompts";
import type { Phase } from "../../domain/workflow";
import { gateResolverFor } from "../../gates/resolver";
import type {
  Gate,
  GateArtefact,
  GateContext,
  GateDecision,
  GatePrompter,
} from "../../gates/types";

type GateAction = "approve" | "reject" | "view" | "edit";

/**
 * Clack-based prompter for `HumanGate`. CLI-only — this is the single
 * place `@clack/prompts` is imported outside the existing CLI entries.
 * Opens artefacts in `$EDITOR` / `$PAGER` on demand and loops until the
 * reviewer approves or rejects.
 */
export interface ClackGatePrompterConfig {
  /** Override the editor. Defaults to $EDITOR, then $VISUAL, then `vi`. */
  readonly editor?: string;
}

export class ClackGatePrompter implements GatePrompter {
  private readonly editor: string;

  constructor(config: ClackGatePrompterConfig = {}) {
    this.editor = config.editor ?? process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
  }

  async prompt(ctx: GateContext): Promise<GateDecision> {
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
          await this.openInPager(resolveArtefactPath(artefact.path, ctx.cwd));
          break;
        }
        case "edit": {
          const artefact = await this.chooseArtefact(ctx.artefacts, "Edit which artefact?");
          if (!artefact) continue;
          await this.openInEditor(resolveArtefactPath(artefact.path, ctx.cwd));
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

/**
 * Artefact paths come in relative to the workspace root (the target
 * repo); the prompter spawns the editor/pager in the harness process's
 * cwd, which is usually a different directory entirely. Resolve to an
 * absolute path so $EDITOR / $PAGER find the file regardless.
 */
function resolveArtefactPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * CLI's gate resolver: clack-backed prompter feeding the shared
 * `gateResolverFor` mapping.
 */
export function clackGateResolver(
  prompter: GatePrompter = new ClackGatePrompter(),
): (kind: Phase["gate"]) => Gate {
  return gateResolverFor(prompter);
}
