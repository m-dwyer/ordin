import type { PhasePreview } from "../domain/phase-preview";
import { requireSlug } from "../domain/slug";
import type { PreviewInput, PreviewServices } from "../orchestrator/engine";
import type { DefaultHarnessStateLoader } from "./default-harness-state-loader";
import type { StartRunInput } from "./start-run-input";
import { workflowForRun } from "./workflow-slice";
import type { WorkspaceResolver } from "./workspace-resolver";

export class PreviewRunUseCase {
  constructor(
    private readonly loader: DefaultHarnessStateLoader,
    private readonly workspaceResolver: WorkspaceResolver,
  ) {}

  async execute(input: StartRunInput): Promise<readonly PhasePreview[]> {
    const state = await this.loader.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = await this.workspaceResolver.resolve(input);
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
