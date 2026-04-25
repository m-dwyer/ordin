import { intro, outro } from "@clack/prompts";
import type { Command } from "commander";
import type { HarnessRuntime, RunEvent } from "../runtime/harness";
import { clackEventSink, ordin, parseTier, slugify } from "./common";

export interface RunCommandDeps {
  readonly createRuntime?: (opts: { workflow?: string }) => Pick<HarnessRuntime, "startRun">;
  readonly onEventSink?: () => {
    readonly onEvent: (event: RunEvent) => void;
    readonly finish: () => void;
  };
  readonly intro?: (message: string) => void;
  readonly outro?: (message: string) => void;
}

interface RunCommandOpts {
  readonly workflow?: string;
  readonly project?: string;
  readonly repo?: string;
  readonly tier: "S" | "M" | "L";
  readonly slug?: string;
  readonly only?: string;
  readonly from?: string;
}

/**
 * `ordin run <task>` — execute a workflow, optionally sliced to a
 * single phase or a suffix beginning at a phase.
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
    .action(async (taskParts: string[], opts: RunCommandOpts) => {
      const input = buildRunInput(taskParts, opts);
      const sayIntro = deps.intro ?? intro;
      const sayOutro = deps.outro ?? outro;
      const createRuntime = deps.createRuntime ?? ordin;
      const eventSink = deps.onEventSink ?? clackEventSink;

      sayIntro(`ordin run · ${input.task}`);
      const { onEvent, finish } = eventSink();
      try {
        const runtime = createRuntime({ workflow: opts.workflow });
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
