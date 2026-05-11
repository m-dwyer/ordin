import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BundleLoader } from "../../src/infrastructure/bundle-loader";
import { BundleResolver } from "../../src/infrastructure/bundle-resolver";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function makeBundle(): Promise<string> {
  const root = await tempDir("ordin-bundle-");
  await write(
    join(root, "bundle.yaml"),
    `name: demo
version: 0.1.0
description: "Demo bundle"
runtime: ai-sdk
`,
  );
  await write(
    join(root, "workflow.yaml"),
    `name: demo
version: 1
runtime: ai-sdk
model: m
phases:
  - id: plan
    agent: planner
    gate: human
    allowed_tools: []
`,
  );
  await write(
    join(root, "agents", "planner.md"),
    `---
name: planner
skills: [rfc-template]
---

Planner prompt body.
`,
  );
  await write(
    join(root, "skills", "rfc-template", "SKILL.md"),
    `---
name: rfc-template
description: RFC template
---

Skill body.
`,
  );
  await write(join(root, "README.md"), "# Demo bundle\n");
  await write(join(root, "evals", "plan.eval.ts"), "// pretend eval\n");
  return root;
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("BundleLoader.load", () => {
  it("loads manifest + workflow + agents + skills, and computes a stable per-component hash", async () => {
    const dir = await makeBundle();
    const loader = new BundleLoader();
    const bundle = await loader.load(dir);

    expect(bundle.manifest.name).toBe("demo");
    expect(bundle.manifest.version).toBe("0.1.0");
    expect(bundle.manifest.entry).toBe("workflow.yaml");
    expect(bundle.manifest.runtime).toBe("ai-sdk");
    expect(bundle.workflow.name).toBe("demo");
    expect([...bundle.agents.keys()]).toEqual(["planner"]);
    expect(bundle.agents.get("planner")?.skills.map((s) => s.name)).toEqual(["rfc-template"]);
    expect([...bundle.skills.keys()]).toEqual(["rfc-template"]);

    expect(bundle.hash.workflow).toBe(sha(await readFile(join(dir, "workflow.yaml"), "utf8")));
    expect(bundle.hash.agents.get("planner")).toBe(
      sha(await readFile(join(dir, "agents", "planner.md"), "utf8")),
    );
    expect(bundle.hash.skills.get("rfc-template")).toBe(
      sha(await readFile(join(dir, "skills", "rfc-template", "SKILL.md"), "utf8")),
    );
    expect(bundle.hash.bundle).toMatch(/^[0-9a-f]{64}$/);

    // Re-loading without changes returns the same bundle hash.
    const again = await loader.load(dir);
    expect(again.hash.bundle).toBe(bundle.hash.bundle);
  });

  it("ignores README and evals/ for hashing; reflects agent edits in the bundle hash", async () => {
    const dir = await makeBundle();
    const loader = new BundleLoader();
    const baseline = (await loader.load(dir)).hash.bundle;

    await writeFile(join(dir, "README.md"), "# updated\n", "utf8");
    await writeFile(join(dir, "evals", "plan.eval.ts"), "// edited eval\n", "utf8");
    expect((await loader.load(dir)).hash.bundle).toBe(baseline);

    await writeFile(
      join(dir, "agents", "planner.md"),
      `---
name: planner
skills: [rfc-template]
---

Planner prompt body — REVISED.
`,
      "utf8",
    );
    const after = (await loader.load(dir)).hash.bundle;
    expect(after).not.toBe(baseline);
  });
});

describe("BundleResolver.resolve", () => {
  it("walks the search path in order and returns the first hit", async () => {
    const home = await tempDir("ordin-home-");
    const cwd = await tempDir("ordin-cwd-");
    const envDir = await tempDir("ordin-env-");
    await write(join(envDir, "demo", "bundle.yaml"), "name: demo\nversion: 1\n");
    await write(join(cwd, "bundles", "demo", "bundle.yaml"), "name: demo\nversion: 2\n");
    await write(join(home, ".ordin", "bundles", "demo", "bundle.yaml"), "name: demo\nversion: 3\n");

    const resolver = new BundleResolver({
      cwd,
      home,
      env: { ORDIN_BUNDLE_PATH: envDir },
    });
    expect(await resolver.resolve("demo")).toBe(join(envDir, "demo"));

    const noEnv = new BundleResolver({ cwd, home, env: {} });
    expect(await noEnv.resolve("demo")).toBe(join(cwd, "bundles", "demo"));
  });

  it("honors an explicit bundleDir override and surfaces searched paths on miss", async () => {
    const home = await tempDir("ordin-home-");
    const cwd = await tempDir("ordin-cwd-");
    const explicit = await tempDir("ordin-explicit-");
    await write(join(explicit, "bundle.yaml"), "name: explicit\nversion: 1\n");

    const resolver = new BundleResolver({ cwd, home, env: {} });
    expect(await resolver.resolve("ignored", { bundleDir: explicit })).toBe(explicit);

    await expect(resolver.resolve("missing")).rejects.toThrow(
      new RegExp(`Bundle "missing" not found.+${cwd}/bundles/missing`, "s"),
    );
  });
});
