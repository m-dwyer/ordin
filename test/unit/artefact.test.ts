import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtefactManager, ArtefactPaths } from "../../src/domain/artefact";

describe("ArtefactPaths", () => {
  it("generates conventional paths parameterised by slug", () => {
    expect(ArtefactPaths.rfc("feature-x")).toBe("docs/rfcs/feature-x-rfc.md");
    expect(ArtefactPaths.buildNotes("feature-x")).toBe("docs/rfcs/feature-x-build-notes.md");
    expect(ArtefactPaths.review("feature-x")).toBe("reviews/feature-x-review.md");
  });
});

describe("ArtefactManager", () => {
  it("reads a file and reports it exists", async () => {
    const repo = await mkdtemp(join(tmpdir(), "harness-artefact-"));
    await writeFile(join(repo, "notes.md"), "hello", "utf8");

    const manager = new ArtefactManager(repo);
    expect(await manager.exists("notes.md")).toBe(true);
    const artefact = await manager.read("notes.md");
    expect(artefact.content).toBe("hello");
    expect(artefact.path.endsWith("notes.md")).toBe(true);
    expect(artefact.modifiedAt).toBeGreaterThan(0);
  });

  it("returns false for missing files without throwing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "harness-artefact-"));
    const manager = new ArtefactManager(repo);
    expect(await manager.exists("nope.md")).toBe(false);
  });

  it("ensures the parent directory exists before writes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "harness-artefact-"));
    const manager = new ArtefactManager(repo);
    await manager.ensureDir("docs/rfcs/deep/nested.md");
    // Writing now succeeds; if ensureDir didn't create parents, this throws.
    await writeFile(join(repo, "docs/rfcs/deep/nested.md"), "x", "utf8");
    expect(await manager.exists("docs/rfcs/deep/nested.md")).toBe(true);
  });

  it("resolves relative paths against the repo root", async () => {
    const repo = await mkdtemp(join(tmpdir(), "harness-artefact-"));
    const manager = new ArtefactManager(repo);
    expect(manager.resolve("a/b.md")).toBe(join(repo, "a/b.md"));
    expect(manager.resolve("/already/absolute.md")).toBe("/already/absolute.md");
  });
});
