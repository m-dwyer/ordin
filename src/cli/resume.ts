import type { Command } from "commander";
import { Harness, replayResumedHistory } from "../composition/harness";
import { installAbortHandler, ordinRunSession, parseSandboxMode } from "./common";

interface ResumeCommandOpts {
  readonly sandbox?: ReturnType<typeof parseSandboxMode>;
}

/**
 * `ordin resume <runId>` — continue an interrupted run from its
 * persisted RunMeta. Bundle, slug, task, workspace, tier, and sandbox
 * mode are read from the meta — `--sandbox` is the one override
 * (because sandbox selection is a runtime concern, not a run-identity
 * concern).
 *
 * Before kicking off the engine, we replay the prior run's history
 * (meta.phases + per-phase transcripts) at the TUI controller so the
 * scrollback rebuilds the same phase sections, tool calls, and gate
 * decisions the original run accumulated. The engine then takes over
 * from where the prior run stopped.
 */
export function registerResume(program: Command): void {
  program
    .command("resume <runId>")
    .description("Resume an interrupted run from its persisted state")
    .option(
      "--sandbox <mode>",
      "Sandbox mode override: passthrough, broker, or srt",
      parseSandboxMode,
    )
    .action(async (runId: string, opts: ResumeCommandOpts) => {
      const { meta, runDir } = await Harness.peekRunMeta(runId);
      const session = await ordinRunSession({
        bundle: meta.bundle.name,
        ...(opts.sandbox ? { sandboxMode: opts.sandbox } : {}),
        header: {
          task: meta.task,
          slug: meta.slug,
          tier: meta.tier,
          bundle: meta.bundle.name,
          repoPath: meta.repo,
          runId: meta.runId,
        },
      });
      const abortSignal = installAbortHandler();
      session.bindAbortSignal(abortSignal);
      try {
        await replayResumedHistory({ meta, runDir, pushEvent: session.onEvent });
        const runSession = await session.runtime.resumeRun(runId, {
          onEvent: session.onEvent,
          gateResolver: session.gateResolver,
          abortSignal,
        });
        const result = await runSession.completion;
        session.finish({ runId: result.runId, status: result.status });
      } finally {
        await session.dispose();
      }
    });
}
