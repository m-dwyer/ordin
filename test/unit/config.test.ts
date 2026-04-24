import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessConfig } from "../../src/domain/config";

async function tempConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-cfg-"));
  const path = join(dir, "harness.config.yaml");
  await writeFile(path, yaml, "utf8");
  return path;
}

describe("HarnessConfig", () => {
  it("loads per-phase defaults and applies runtime/budget fallbacks", async () => {
    const path = await tempConfig(
      `phases:
  plan:
    model: claude-opus-4-7
    allowed_tools: [Read, Grep]
  build:
    model: claude-sonnet-4-6
    allowed_tools: [Read, Write, Edit, Bash]
budgets:
  plan:
    soft_tokens: 40000
`,
    );
    const config = await HarnessConfig.load(path);
    expect(config.phaseDefaults("plan").model).toBe("claude-opus-4-7");
    expect(config.softTokenBudget("plan")).toBe(40000);
    expect(config.softTokenBudget("build")).toBeUndefined();
    expect(config.defaultRuntime).toBe("claude-cli");
    expect(config.runStoreDir()).toMatch(/\.ordin\/runs$/);
  });

  it("throws for an unknown phase", async () => {
    const path = await tempConfig(
      `phases:
  plan:
    model: m
    allowed_tools: []
`,
    );
    const config = await HarnessConfig.load(path);
    expect(() => config.phaseDefaults("build")).toThrow(/No defaults for phase "build"/);
  });

  it("applies tier model override via resolveDefaults", async () => {
    const path = await tempConfig(
      `phases:
  plan:
    model: claude-opus-4-7
    allowed_tools: [Read]
tiers:
  S:
    model: claude-sonnet-4-6
  L: {}
budgets:
  plan:
    soft_tokens: 40000
`,
    );
    const config = await HarnessConfig.load(path);

    const s = config.resolveDefaults("plan", "S");
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.allowedTools).toEqual(["Read"]);
    expect(s.softTokenBudget).toBe(40000);

    // L-tier has no override → falls back to the phase default
    const l = config.resolveDefaults("plan", "L");
    expect(l.model).toBe("claude-opus-4-7");
  });

  it("exposes opaque runtime config slices for validation by each runtime", async () => {
    const path = await tempConfig(
      `default_runtime: claude-cli
runtimes:
  claude-cli:
    bin: /usr/local/bin/claude
    phases:
      plan: { fallback_model: claude-sonnet-4-6, max_turns: 60 }
  ai-sdk:
    base_url: http://localhost:4000
phases:
  plan:
    model: m
    allowed_tools: []
`,
    );
    const config = await HarnessConfig.load(path);

    expect(config.defaultRuntime).toBe("claude-cli");
    expect(config.runtimeConfig("claude-cli")).toEqual({
      bin: "/usr/local/bin/claude",
      phases: { plan: { fallback_model: "claude-sonnet-4-6", max_turns: 60 } },
    });
    expect(config.runtimeConfig("ai-sdk")).toEqual({ base_url: "http://localhost:4000" });
    // Missing runtime name returns {} — runtime's fromConfig handles defaults.
    expect(config.runtimeConfig("unknown")).toEqual({});
  });

  it("expands ~ in run_store.base_dir", async () => {
    const path = await tempConfig(
      `run_store:
  base_dir: ~/custom-runs
phases:
  plan:
    model: m
    allowed_tools: []
`,
    );
    const config = await HarnessConfig.load(path);
    expect(config.runStoreDir()).toMatch(/custom-runs$/);
    expect(config.runStoreDir()).not.toContain("~");
  });
});
