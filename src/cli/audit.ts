import type { Command } from "commander";
import type { VerifyResult } from "../runtime/harness";
import { ordin } from "./common";
import { printBlank, printCommandHeader, styled, writeLine } from "./tui/print";
import { PALETTE } from "./tui/theme";

/**
 * `ordin audit verify <runId>` — walk the per-run hash-chained audit
 * file and report tamper status. Exits 0 on a valid chain, 1 on the
 * first mismatch (with line + reason) or when the file can't be read.
 */
export function registerAudit(program: Command): void {
  const audit = program.command("audit").description("Inspect per-run audit chains");

  audit
    .command("verify <runId>")
    .description("Walk audit.jsonl and report chain integrity")
    .action(async (runId: string) => {
      const runtime = ordin();
      printCommandHeader("audit verify", runId);
      printBlank();
      let result: VerifyResult;
      try {
        result = await runtime.verifyAudit(runId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeLine(styled(`audit verify: ${msg}`, PALETTE.failed));
        process.exit(1);
      }
      if (result.ok) {
        writeLine(styled(`OK — ${result.entries} entries verified`, PALETTE.done));
        return;
      }
      writeLine(styled(`FAIL — chain broken at line ${result.line}`, PALETTE.failed));
      writeLine(`  ${styled("reason:", PALETTE.hint)} ${result.reason}`);
      writeLine(`  ${styled("verified:", PALETTE.hint)} ${result.entries} entries before mismatch`);
      process.exit(1);
    });
}
