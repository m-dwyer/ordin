import { Command } from "commander";
import { registerDoctor } from "./doctor";
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

registerRun(program);
registerRuns(program);
registerRetro(program);
registerStatus(program);
registerDoctor(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
