// Installs Bun's `.tsx` → Solid transform plugin. Must run before any
// `.tsx` import in dev (`bun src/cli/index.ts`). In compiled binaries
// all TSX is pre-transformed by the build plugin, so the runtime
// plugin is a no-op there — including it here makes the entry point
// self-contained and removes the bunfig.toml preload that would
// otherwise be a hard-fail in the compiled binary.
import "@opentui/solid/preload";
import { Command } from "commander";
import { registerAudit } from "./audit";
import { registerBundle } from "./bundle";
import { registerDoctor } from "./doctor";
import { registerMcp } from "./mcp";
import { registerRemote } from "./remote";
import { registerRetro } from "./retro";
import { registerRun } from "./run";
import { registerRuns } from "./runs";
import { registerServe } from "./serve";
import { registerStatus } from "./status";

/**
 * CLI is the Stage 1 client. Every command goes through `Harness`
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
registerBundle(program);
registerServe(program);
registerRemote(program);
registerMcp(program);
registerAudit(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
