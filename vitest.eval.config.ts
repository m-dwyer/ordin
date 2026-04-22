import { defineConfig } from "vitest/config";

/**
 * Separate Vitest config for the eval suite so `pnpm test` stays fast.
 *
 * Evals stage ephemeral repos, run real phases via AiSdkRuntime against
 * a LiteLLM proxy, and score artefacts (deterministic + LLM-as-judge).
 * A single fixture can take tens of seconds; a suite easily runs minutes.
 * They're the harness developer's regression gate, not part of the
 * pre-commit sweep — invoke via `pnpm eval` when iterating on prompts.
 */
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    environment: "node",
    globals: false,
    // One fixture may need multiple LLM roundtrips + tool calls. Ten minutes
    // per test is generous but avoids flakiness on cold caches.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Evals make shared network calls through the proxy; serial execution
    // keeps the signal interpretable and avoids flooding a local Ollama.
    fileParallelism: false,
    // Don't bail on the first failing rubric — show all regressions in one run.
    bail: 0,
  },
});
