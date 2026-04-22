import { intro, outro } from "@clack/prompts";
import type { Command } from "commander";
import { clackEventSink, ordin, parseTier, slugify } from "./common";

/**
 * Registers a single-phase command (plan/build/review). Each takes either
 * a natural-language task or an existing slug, then runs just the named
 * phase. Full-pipeline execution is handled by `ordin run`.
 */
export interface PhaseCommandSpec {
  readonly command: "plan" | "build" | "review";
  readonly takes: "task" | "slug";
  readonly phases: readonly string[];
  readonly summary: string;
}

export function registerPhaseCommand(program: Command, spec: PhaseCommandSpec): void {
  const argName = spec.takes === "task" ? "<task...>" : "<slug>";
  const cmd = program
    .command(`${spec.command} ${argName}`)
    .description(spec.summary)
    .option("-p, --project <name>", "Target project name from projects.yaml")
    .option("-r, --repo <path>", "Target repo path (overrides --project)")
    .option("-t, --tier <tier>", "Task tier (S|M|L)", parseTier, "M" as const)
    .option("-s, --slug <slug>", "Artefact slug (inferred from task if omitted)");

  cmd.action(async (arg: string | string[], opts: PhaseCliOpts) => {
    const task = Array.isArray(arg) ? arg.join(" ") : arg;
    const slug = opts.slug ?? (spec.takes === "slug" ? task : slugify(task));
    if (!slug) {
      throw new Error("Unable to determine artefact slug; pass --slug");
    }

    const effectiveTask = spec.takes === "task" ? task : taskForSlug(spec.command, slug);

    intro(`ordin ${spec.command} · ${effectiveTask}`);
    const { onEvent, finish } = clackEventSink();
    try {
      const runtime = ordin();
      const result = await runtime.startRun({
        task: effectiveTask,
        slug,
        ...(opts.project ? { projectName: opts.project } : {}),
        ...(opts.repo ? { repoPath: opts.repo } : {}),
        tier: opts.tier,
        onlyPhases: spec.phases,
        onEvent,
      });
      outro(`${result.runId} — ${result.status}`);
    } finally {
      finish();
    }
  });
}

function taskForSlug(phase: "plan" | "build" | "review", slug: string): string {
  switch (phase) {
    case "build":
      return `Build the approved RFC for "${slug}". Read the RFC at docs/rfcs/${slug}-rfc.md before making changes.`;
    case "review":
      return `Review the built change for "${slug}" against its RFC. Read docs/rfcs/${slug}-rfc.md and docs/rfcs/${slug}-build-notes.md first.`;
    case "plan":
      return slug;
  }
}

interface PhaseCliOpts {
  readonly project?: string;
  readonly repo?: string;
  readonly tier: "S" | "M" | "L";
  readonly slug?: string;
}
