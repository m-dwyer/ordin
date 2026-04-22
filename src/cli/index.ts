import { Command } from "commander";
import { registerDoctor } from "./doctor";
import { registerPhaseCommand } from "./phase";
import { registerRetro } from "./retro";
import { registerRun } from "./run";
import { registerRuns } from "./runs";
import { registerStatus } from "./status";

/**
 * CLI is the Stage 1 client. Every command goes through `HarnessRuntime`
 * — no reaching around it into domain/runtimes/orchestrator directly.
 */
const program = new Command();

program
  .name("ordin")
  .description("Run workflows with structure, order, and control across AI runtimes.")
  .version("0.1.0");

registerPhaseCommand(program, {
  command: "plan",
  takes: "task",
  phases: ["plan"],
  summary: "Run the Plan phase — produce a reviewable RFC",
});

registerPhaseCommand(program, {
  command: "build",
  takes: "slug",
  phases: ["build"],
  summary: "Run the Build phase against an approved RFC",
});

registerPhaseCommand(program, {
  command: "review",
  takes: "slug",
  phases: ["review"],
  summary: "Run the Review phase against a built change",
});

registerRun(program);
registerRuns(program);
registerRetro(program);
registerStatus(program);
registerDoctor(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
