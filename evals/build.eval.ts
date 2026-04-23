import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Artefact, ArtefactPaths } from "../src/domain/artefact";
import { EVAL_REPO, loadFixture, runPhase } from "./helpers";
import { rubric } from "./judge";

/**
 * Build-phase evals. Isolation-per-phase: seed an approved RFC into the
 * fixture repo, then run Build alone. Avoids chaining Plan → Build, which
 * would bake Plan regressions into Build signal.
 *
 * Task matches the TODO already in `src/calculator.ts`, so the seeded RFC
 * reads as something a human actually might have written for this repo.
 * Tests are scoped out in the RFC itself — the fixture has no test runner
 * and judging Build on test-infra improvisation would drown prompt signal.
 */

const SLUG = "build-divide-with-zero-guard";

describe("build: implement divide with zero-guard", () => {
  let notes: Artefact;

  beforeAll(async () => {
    notes = await runPhase({
      phase: "build",
      task: "Implement `divide` in the calculator per the approved RFC.",
      slug: SLUG,
      tier: "S",
      seed: async (repo) => {
        const rfcPath = join(repo, ArtefactPaths.rfc(SLUG));
        await mkdir(dirname(rfcPath), { recursive: true });
        await writeFile(rfcPath, loadFixture("divide-with-zero-guard/rfc.md"), "utf8");
      },
    });
  });

  it("produces build-notes at the declared path", () => {
    expect(notes.content.length).toBeGreaterThan(200);
  });

  it("implements divide in src/calculator.ts", async () => {
    const src = await readFile(join(EVAL_REPO, "src/calculator.ts"), "utf8");
    expect(src).toMatch(/export function divide\s*\(/);
  });

  it("rejects a zero denominator with a thrown error", async () => {
    const src = await readFile(join(EVAL_REPO, "src/calculator.ts"), "utf8");
    expect(src).toMatch(/throw\s+new\s+\w*Error/);
    // Explicit comparison to 0 — covers `=== 0`, `== 0`, and `< 0`-style guards
    // but excludes over-loose tests like `!b` that would also reject negatives.
    expect(src).toMatch(/===?\s*0\b/);
  });

  it("build-notes summarises what changed for a human reviewer", async () => {
    await rubric(
      notes,
      "Does build-notes.md give a reviewer a concise summary of what changed and flag the specific design choice (zero-denominator behaviour) they should double-check, rather than just restating the RFC verbatim?",
    );
  });

  it("build-notes stays inside RFC scope", async () => {
    await rubric(
      notes,
      "Does build-notes.md confirm the work stayed inside the RFC's declared scope (divide only, tests deferred, README untouched), rather than describing out-of-scope changes?",
    );
  });
});
