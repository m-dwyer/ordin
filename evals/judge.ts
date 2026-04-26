import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init, LLMClassifierFromTemplate, type Score } from "autoevals";
import OpenAI from "openai";
import type { Artefact } from "../src/domain/artefact";

// Defensive env-file load; a no-op if mise has already sourced it.
{
  const envFile = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/**
 * LLM-as-judge wrapper. Asks a model whether an output satisfies a
 * yes/no criterion, returning a 0..1 score.
 *
 * Judge model resolution (explicit, no silent fallback):
 *   1. `ORDIN_EVAL_JUDGE_MODEL` — explicit override.
 *   2. `ORDIN_EVAL_MODEL` — same model as the agent under test. The
 *      common "I want one model in play for this run" case.
 *   3. Throw — neither set, no implicit default. Forces the eval
 *      author to know what's judging.
 *
 * Autoevals handles the rubric prompt structure, chain-of-thought, and
 * choice parsing — we just supply the natural-language criterion.
 */

let initialised = false;
let resolvedJudgeModel: string | undefined;

export function judgeModel(): string {
  const model = process.env.ORDIN_EVAL_JUDGE_MODEL ?? process.env.ORDIN_EVAL_MODEL;
  if (!model) {
    throw new Error(
      "Judge model not configured. Set ORDIN_EVAL_MODEL (preferred — the same model judges its own output) or ORDIN_EVAL_JUDGE_MODEL (explicit override).",
    );
  }
  return model;
}

function ensureInit(): void {
  if (initialised) return;
  const apiKey = process.env.LITELLM_MASTER_KEY;
  if (!apiKey) {
    throw new Error(
      "LITELLM_MASTER_KEY is unset. Copy .env.local.example to .env.local and set the key.",
    );
  }
  resolvedJudgeModel = judgeModel();
  const client = new OpenAI({
    baseURL: process.env.ORDIN_EVAL_BASE_URL ?? "http://localhost:4000",
    apiKey,
  });
  init({ client, defaultModel: resolvedJudgeModel });
  initialised = true;
}

export interface JudgeResult {
  readonly score: number;
  readonly rationale?: string;
}

/**
 * Score `output` against a natural-language yes/no `criterion`.
 * Returns 1 for yes, 0 for no (with autoevals' CoT reasoning stored in
 * the score metadata for post-hoc inspection on failures).
 */
export async function judge(output: string, criterion: string): Promise<JudgeResult> {
  ensureInit();
  const scorer = LLMClassifierFromTemplate<{ output: string }>({
    name: "ordin-judge",
    promptTemplate: [
      "You are scoring whether an artefact satisfies a specific criterion.",
      "",
      "Criterion: {{criterion}}",
      "",
      "Artefact:",
      "---",
      "{{output}}",
      "---",
      "",
      "Think briefly about the evidence, then respond with CHOICE: yes or CHOICE: no.",
    ].join("\n"),
    choiceScores: { yes: 1, no: 0 },
    useCoT: true,
  });
  const result: Score = await scorer({ output, criterion } as unknown as { output: string });
  return {
    score: typeof result.score === "number" ? result.score : 0,
    rationale:
      typeof result.metadata?.rationale === "string" ? result.metadata.rationale : undefined,
  };
}

/**
 * Rubric assertion. Scores `artefact.content` against `criterion` and
 * throws a rich error if the score is below `threshold`.
 *
 * Rationale is surfaced on BOTH pass and fail:
 *   - stderr log: every call prints `judge [score] rationale` — on passes
 *     this lets you catch rubber-stamping judges; without visible reasoning
 *     you can't tell whether the judge engaged with the criterion or just
 *     said yes.
 *   - failure message: the thrown error also carries criterion + score +
 *     rationale + artefact path, so you don't have to scroll up through
 *     stderr to understand why Vitest failed.
 */
export async function rubric(
  artefact: Artefact,
  criterion: string,
  options: { threshold?: number } = {},
): Promise<JudgeResult> {
  const threshold = options.threshold ?? 0.7;
  const result = await judge(artefact.content, criterion);

  const scoreStr = result.score.toFixed(2);
  const rationale = result.rationale?.trim() || "(no rationale returned)";
  process.stderr.write(`  judge [${scoreStr}] ${rationale}\n`);

  if (result.score < threshold) {
    throw new Error(
      [
        `Rubric below threshold: ${criterion}`,
        `  score:     ${scoreStr} (threshold ${threshold})`,
        `  rationale: ${rationale}`,
        `  artefact:  ${artefact.path}`,
      ].join("\n"),
    );
  }
  return result;
}
