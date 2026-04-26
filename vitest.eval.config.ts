import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Separate Vitest config for the eval suite so `bun run test` stays fast.
 *
 * Evals stage ephemeral repos, run real phases via AiSdkRuntime against
 * a LiteLLM proxy, and score artefacts (deterministic + LLM-as-judge).
 * A single fixture can take tens of seconds; a suite easily runs minutes.
 * They're the harness developer's regression gate, not part of the
 * pre-commit sweep — invoke via `bun run eval` when iterating on prompts.
 */

/**
 * Order eval files by workflow phase. Vitest's default `BaseSequencer`
 * sorts by file mtime (recently-touched first) for cache locality on
 * watch runs — we don't want that here, we want plan→build→review to
 * match workflow order so the output reads top-to-bottom as it executes.
 *
 * Files keep clean names (`plan.eval.ts`, `build.eval.ts`); ordering
 * lives here in one place. If we add a new phase, extend `PHASE_ORDER`.
 * Files outside this list fall to the end in their default order — they
 * still run, just unordered relative to the named phases.
 */
const PHASE_ORDER = ["plan", "build", "review"];

class PhaseOrderSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const indexOf = (file: TestSpecification): number => {
      const i = PHASE_ORDER.findIndex((p) => file.moduleId.includes(`/${p}.eval.`));
      return i < 0 ? PHASE_ORDER.length : i;
    };
    return files.slice().sort((a, b) => indexOf(a) - indexOf(b));
  }
}

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
    setupFiles: ["./evals/setup.ts"],
    sequence: {
      sequencer: PhaseOrderSequencer,
    },
  },
});
