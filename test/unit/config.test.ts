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
  it("loads global defaults without workflow phase ids", async () => {
    const path = await tempConfig(
      `default_model: qwen3-8b
allowed_tools: [Read, Grep]
tiers:
  S:
    model: qwen3-4b
`,
    );

    const config = await HarnessConfig.load(path);

    expect(config.defaultRuntime).toBe("ai-sdk");
    expect(config.defaultModel).toBe("qwen3-8b");
    expect(config.allowedTools).toEqual(["Read", "Grep"]);
    expect(config.tierModel("S")).toBe("qwen3-4b");
    expect(config.tierModel("L")).toBeUndefined();
    expect(config.runStoreDir()).toMatch(/\.ordin\/runs$/);
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
`,
    );
    const config = await HarnessConfig.load(path);

    expect(config.defaultRuntime).toBe("claude-cli");
    expect(config.runtimeConfig("claude-cli")).toEqual({
      bin: "/usr/local/bin/claude",
      phases: { plan: { fallback_model: "claude-sonnet-4-6", max_turns: 60 } },
    });
    expect(config.runtimeConfig("ai-sdk")).toEqual({ base_url: "http://localhost:4000" });
    expect(config.runtimeConfig("unknown")).toEqual({});
  });

  it("expands ~ in run_store.base_dir", async () => {
    const path = await tempConfig(
      `run_store:
  base_dir: ~/custom-runs
`,
    );
    const config = await HarnessConfig.load(path);
    expect(config.runStoreDir()).toMatch(/custom-runs$/);
    expect(config.runStoreDir()).not.toContain("~");
  });
});
