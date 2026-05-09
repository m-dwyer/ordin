import type { PhasePreview } from "../domain/phase-preview";
import type { PreviewInput, PreviewServices } from "../orchestrator/engine";
import type { HarnessContext } from "./harness-context";
import type { StartRunInput } from "./types";

export class PreviewRunUseCase {
  constructor(private readonly context: HarnessContext) {}

  async execute(input: StartRunInput): Promise<readonly PhasePreview[]> {
    const { state, engine, program, slug, workspaceRoot } = await this.context.prepareRun(input);
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
    return engine.preview(program, previewInput, previewServices);
  }
}
