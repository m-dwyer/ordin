import type { Command } from "commander";
import { Harness } from "../composition/harness";
import {
  printBlank,
  printCommandHeader,
  printHint,
  printKeyValue,
  printSectionDivider,
  styled,
  writeLine,
} from "./tui/print";
import { PALETTE } from "./tui/theme";

/**
 * `ordin bundle` — read-only commands over the bundle search path.
 *
 *   list           — enumerate bundles reachable via the search path
 *   show <name>    — load a bundle and print its manifest + content hash
 *
 * Rendering follows `retro.ts`'s convention: `printCommandHeader` +
 * `printKeyValue` for scalar fields, `printSectionDivider` between
 * groups. Everything routes through the `Harness` facade per CLAUDE.md.
 */
export function registerBundle(program: Command): void {
  const bundle = program.command("bundle").description("Inspect installed bundles");

  bundle
    .command("list")
    .description("List bundles reachable via the search path")
    .action(async () => {
      const entries = await Harness.listBundles();
      printCommandHeader("bundle list", `${entries.length} found`);
      printBlank();
      if (entries.length === 0) {
        printHint("No bundles found. Search path:");
        for (const dir of Harness.bundleSearchPath()) {
          writeLine(`  ${styled(dir, PALETTE.hint)}`);
        }
        return;
      }
      for (const entry of entries) {
        writeLine(`  ${styled(entry.name, PALETTE.text)}`);
        writeLine(`  ${styled(entry.dir, PALETTE.hint)}`);
        printBlank();
      }
    });

  bundle
    .command("show <name>")
    .description("Print bundle manifest, content hash, and per-component hashes")
    .action(async (name: string) => {
      const info = await Harness.inspectBundle(name);
      const { manifest, hash, workflow } = info;

      printCommandHeader("bundle show", manifest.name);
      printBlank();
      const manifestKeys = [
        "name:",
        "version:",
        ...(manifest.description ? ["description:"] : []),
        ...(manifest.runtime ? ["runtime:"] : []),
        ...(manifest.model ? ["model:"] : []),
        "source:",
        "hash:",
      ];
      const manifestWidth = keyColumnWidth(manifestKeys);
      printKeyValue("name:", manifest.name, manifestWidth);
      printKeyValue("version:", manifest.version, manifestWidth);
      if (manifest.description) {
        printKeyValue("description:", manifest.description.trim(), manifestWidth);
      }
      if (manifest.runtime) printKeyValue("runtime:", manifest.runtime, manifestWidth);
      if (manifest.model) printKeyValue("model:", manifest.model, manifestWidth);
      printKeyValue("source:", info.dir, manifestWidth);
      printKeyValue("hash:", hash.bundle, manifestWidth);
      printBlank();

      printSectionDivider(`workflow ─ ${workflow.name}`);
      printBlank();
      printKeyValue("phases:", workflow.phaseIds.join(" → "));
      printKeyValue("hash:", styled(short(hash.workflow), PALETTE.hint));
      printBlank();

      printSectionDivider(`agents · ${hash.agents.size}`);
      printBlank();
      const agentWidth = keyColumnWidth([...hash.agents.keys()]);
      for (const [agentName, agentHash] of hash.agents) {
        printKeyValue(agentName, styled(short(agentHash), PALETTE.hint), agentWidth);
      }
      printBlank();

      if (hash.skills.size > 0) {
        printSectionDivider(`skills · ${hash.skills.size}`);
        printBlank();
        const skillWidth = keyColumnWidth([...hash.skills.keys()]);
        for (const [skillName, skillHash] of hash.skills) {
          printKeyValue(skillName, styled(short(skillHash), PALETTE.hint), skillWidth);
        }
      }
    });
}

function short(hex: string): string {
  return `${hex.slice(0, 12)}…`;
}

/** Widest key + a two-space gutter, so the value column is unambiguous. */
function keyColumnWidth(keys: readonly string[]): number {
  return Math.max(11, ...keys.map((k) => k.length)) + 2;
}
