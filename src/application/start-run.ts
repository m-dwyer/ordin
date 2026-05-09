import { requireSlug } from "../domain/slug";
import type { Gate } from "../gates/types";
import type { EngineRunInput, EngineServices, GateRequest } from "../orchestrator/engine";
import type { RunMeta } from "../orchestrator/run-store";
import type { HarnessStateLoader, LoadedHarnessState, RunExecutionFactory } from "./ports";
import type { StartRunInput } from "./types";
import { workflowForRun } from "./workflow-slice";

export class StartRunUseCase {
  constructor(
    private readonly loader: HarnessStateLoader,
    private readonly factory: RunExecutionFactory,
    private readonly gateResolver: (kind: GateRequest["gateKind"]) => Gate,
    private readonly root: string,
    private readonly workflowName: string,
  ) {}

  async execute(input: StartRunInput): Promise<RunMeta> {
    const state = await this.loader.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = await this.loader.resolveWorkspace(input);
    const program = state.engine.compile(workflowForRun(state.workflow, input));
    const execution = await this.factory.prepare({
      root: this.root,
      workflowName: this.workflowName,
      config: state.config,
      workspaceRoot,
      projectName: input.projectName,
      onEvent: input.onEvent,
    });
    try {
      await execution.enter();
      const runInput: EngineRunInput = {
        task: input.task,
        slug,
        workspaceRoot,
        tier: input.tier ?? "M",
        sandboxMode: execution.sandboxMode,
        startAt: input.startAt,
        onlyPhases: input.onlyPhases,
        onGateRequested: (request) => this.handleGateRequest(request),
        onEvent: execution.onEvent(),
        dispatchPhase: execution.dispatchPhase(),
        abortSignal: input.abortSignal,
      };
      return await state.engine.run(program, runInput, engineServices(state));
    } finally {
      await execution.dispose();
    }
  }

  private handleGateRequest(request: GateRequest) {
    const gate = this.gateResolver(request.gateKind);
    return gate.request({
      runId: request.runId,
      phaseId: request.phaseId,
      cwd: request.cwd,
      artefacts: request.artefacts,
      summary: request.summary,
    });
  }
}

function engineServices(state: LoadedHarnessState): EngineServices {
  return {
    config: state.config,
    agents: state.agents,
    runtimeNames: state.runtimeNames,
    runStore: state.runStore,
  };
}
