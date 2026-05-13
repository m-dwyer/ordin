import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Harness } from "../../src/composition/harness";
import type { Engine } from "../../src/orchestrator/engine";
import { compileWorkflowPlan } from "../../src/orchestrator/workflow-plan";
import { makeHarnessRoot } from "../fixtures/harness-root";

describe("Harness", () => {
  it("keeps the public facade wired to an injected engine adapter", async () => {
    const root = await makeHarnessRoot();
    const engine: Engine = {
      name: "custom",
      compile: (manifest) => ({
        manifest,
        plan: compileWorkflowPlan(manifest),
      }),
      preview: async (program, input) => [
        {
          phase: program.manifest.firstPhase(),
          runtimeName: "custom-runtime",
          prompt: {
            phaseId: "plan",
            systemPrompt: "custom",
            userPrompt: input.task,
            model: "custom-model",
            cwd: input.workspaceRoot,
            tier: input.tier,
            freshContext: true,
            tools: [],
            skills: [],
          },
        },
      ],
      start: async () => {
        throw new Error("preview facade test must not start the engine");
      },
      run: async () => {
        throw new Error("preview facade test must not run the engine");
      },
    };

    const repoPath = await mkdtemp(join(tmpdir(), "ordin-custom-repo-"));
    const harness = new Harness({
      root,
      bundle: "software-delivery",
      engine: "custom",
      engines: [engine],
    });

    const previews = await harness.previewRun({
      task: "Use custom engine",
      slug: "custom-engine",
      repoPath,
    });

    expect(previews).toHaveLength(1);
    expect(previews[0]?.runtimeName).toBe("custom-runtime");
    expect(previews[0]?.prompt.userPrompt).toBe("Use custom engine");
  });

  it("exposes stable harness paths and resolves the bundle dir", async () => {
    const root = await makeHarnessRoot();
    const harness = new Harness({ root, bundle: "software-delivery" });

    expect(harness.paths()).toMatchObject({
      root,
      configFile: join(root, "ordin.config.yaml"),
      projectsFile: join(root, "projects.yaml"),
      projectsLocalFile: join(root, "projects.local.yaml"),
    });
    expect(await harness.bundleDir()).toBe(join(root, "bundles", "software-delivery"));
  });
});
