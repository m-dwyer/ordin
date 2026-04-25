import { intro, outro } from "@clack/prompts";
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
  /** Capture printed text instead of writing to stdout. Test seam. */
  readonly print?: (text: string) => void;
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
        const print = deps.print ?? ((text) => process.stdout.write(text));
        printPreviews(previews, input.task, print);
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

function printPreviews(
  previews: readonly PhasePreview[],
  task: string,
  print: (text: string) => void,
): void {
  print(`# ordin run --dry-run · ${task}\n`);
  print(`# ${previews.length} phase${previews.length === 1 ? "" : "s"}\n\n`);
  for (const preview of previews) {
    const { phase, runtimeName, prompt } = preview;
    const tools = prompt.tools.length > 0 ? prompt.tools.join(", ") : "(none)";
    print(`${"─".repeat(78)}\n`);
    print(`PHASE  ${phase.id}\n`);
    print(`agent: ${phase.agent}    runtime: ${runtimeName}    model: ${prompt.model}\n`);
    print(`tools: ${tools}\n`);
    print(`cwd:   ${prompt.cwd}\n`);
    print(`${"─".repeat(78)}\n`);
    print("## SYSTEM PROMPT\n\n");
    print(prompt.systemPrompt);
    print("\n\n## USER PROMPT\n\n");
    print(prompt.userPrompt);
    print("\n\n");
  }
}
