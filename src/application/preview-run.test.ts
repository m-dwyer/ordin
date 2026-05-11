import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRuntime } from "../../test/fixtures/agent-runtime";
import { makeHarnessRoot } from "../../test/fixtures/harness-root";
import { DefaultHarnessStateLoader } from "../composition/default-harness-state-loader";
import { PreviewRunUseCase } from "./preview-run";
import { WorkspaceResolver } from "./workspace-resolver";

describe("PreviewRunUseCase", () => {
  it("returns composed prompts without invoking a runtime", async () => {
    const root = await makeHarnessRoot();
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-preview-repo-"));
    const runtime = new FakeRuntime();
    const loader = new DefaultHarnessStateLoader({
      root,
      bundleName: "software-delivery",
      engineName: "mastra",
      engines: undefined,
    });

    const previews = await new PreviewRunUseCase(loader, new WorkspaceResolver(loader)).execute({
      task: "Preview the whole thing",
      slug: "preview-it",
      repoPath,
      tier: "M",
    });

    expect(previews.map((p) => p.phase.id)).toEqual(["plan", "build", "review"]);
    expect(previews.every((p) => p.runtimeName === "ai-sdk")).toBe(true);
    expect(previews[0]?.prompt.userPrompt).toContain("Preview the whole thing");
    expect(previews[1]?.prompt.userPrompt).toContain("docs/rfcs/preview-it-rfc.md");
    expect(runtime.invocations).toHaveLength(0);
  });
});
