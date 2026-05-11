import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerRun } from "../../src/cli/run";
import type { Harness, PhasePreview, StartRunInput } from "../../src/composition/harness";

describe("registerRun", () => {
  it("passes workflow and run options to the runtime", async () => {
    const program = new Command();
    program.exitOverride();

    let bundle: string | undefined;
    let startRunInput: StartRunInput | undefined;

    registerRun(program, {
      createSession: async (opts) => {
        bundle = opts.bundle;
        return {
          runtime: {
            startRun: async (input: StartRunInput) => {
              startRunInput = input;
              return {
                runId: "run-1",
                workflow: "custom",
                tier: input.tier ?? "M",
                task: input.task,
                slug: input.slug,
                repo: input.repoPath ?? "",
                startedAt: "2026-01-01T00:00:00.000Z",
                completedAt: "2026-01-01T00:00:00.000Z",
                status: "completed",
                phases: [],
              };
            },
            previewRun: async () => [],
          } as unknown as Harness,
          onEvent: () => {},
          gateForKind: () => {
            throw new Error("not used in this test");
          },
          finish: () => {},
          dispose: () => {},
        };
      },
    });

    await program.parseAsync(
      [
        "node",
        "ordin",
        "run",
        "--bundle",
        "custom",
        "--repo",
        ".scratch/repo",
        "--slug",
        "ship-it",
        "--tier",
        "S",
        "--only",
        "ship",
        "Ship",
        "it",
      ],
      { from: "node" },
    );

    expect(bundle).toBe("custom");
    expect(startRunInput).toMatchObject({
      task: "Ship it",
      slug: "ship-it",
      repoPath: ".scratch/repo",
      tier: "S",
      onlyPhases: ["ship"],
    });
  });

  it("--dry-run calls previewRun (not startRun) and renders the previews", async () => {
    const program = new Command();
    program.exitOverride();

    let previewInput: StartRunInput | undefined;
    let renderedPreviews: readonly PhasePreview[] | undefined;
    let renderedTask: string | undefined;
    const fakePreview: PhasePreview = {
      phase: { id: "plan", agent: "planner", gate: "human" },
      runtimeName: "ai-sdk",
      prompt: {
        systemPrompt: "system body",
        userPrompt: "user prompt body",
        tools: ["Read", "Grep"],
        model: "qwen3-8b",
        cwd: "/tmp/repo",
        phaseId: "plan",
        tier: "S",
        freshContext: true,
        skills: [],
      },
    };

    registerRun(program, {
      createDryRunRuntime: () => ({
        previewRun: async (input: StartRunInput) => {
          previewInput = input;
          return [fakePreview];
        },
      }),
      renderPreviews: (previews, task) => {
        renderedPreviews = previews;
        renderedTask = task;
      },
    });

    await program.parseAsync(
      ["node", "ordin", "run", "--repo", ".scratch/repo", "--dry-run", "Try", "dry"],
      { from: "node" },
    );

    expect(previewInput?.task).toBe("Try dry");
    expect(renderedTask).toBe("Try dry");
    expect(renderedPreviews?.[0]).toBe(fakePreview);
  });
});
