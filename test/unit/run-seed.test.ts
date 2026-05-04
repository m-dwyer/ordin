import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowManifest } from "../../src/domain/workflow";
import {
  captureFixture,
  seedFromFixture,
  seedPhaseInputsFromRun,
} from "../../src/run-service/run-seed";

describe("run seed helpers", () => {
  it("seeds a fixture with nested paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-seed-"));
    const fixturesRoot = join(root, "fixtures");
    const targetRepo = join(root, "repo");
    await mkdir(join(fixturesRoot, "plan-fixture", "docs", "rfcs"), { recursive: true });
    await writeFile(join(fixturesRoot, "plan-fixture", "docs", "rfcs", "task-rfc.md"), "rfc");

    await seedFromFixture({ fixturesRoot, name: "plan-fixture", targetRepo });

    await expect(readFile(join(targetRepo, "docs", "rfcs", "task-rfc.md"), "utf8")).resolves.toBe(
      "rfc",
    );
  });

  it("seeds only the selected phase's declared inputs from a prior run", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-seed-"));
    const sourceRepo = join(root, "source");
    const targetRepo = join(root, "target");
    const phase = {
      id: "build",
      agent: "builder",
      gate: "human" as const,
      inputs: [{ label: "RFC", path: "docs/rfcs/{slug}-rfc.md" }],
      outputs: [{ label: "Notes", path: "docs/rfcs/{slug}-build-notes.md" }],
    };
    await mkdir(join(sourceRepo, "docs", "rfcs"), { recursive: true });
    await writeFile(join(sourceRepo, "docs", "rfcs", "old-rfc.md"), "old rfc");
    await writeFile(join(sourceRepo, "docs", "rfcs", "old-build-notes.md"), "notes");

    await seedPhaseInputsFromRun({
      sourceRepo,
      sourceSlug: "old",
      targetRepo,
      targetSlug: "new",
      phase,
    });

    await expect(readFile(join(targetRepo, "docs", "rfcs", "new-rfc.md"), "utf8")).resolves.toBe(
      "old rfc",
    );
    await expect(
      readFile(join(targetRepo, "docs", "rfcs", "new-build-notes.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("reports missing source artefact paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-seed-"));
    await expect(
      seedPhaseInputsFromRun({
        sourceRepo: join(root, "source"),
        sourceSlug: "old",
        targetRepo: join(root, "target"),
        targetSlug: "new",
        phase: {
          id: "build",
          agent: "builder",
          gate: "human",
          inputs: [{ label: "RFC", path: "docs/rfcs/{slug}-rfc.md" }],
        },
      }),
    ).rejects.toThrow(/Missing source artefacts:.*old-rfc\.md/s);
  });

  it("refuses to overwrite captured fixtures without force", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-seed-"));
    const fixturesRoot = join(root, "fixtures");
    const sourceRepo = join(root, "source");
    await mkdir(join(fixturesRoot, "existing"), { recursive: true });
    await mkdir(join(sourceRepo, "docs", "rfcs"), { recursive: true });
    await writeFile(join(sourceRepo, "docs", "rfcs", "task-rfc.md"), "rfc");
    const workflow = new WorkflowManifest({
      name: "wf",
      version: "1",
      phases: [
        {
          id: "plan",
          agent: "planner",
          gate: "human",
          outputs: [{ label: "RFC", path: "docs/rfcs/{slug}-rfc.md" }],
        },
      ],
    });

    await expect(
      captureFixture({
        fixturesRoot,
        name: "existing",
        sourceRepo,
        sourceSlug: "task",
        workflow,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("captures all declared workflow artefacts that exist in the source repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-seed-"));
    const fixturesRoot = join(root, "fixtures");
    const sourceRepo = join(root, "source");
    await mkdir(join(sourceRepo, "docs", "rfcs"), { recursive: true });
    await writeFile(join(sourceRepo, "docs", "rfcs", "task-rfc.md"), "rfc");
    await writeFile(join(sourceRepo, "docs", "rfcs", "task-build-notes.md"), "notes");
    const workflow = new WorkflowManifest({
      name: "wf",
      version: "1",
      phases: [
        {
          id: "plan",
          agent: "planner",
          gate: "human",
          outputs: [{ label: "RFC", path: "docs/rfcs/{slug}-rfc.md" }],
        },
        {
          id: "build",
          agent: "builder",
          gate: "human",
          inputs: [{ label: "RFC", path: "docs/rfcs/{slug}-rfc.md" }],
          outputs: [{ label: "Build notes", path: "docs/rfcs/{slug}-build-notes.md" }],
        },
        {
          id: "review",
          agent: "reviewer",
          gate: "human",
          inputs: [
            { label: "RFC", path: "docs/rfcs/{slug}-rfc.md" },
            { label: "Build notes", path: "docs/rfcs/{slug}-build-notes.md" },
          ],
          outputs: [{ label: "Review", path: "reviews/{slug}-review.md" }],
        },
      ],
    });

    await captureFixture({
      fixturesRoot,
      name: "plan-only",
      sourceRepo,
      sourceSlug: "task",
      workflow,
    });

    await expect(
      readFile(join(fixturesRoot, "plan-only", "docs", "rfcs", "task-rfc.md"), "utf8"),
    ).resolves.toBe("rfc");
    await expect(
      readFile(join(fixturesRoot, "plan-only", "docs", "rfcs", "task-build-notes.md"), "utf8"),
    ).resolves.toBe("notes");
    await expect(
      readFile(join(fixturesRoot, "plan-only", "reviews", "task-review.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });
});
