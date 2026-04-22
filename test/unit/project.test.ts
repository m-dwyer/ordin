import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectRegistry } from "../../src/domain/project";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harness-proj-"));
}

async function writeYaml(path: string, body: string): Promise<void> {
  await writeFile(path, body, "utf8");
}

describe("ProjectRegistry", () => {
  it("loads entries and expands ~ to the home directory", async () => {
    const dir = await tempDir();
    const sharedPath = join(dir, "projects.yaml");
    await writeYaml(
      sharedPath,
      `projects:
  core:
    path: ~/code/core
`,
    );
    const registry = await ProjectRegistry.load(sharedPath);
    expect(registry.get("core").path).toBe(join(homedir(), "code/core"));
  });

  it("local overlay keys override shared", async () => {
    const dir = await tempDir();
    const sharedPath = join(dir, "projects.yaml");
    const localPath = join(dir, "projects.local.yaml");
    await writeYaml(
      sharedPath,
      `projects:
  core:
    path: /shared/path
  other:
    path: /other
`,
    );
    await writeYaml(
      localPath,
      `projects:
  core:
    path: /local/path
`,
    );
    const registry = await ProjectRegistry.load(sharedPath, localPath);
    expect(registry.get("core").path).toBe("/local/path");
    expect(registry.get("other").path).toBe("/other");
  });

  it("tolerates a missing local overlay", async () => {
    const dir = await tempDir();
    const sharedPath = join(dir, "projects.yaml");
    await writeYaml(sharedPath, "projects: {}\n");
    const registry = await ProjectRegistry.load(sharedPath, join(dir, "projects.local.yaml"));
    expect(registry.names()).toEqual([]);
  });

  it("throws a helpful error for an unregistered project", async () => {
    const dir = await tempDir();
    const sharedPath = join(dir, "projects.yaml");
    await writeYaml(sharedPath, "projects: {}\n");
    const registry = await ProjectRegistry.load(sharedPath);
    expect(() => registry.get("ghost")).toThrow(/"ghost" not registered/);
  });

  it("carries standards_overlay through to the resolved entry", async () => {
    const dir = await tempDir();
    const sharedPath = join(dir, "projects.yaml");
    await writeYaml(
      sharedPath,
      `projects:
  dp:
    path: /data-platform
    standards_overlay: standards/data-platform.md
`,
    );
    const registry = await ProjectRegistry.load(sharedPath);
    expect(registry.get("dp").standardsOverlay).toBe("standards/data-platform.md");
  });
});
