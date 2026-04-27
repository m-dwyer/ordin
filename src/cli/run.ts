import type { Command } from "commander";
import type { HarnessRuntime, PhasePreview } from "../runtime/harness";
import { ordin, ordinRunSession, parseTier, slugify } from "./common";
import {
  printBlank,
  printHint,
  printIndented,
  printKeyValue,
  printSectionDivider,
  printSubheader,
} from "./tui/print";

export interface RunCommandDeps {
  /**
   * Override the session factory used for live runs. Default branches
   * on TTY: OpenTUI footer controller for terminals, plain stdout sink
   * elsewhere. Tests or alternate frontends inject their own.
   */
  readonly createSession?: typeof ordinRunSession;
  /**
   * Override the runtime used for `--dry-run`. Dry-run never starts a
   * phase, so it bypasses the live-run session and just calls
   * `previewRun`; this seam exists so tests can supply a fake without
   * spinning up the full HarnessRuntime.
   */
  readonly createDryRunRuntime?: (opts: {
    workflow?: string;
  }) => Pick<HarnessRuntime, "previewRun">;
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

      if (opts.dryRun) {
        const runtime = (deps.createDryRunRuntime ?? ordin)({ workflow: opts.workflow });
        const previews = await runtime.previewRun(input);
        const render = deps.renderPreviews ?? renderPreviewsPlain;
        render(previews, input.task);
        return;
      }

      const session = await (deps.createSession ?? ordinRunSession)({
        workflow: opts.workflow,
        header: { task: input.task, slug: input.slug, tier: input.tier },
      });
      try {
        const result = await session.runtime.startRun({
          ...input,
          onEvent: session.onEvent,
        });
        session.finish({ runId: result.runId, status: result.status });
      } finally {
        session.dispose();
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
 * Plain-stdout dry-run renderer. Uses the run UI's `PALETTE` so the
 * visual identity carries across — gradient-tinted section dividers
 * matching the `ordin` banner, plus subheaders / key:value rows /
 * indented bodies for each phase's metadata + prompts.
 */
function renderPreviewsPlain(previews: readonly PhasePreview[], task: string): void {
  printBlank();
  printHint(
    `ordin dry-run · ${task} · ${previews.length} phase${previews.length === 1 ? "" : "s"} composed — no runtime invoked`,
  );
  printBlank();

  for (const preview of previews) {
    const { phase, runtimeName, prompt } = preview;
    const tools = prompt.tools.length > 0 ? prompt.tools.join(", ") : "(none)";
    printSectionDivider(`Phase ─ ${phase.id}`);
    printBlank();
    printKeyValue("agent:", phase.agent);
    printKeyValue("runtime:", runtimeName);
    printKeyValue("model:", prompt.model);
    printKeyValue("tools:", tools);
    printKeyValue("cwd:", prompt.cwd);
    printBlank();
    printSubheader("system prompt");
    printIndented(prompt.systemPrompt);
    printBlank();
    printSubheader("user prompt");
    printIndented(prompt.userPrompt);
    printBlank();
  }

  printHint(`${previews.length} phase${previews.length === 1 ? "" : "s"} previewed`);
}
