import type { Command } from "commander";
import { applySeedPlan, type RunCommandOpts, resolveRunCommand } from "../run-service/run-command";
import type { HarnessRuntime, PhasePreview } from "../runtime/harness";
import { ordin, ordinRunSession, parseSandboxMode, parseTier } from "./common";
import { renderDryRun } from "./tui/dry-run";

export { buildRunInput } from "../run-service/run-command";

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
  /** Override the runtime factory used for command resolution and live runs. Test seam. */
  readonly createRuntime?: (opts: { workflow?: string }) => HarnessRuntime;
  /** Override the dry-run renderer. Test seam. */
  readonly renderPreviews?: (
    previews: readonly PhasePreview[],
    task: string,
  ) => void | Promise<void>;
}

/**
 * `ordin run <task>` — execute a workflow, optionally sliced to a
 * single phase or a suffix beginning at a phase. With `--dry-run`,
 * print each phase's composed prompt without invoking any runtime.
 */
export function registerRun(program: Command, deps: RunCommandDeps = {}): void {
  program
    .command("run [task...]")
    .description("Run a workflow")
    .option("-w, --workflow <name>", "Workflow name from workflows/<name>.yaml")
    .option("-p, --project <name>", "Target project name from projects.yaml")
    .option("-r, --repo <path>", "Target repo path (overrides --project)")
    .option("-t, --tier <tier>", "Task tier (S|M|L)", parseTier)
    .option("-s, --slug <slug>", "Artefact slug (inferred from task if omitted)")
    .option("--only <phase>", "Run only this phase id")
    .option("--from <phase>", "Start at this phase id and run the remaining workflow")
    .option("--fixture <name>", "Seed target repo from fixtures/runs/<name> before running")
    .option(
      "--from-run <runId>",
      "Seed this run from a prior run, or use as the source for --capture-fixture",
    )
    .option("--again <runId>", "Repeat a prior run; explicit CLI flags override reused values")
    .option(
      "--capture-fixture <name>",
      "Capture declared artefacts from --from-run into fixtures/runs/<name>",
    )
    .option("--force", "Allow --capture-fixture to overwrite an existing fixture")
    .option("--dry-run", "Print each phase's composed prompt without invoking any runtime")
    .option(
      "--sandbox <mode>",
      "Sandbox mode: passthrough (no isolation) or srt (kernel + network egress via @anthropic-ai/sandbox-runtime)",
      parseSandboxMode,
    )
    .option(
      "--script <path>",
      "Path to a YAML plan for ScriptedRuntime (deterministic test runs without an LLM)",
    )
    .action(async (taskParts: string[], opts: RunCommandOpts) => {
      const createRuntime = deps.createRuntime ?? ordin;
      const resolved = await resolveRunCommand(taskParts ?? [], opts, createRuntime);
      const input = resolved.input;
      const runtime = createRuntime({ workflow: resolved.workflow });

      if (opts.dryRun) {
        const runtime = (deps.createDryRunRuntime ?? ordin)({ workflow: resolved.workflow });
        const previews = await runtime.previewRun(input);
        await (deps.renderPreviews ?? renderDryRun)(previews, input.task);
        return;
      }

      if ((await applySeedPlan(resolved.seed, input, runtime)) === "captured") {
        return;
      }

      const session = await (deps.createSession ?? ordinRunSession)({
        workflow: resolved.workflow,
        ...(resolved.sandbox ? { sandboxMode: resolved.sandbox } : {}),
        ...(opts.script ? { scriptPath: opts.script } : {}),
        header: resolved.header,
      });
      try {
        const result = await session.runtime.startRun({
          ...input,
          onEvent: session.onEvent,
        });
        session.finish({ runId: result.runId, status: result.status });
      } finally {
        await session.dispose();
      }
    });
}
