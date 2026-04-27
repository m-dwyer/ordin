import type { Command } from "commander";
import type { PhaseMeta } from "../runtime/harness";
import { ordin } from "./common";
import {
  colorForRunStatus,
  printBlank,
  printCommandHeader,
  printKeyValue,
  printSectionDivider,
  styled,
  writeLine,
} from "./tui/print";
import { PALETTE } from "./tui/theme";

export function registerRetro(program: Command): void {
  program
    .command("retro <runId>")
    .description("Per-phase duration, tokens, gate decisions, iteration count")
    .action(async (runId: string) => {
      const runtime = ordin();
      const meta = await runtime.getRun(runId);

      printCommandHeader("retro", meta.runId);
      printBlank();

      printKeyValue("workflow:", meta.workflow);
      printKeyValue("tier:", meta.tier);
      writeLine(
        `  ${styled("status:".padEnd(11), PALETTE.hint)}${styled(meta.status, colorForRunStatus(meta.status))}`,
      );
      printKeyValue("task:", meta.task);
      printKeyValue("repo:", meta.repo);
      printKeyValue("started:", meta.startedAt);
      if (meta.completedAt) printKeyValue("done:", meta.completedAt);
      printBlank();

      for (const phase of meta.phases) {
        renderPhase(phase);
      }

      const totals = totalTokens(meta.phases);
      printSectionDivider("totals");
      printBlank();
      printKeyValue("input:", totals.input.toLocaleString(), 16);
      printKeyValue("output:", totals.output.toLocaleString(), 16);
      printKeyValue("cache-read:", totals.cacheReadInput.toLocaleString(), 16);
      printKeyValue("cache-creation:", totals.cacheCreationInput.toLocaleString(), 16);
    });
}

function renderPhase(phase: PhaseMeta): void {
  printSectionDivider(`phase ─ ${phase.phaseId} · iter ${phase.iteration}`);
  printBlank();
  writeLine(
    `  ${styled("status:".padEnd(11), PALETTE.hint)}${styled(phase.status, colorForRunStatus(phase.status))}`,
  );
  printKeyValue("runtime:", `${phase.runtime} / ${phase.model}`);
  if (phase.durationMs !== undefined) {
    printKeyValue("duration:", `${(phase.durationMs / 1000).toFixed(1)}s`);
  }
  if (phase.tokens) {
    printKeyValue(
      "tokens:",
      `in=${phase.tokens.input.toLocaleString()} out=${phase.tokens.output.toLocaleString()} cache-read=${phase.tokens.cacheReadInput.toLocaleString()}`,
    );
  }
  if (phase.gateDecision) {
    const color =
      phase.gateDecision === "approved"
        ? PALETTE.done
        : phase.gateDecision === "rejected"
          ? PALETTE.failed
          : PALETTE.hint;
    writeLine(`  ${styled("gate:".padEnd(11), PALETTE.hint)}${styled(phase.gateDecision, color)}`);
  }
  if (phase.gateNote) printKeyValue("gate note:", phase.gateNote);
  if (phase.error) {
    writeLine(
      `  ${styled("error:".padEnd(11), PALETTE.hint)}${styled(phase.error, PALETTE.failed)}`,
    );
  }
  printBlank();
}

function totalTokens(phases: readonly PhaseMeta[]): {
  input: number;
  output: number;
  cacheReadInput: number;
  cacheCreationInput: number;
} {
  return phases.reduce(
    (acc, p) => {
      if (!p.tokens) return acc;
      return {
        input: acc.input + p.tokens.input,
        output: acc.output + p.tokens.output,
        cacheReadInput: acc.cacheReadInput + p.tokens.cacheReadInput,
        cacheCreationInput: acc.cacheCreationInput + p.tokens.cacheCreationInput,
      };
    },
    { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 },
  );
}
