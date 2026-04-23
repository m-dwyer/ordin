# Evals

Regression gate for prompt / skill / agent / ingestion changes in this workflow pack. Unlike `pnpm test` (unit tests of harness code, mockable), evals run **real phases against a real LLM** — they catch prompt regressions, which unit tests cannot.

Per the plan, this is a pack-local concern: `evals/` lives next to `workflows/`, `agents/`, `skills/` as part of a workflow pack. Today's pack is the ordin repo itself.

## Running

**One-time setup.** Install [Docker](https://docs.docker.com/desktop/) + [Ollama](https://ollama.com/), pull models:

```bash
ollama pull qwen3:8b            # agent model (runs the phase — needs native tool-use)
ollama pull qwen3:4b            # judge model (LLM-as-judge scoring)
```

**Model choice matters.** Smaller/older models often fail: they emit tool-call JSON as plain text content instead of structured `tool_calls`, and the AI SDK's dispatcher can't see them. Qwen 3 does this correctly; Qwen 2.5 Coder does not. If `pnpm eval` fails after one assistant step with no tools executed, suspect the model.

**Each session:**

```bash
mise run litellm-up              # start LiteLLM proxy (Docker)
pnpm eval                        # run all fixtures
pnpm eval:watch                  # re-run on file change (iteration loop)
mise run litellm-down            # stop when done
```

Swap backend by editing `litellm/config.yaml` — `model_list` has Ollama as default plus commented entries for Anthropic / OpenAI / OpenRouter / Bedrock.

## Comparing models across runs

`litellm/config.yaml` declares backend aliases (`qwen3-4b`, `qwen3-8b`, `qwen3-14b`, `qwen3-32b`, `qwen3-coder-30b`). Pick one per run via env var:

```bash
ORDIN_EVAL_MODEL=qwen3-14b pnpm eval
ORDIN_EVAL_MODEL=qwen3-32b pnpm eval
```

Unset → default aliases (qwen3:8b for agent, qwen3:4b for judge). Override the judge independently via `ORDIN_EVAL_JUDGE_MODEL`.

Adding a new model:
1. `ollama pull <model>`
2. Add an entry to `model_list` in `litellm/config.yaml`
3. `mise run litellm-down && mise run litellm-up`
4. `ORDIN_EVAL_MODEL=<alias> pnpm eval`

Compare what matters: wall-time, output token count (from stderr log), tool-call count (repetition is a model-weakness signal), rubric scores.

## How a fixture is shaped

Each `*.eval.ts` is a Vitest suite. Structure:

1. `beforeAll` calls `runPhase({...})` to execute one phase against the ephemeral fixture repo at `.scratch/eval-repo/`.
2. `runPhase` returns an `Artefact` (`{ path, content, modifiedAt }` — the domain type from `src/domain/artefact.ts`).
3. `it` blocks assert on it two ways:
   - **Deterministic**: `expect(rfc.content).toContain("## Summary")` for template compliance.
   - **LLM-as-judge**: `await rubric(rfc, "natural-language yes/no criterion")` — throws with rationale + artefact path if below threshold (default 0.7).

See `plan.eval.ts` for the canonical shape.

### Rubric output

On **every** rubric call, `rubric()` logs a one-liner to stderr — score + the judge's rationale from its chain-of-thought. Surfacing rationale on passes lets you catch rubber-stamping judges; without it you can't tell whether the judge engaged with the criterion or just said yes:

```
  judge [1.00] The Summary section provides a concrete handover…
```

On **failure**, the error additionally carries criterion + score + rationale + artefact path, so you don't have to scroll up through stderr:

```
Rubric below threshold: Does the Recommendation section explain WHY…
  score:     0.40 (threshold 0.7)
  rationale: The recommendation states a choice but does not compare tradeoffs…
  artefact:  /Users/you/ordin/.scratch/eval-repo/docs/rfcs/plan-add-input-validation-rfc.md
```

`cat` the artefact path to see the produced RFC in full.

## Adding a fixture

1. Create `evals/<phase>-<slug>.eval.ts`.
2. Import `runPhase` from `./helpers` and `rubric` from `./judge`.
3. Write a `describe` + `beforeAll` + a handful of `it` assertions. Mix deterministic (cheap, always-runs — `expect(rfc.content).toContain(...)`) with rubric (probabilistic, threshold-gated — `await rubric(rfc, "…")`).
4. For rubrics, pick a yes/no criterion specific enough to be scorable. *"Is the RFC good"* is too vague; *"Does the Recommendation justify WHY the chosen option beats alternatives?"* is scorable.

## Flakiness mitigations

`rubric()` thresholds can oscillate near the cut-off. Mitigations, in order of when to reach for them:

1. Autoevals' built-in chain-of-thought (`useCoT: true` — already set).
2. Tune thresholds per-rubric — some criteria are stable, others noisy.
3. Average N runs — wrap the judge to run 3× and average, at 3× the cost.
4. Delta-from-baseline — persist last run's scores, alert on a drop > 0.1 rather than absolute threshold.

Start with single runs + tuned thresholds. Add #3/#4 only if flakiness bites.

## Why not just `pnpm test`?

- Evals hit the LLM — seconds to minutes per fixture. Unit tests are sub-second.
- Evals need LiteLLM running. Unit tests don't.
- Evals are probabilistic. Unit tests are deterministic.

Separate config (`vitest.eval.config.ts`) + separate script (`pnpm eval`) keeps these operationally distinct. Same Vitest runner, different cadence and meaning.

## Seeding upstream artefacts (isolation-per-phase)

`build.eval.ts` runs Build without first running Plan: `runPhase` accepts a `seed(repoPath)` callback that writes an approved RFC into the eval repo before the phase kicks off. This keeps Plan regressions from leaking into Build signal, at the cost of one hand-authored RFC per fixture — worth it for interpretable results. Apply the same pattern for Review fixtures: seed an RFC + a diff representing the state Review is judging.

## Next steps (not yet in)

- `review.eval.ts` — needs a seeded RFC + a seeded diff (and a seeded build-notes) in the fixture. Worth adding when Review prompts are being iterated on.
- Delta-from-baseline reporting if threshold tuning gets fiddly.
