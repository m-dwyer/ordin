import { intro, log, note, outro } from "@clack/prompts";
import type { Command } from "commander";
import type { HarnessRuntime, PhasePreview, RunEvent } from "../runtime/harness";
import { clackEventSink, ordin, parseTier, slugify } from "./common";

export interface RunCommandDeps {
  readonly createRuntime?: (opts: {
    workflow?: string;
  }) => Pick<HarnessRuntime, "startRun" | "previewRun">;
  readonly onEventSink?: () => {
    readonly onEvent: (event: RunEvent) => void;
    readonly finish: () => void;
  };
  readonly intro?: (message: string) => void;
  readonly outro?: (message: string) => void;
  /** Override the dry-run renderer. Test seam. */
  readonly renderPreviews?: (previews: readonly PhasePreview[], task: string) => void;
}

interface RunCommandOpts {
  readonly workflow?: string;
  readonly project?: string;
  readonly repo?: string;
  readonly tier: "S" | "M" | "L";
  readonly slug?: string;
  readonly only?: string;
  readonly from?: string;
  readonly dryRun?: boolean;
}

/**
 * `ordin run <task>` — execute a workflow, optionally sliced to a
 * single phase or a suffix beginning at a phase. With `--dry-run`,
 * print each phase's composed prompt without invoking any runtime.
 */
export function registerRun(program: Command, deps: RunCommandDeps = {}): void {
  program
    .command("run <task...>")
    .description("Run a workflow")
    .option("-w, --workflow <name>", "Workflow name from workflows/<name>.yaml")
    .option("-p, --project <name>", "Target project name from projects.yaml")
    .option("-r, --repo <path>", "Target repo path (overrides --project)")
    .option("-t, --tier <tier>", "Task tier (S|M|L)", parseTier, "M" as const)
    .option("-s, --slug <slug>", "Artefact slug (inferred from task if omitted)")
    .option("--only <phase>", "Run only this phase id")
    .option("--from <phase>", "Start at this phase id and run the remaining workflow")
    .option("--dry-run", "Print each phase's composed prompt without invoking any runtime")
    .action(async (taskParts: string[], opts: RunCommandOpts) => {
      const input = buildRunInput(taskParts, opts);
      const createRuntime = deps.createRuntime ?? ordin;
      const runtime = createRuntime({ workflow: opts.workflow });

      if (opts.dryRun) {
        const previews = await runtime.previewRun(input);
        const render = deps.renderPreviews ?? renderPreviewsWithClack;
        render(previews, input.task);
        return;
      }

      const sayIntro = deps.intro ?? intro;
      const sayOutro = deps.outro ?? outro;
      const eventSink = deps.onEventSink ?? clackEventSink;

      sayIntro(`ordin run · ${input.task}`);
      const { onEvent, finish } = eventSink();
      try {
        const result = await runtime.startRun({
          ...input,
          onEvent,
        });
        sayOutro(`${result.runId} — ${result.status}`);
      } finally {
        finish();
      }
    });
}

export function buildRunInput(
  taskParts: readonly string[],
  opts: RunCommandOpts,
): {
  readonly task: string;
  readonly slug: string;
  readonly projectName?: string;
  readonly repoPath?: string;
  readonly tier: "S" | "M" | "L";
  readonly onlyPhases?: readonly string[];
  readonly startAt?: string;
} {
  if (opts.only && opts.from) {
    throw new Error("Use either --only or --from, not both");
  }

  const task = taskParts.join(" ");
  const slug = opts.slug ?? slugify(task);
  if (!slug) throw new Error("Unable to determine slug; pass --slug");

  return {
    task,
    slug,
    ...(opts.project ? { projectName: opts.project } : {}),
    ...(opts.repo ? { repoPath: opts.repo } : {}),
    tier: opts.tier,
    ...(opts.only ? { onlyPhases: [opts.only] } : {}),
    ...(opts.from ? { startAt: opts.from } : {}),
  };
}

/**
 * Renders dry-run previews using clack. One `note()` per phase — the
 * box itself is the visual container for that phase, with metadata,
 * system prompt, and user prompt as labelled sub-sections inside it.
 * Phase is the unit; sections belong to it. Pipes cleanly too (no
 * cursor-redraw escape codes).
 */
function renderPreviewsWithClack(previews: readonly PhasePreview[], task: string): void {
  intro(`ordin dry-run · ${task}`);
  log.message(
    `${previews.length} phase${previews.length === 1 ? "" : "s"} composed — no runtime invoked`,
  );

  for (const preview of previews) {
    const { phase, runtimeName, prompt } = preview;
    const tools = prompt.tools.length > 0 ? prompt.tools.join(", ") : "(none)";
    const body = [
      `agent:   ${phase.agent}`,
      `runtime: ${runtimeName}`,
      `model:   ${prompt.model}`,
      `tools:   ${tools}`,
      `cwd:     ${prompt.cwd}`,
      "",
      "▸ system prompt",
      indentBlock(prompt.systemPrompt),
      "",
      "▸ user prompt",
      indentBlock(prompt.userPrompt),
    ].join("\n");
    note(body, `Phase — ${phase.id}`);
  }

  outro(`${previews.length} phase${previews.length === 1 ? "" : "s"} previewed`);
}

/** Two-space indent so sub-section bodies sit visually under their `▸` heading. */
function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
