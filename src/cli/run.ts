import { intro, outro } from "@clack/prompts";
import type { Command } from "commander";
import { clackEventSink, ordin, parseTier, slugify } from "./common";

/**
 * `ordin run <task>` — full pipeline, blocking foreground, gates inline.
 */
export function registerRun(program: Command): void {
  program
    .command("run <task...>")
    .description("Run the full Plan → Build → Review pipeline")
    .option("-p, --project <name>", "Target project name from projects.yaml")
    .option("-r, --repo <path>", "Target repo path (overrides --project)")
    .option("-t, --tier <tier>", "Task tier (S|M|L)", parseTier, "M" as const)
    .option("-s, --slug <slug>", "Artefact slug (inferred from task if omitted)")
    .action(
      async (
        taskParts: string[],
        opts: {
          project?: string;
          repo?: string;
          tier: "S" | "M" | "L";
          slug?: string;
        },
      ) => {
        const task = taskParts.join(" ");
        const slug = opts.slug ?? slugify(task);
        if (!slug) throw new Error("Unable to determine slug; pass --slug");

        intro(`ordin run · ${task}`);
        const { onEvent, finish } = clackEventSink();
        try {
          const runtime = ordin();
          const result = await runtime.startRun({
            task,
            slug,
            ...(opts.project ? { projectName: opts.project } : {}),
            ...(opts.repo ? { repoPath: opts.repo } : {}),
            tier: opts.tier,
            onEvent,
          });
          outro(`${result.runId} — ${result.status}`);
        } finally {
          finish();
        }
      },
    );
}
