import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoader } from "../../src/infrastructure/agent-loader";
import { SkillLoader } from "../../src/infrastructure/skill-loader";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harness-loaders-"));
}

describe("AgentLoader.loadAll", () => {
  const loader = new AgentLoader();

  it("loads every .md under the directory keyed by declared name", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "planner.md"),
      "---\nname: planner\nruntime: claude-cli\n---\n\nplan body\n",
      "utf8",
    );
    await writeFile(
      join(dir, "builder.md"),
      "---\nname: build-local\nruntime: claude-cli\n---\n\nbuild body\n",
      "utf8",
    );
    // non-.md files and dotfiles should be ignored
    await writeFile(join(dir, "README.txt"), "nope", "utf8");

    const agents = await loader.loadAll(dir, new Map());
    expect([...agents.keys()].sort()).toEqual(["build-local", "planner"]);
    expect(agents.get("planner")?.body).toBe("plan body");
    expect(agents.get("planner")?.skills).toEqual([]);
  });

  it("rejects duplicate agent names", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "a.md"),
      "---\nname: dup\nruntime: claude-cli\n---\n\nbody\n",
      "utf8",
    );
    await writeFile(
      join(dir, "b.md"),
      "---\nname: dup\nruntime: claude-cli\n---\n\nbody\n",
      "utf8",
    );
    await expect(loader.loadAll(dir, new Map())).rejects.toThrow(/Duplicate agent name "dup"/);
  });

  it("resolves declared skill names against the registry", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "planner.md"),
      "---\nname: planner\nruntime: claude-cli\nskills: [rfc-template]\n---\n\nplan body\n",
      "utf8",
    );
    const registry = new Map([
      [
        "rfc-template",
        {
          name: "rfc-template",
          description: "RFC structure",
          body: "skill body",
          source: "/virtual/rfc-template/SKILL.md",
        },
      ],
    ]);
    const agents = await loader.loadAll(dir, registry);
    expect(agents.get("planner")?.skills.map((s) => s.name)).toEqual(["rfc-template"]);
  });

  it("throws when a declared skill is not in the registry", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "planner.md"),
      "---\nname: planner\nruntime: claude-cli\nskills: [nope]\n---\n\nbody\n",
      "utf8",
    );
    await expect(loader.loadAll(dir, new Map())).rejects.toThrow(/references unknown skill "nope"/);
  });
});

describe("SkillLoader.loadAll", () => {
  const loader = new SkillLoader();

  it("loads SKILL.md from each subdirectory", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "rfc-template"), { recursive: true });
    await writeFile(
      join(dir, "rfc-template", "SKILL.md"),
      "---\nname: rfc-template\ndescription: RFC structure\n---\n\nbody\n",
      "utf8",
    );
    await mkdir(join(dir, "review-rubric"), { recursive: true });
    await writeFile(
      join(dir, "review-rubric", "SKILL.md"),
      "---\nname: review-rubric\ndescription: Review rubric\n---\n\nbody\n",
      "utf8",
    );
    // directory without SKILL.md is silently skipped
    await mkdir(join(dir, "half-built"), { recursive: true });

    const skills = await loader.loadAll(dir);
    expect([...skills.keys()].sort()).toEqual(["review-rubric", "rfc-template"]);
    expect(skills.get("rfc-template")?.description).toBe("RFC structure");
  });

  it("rejects duplicate skill names across subdirectories", async () => {
    const dir = await tempDir();
    for (const sub of ["a", "b"]) {
      await mkdir(join(dir, sub), { recursive: true });
      await writeFile(
        join(dir, sub, "SKILL.md"),
        "---\nname: dup\ndescription: same\n---\n\nbody\n",
        "utf8",
      );
    }
    await expect(loader.loadAll(dir)).rejects.toThrow(/Duplicate skill name "dup"/);
  });
});
