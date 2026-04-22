import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init, LLMClassifierFromTemplate, type Score } from "autoevals";
import OpenAI from "openai";

// Defensive env-file load; a no-op if mise has already sourced it.
{
  const envFile = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/**
 * LLM-as-judge wrapper. Asks a cheap model (by default `claude-haiku-4-5`,
 * which LiteLLM's `model_list` routes to whatever backend you've picked
 * — qwen3:4b locally, real Anthropic if you swap providers) whether an
 * output satisfies a yes/no criterion, returning a 0..1 score.
 *
 * Autoevals handles the rubric prompt structure, chain-of-thought, and
 * choice parsing — we just supply the natural-language criterion. Vary
 * the judge model by editing its LiteLLM routing, or by setting
 * `ORDIN_EVAL_JUDGE_MODEL` to a different LiteLLM alias per-run.
 */

let initialised = false;

function ensureInit(): void {
  if (initialised) return;
  const apiKey = process.env.LITELLM_MASTER_KEY;
  if (!apiKey) {
    throw new Error(
      "LITELLM_MASTER_KEY is unset. Copy .env.local.example to .env.local and set the key.",
    );
  }
  const client = new OpenAI({
    baseURL: process.env.ORDIN_EVAL_BASE_URL ?? "http://localhost:4000",
    apiKey,
  });
  init({
    client,
    // LiteLLM alias — matches the harness-side Claude name; routes to
    // a cheap local model (qwen3:4b) via model_list, or to real
    // Anthropic if the user swaps backends. Override with
    // `ORDIN_EVAL_JUDGE_MODEL` if you want a different alias.
    defaultModel: process.env.ORDIN_EVAL_JUDGE_MODEL ?? "claude-haiku-4-5",
  });
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
    rationale: typeof result.metadata?.rationale === "string" ? result.metadata.rationale : undefined,
  };
}
