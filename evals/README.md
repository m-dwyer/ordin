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

## How a fixture is shaped

Each `*.eval.ts` is a Vitest suite. Structure:

1. `beforeAll` calls `runPhase({...})` to execute one phase against the ephemeral fixture repo at `.scratch/eval-repo/`.
2. `runPhase` returns the produced artefact text.
3. `it` blocks assert on the text:
   - **Deterministic**: `expect(rfc).toContain("## Summary")` for template compliance.
   - **LLM-as-judge**: `judge(rfc, "natural-language yes/no criterion")` returns a 0..1 score; pick a threshold per rubric.

See `plan.eval.ts` for the canonical shape.

## Adding a fixture

1. Create `evals/<phase>-<slug>.eval.ts`.
2. Import `runPhase` from `./helpers` and `judge` from `./judge`.
3. Write a `describe` + `beforeAll` + a handful of `it` assertions. Mix deterministic (cheap, always-runs) with rubric (probabilistic, threshold-gated).
4. For rubrics, pick a yes/no criterion that's specific enough to be scorable. *"Is the RFC good"* is too vague; *"Does the Recommendation justify WHY the chosen option beats alternatives?"* is scorable.

## Flakiness mitigations

`expect(score).toBeGreaterThanOrEqual(0.7)` can oscillate near thresholds. Mitigations, in order of when to reach for them:

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

## Next steps (not yet in)

- `build.eval.ts` — requires seeding an RFC into the fixture before running Build. Plan-then-Build chains are an option; isolation-per-phase is preferred. Revisit when a Build regression actually matters.
- `review.eval.ts` — similar: needs a seeded diff in the fixture. Worth adding when Review prompts are being iterated on.
- Delta-from-baseline reporting if threshold tuning gets fiddly.
