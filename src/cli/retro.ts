import type { Command } from "commander";
import type { PhaseMeta } from "../runtime/harness";
import { ordin } from "./common";

export function registerRetro(program: Command): void {
  program
    .command("retro <runId>")
    .description("Per-phase duration, tokens, gate decisions, iteration count")
    .action(async (runId: string) => {
      const runtime = ordin();
      const meta = await runtime.getRun(runId);
      process.stdout.write(`Run       ${meta.runId}\n`);
      process.stdout.write(`Workflow  ${meta.workflow}\n`);
      process.stdout.write(`Tier      ${meta.tier}\n`);
      process.stdout.write(`Status    ${meta.status}\n`);
      process.stdout.write(`Task      ${meta.task}\n`);
      process.stdout.write(`Repo      ${meta.repo}\n`);
      process.stdout.write(`Started   ${meta.startedAt}\n`);
      if (meta.completedAt) process.stdout.write(`Completed ${meta.completedAt}\n`);
      process.stdout.write("\n");

      for (const phase of meta.phases) {
        process.stdout.write(formatPhase(phase));
      }

      const totals = totalTokens(meta.phases);
      process.stdout.write("\nTotals\n");
      process.stdout.write(`  input tokens:    ${totals.input.toLocaleString()}\n`);
      process.stdout.write(`  output tokens:   ${totals.output.toLocaleString()}\n`);
      process.stdout.write(`  cache-read:      ${totals.cacheReadInput.toLocaleString()}\n`);
      process.stdout.write(`  cache-creation:  ${totals.cacheCreationInput.toLocaleString()}\n`);
    });
}

function formatPhase(phase: PhaseMeta): string {
  const lines: string[] = [];
  lines.push(`Phase  ${phase.phaseId} (iteration ${phase.iteration})`);
  lines.push(`  status      ${phase.status}`);
  lines.push(`  runtime     ${phase.runtime} / ${phase.model}`);
  if (phase.durationMs !== undefined) {
    lines.push(`  duration    ${(phase.durationMs / 1000).toFixed(1)}s`);
  }
  if (phase.tokens) {
    lines.push(
      `  tokens      in=${phase.tokens.input.toLocaleString()} out=${phase.tokens.output.toLocaleString()} cache-read=${phase.tokens.cacheReadInput.toLocaleString()}`,
    );
  }
  if (phase.gateDecision) lines.push(`  gate        ${phase.gateDecision}`);
  if (phase.gateNote) lines.push(`  gate note   ${phase.gateNote}`);
  if (phase.error) lines.push(`  error       ${phase.error}`);
  return `${lines.join("\n")}\n\n`;
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
