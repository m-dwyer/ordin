import type { PhasePreview } from "../domain/phase-preview";
import { requireSlug } from "../domain/slug";
import type { PreviewInput, PreviewServices } from "../orchestrator/engine";
import type { HarnessStateLoader } from "./ports";
import type { StartRunInput } from "./types";
import { workflowForRun } from "./workflow-slice";

export class PreviewRunUseCase {
  constructor(private readonly loader: HarnessStateLoader) {}

  async execute(input: StartRunInput): Promise<readonly PhasePreview[]> {
    const state = await this.loader.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = await this.loader.resolveWorkspace(input);
    const program = state.engine.compile(workflowForRun(state.workflow, input));
    const previewInput: PreviewInput = {
      task: input.task,
      slug,
      workspaceRoot,
      tier: input.tier ?? "M",
    };
    const previewServices: PreviewServices = {
      config: state.config,
      agents: state.agents,
    };
    return state.engine.preview(program, previewInput, previewServices);
  }
}
