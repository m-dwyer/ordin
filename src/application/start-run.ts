import { requireSlug } from "../domain/slug";
import type { Phase } from "../domain/workflow";
import { gateResolverFor } from "../gates/dispatch";
import type { Gate } from "../gates/types";
import type { EngineRunInput, EngineServices, GateRequest } from "../orchestrator/engine";
import type { RunMeta } from "../orchestrator/run-store";
import type { HarnessStateLoader, LoadedHarnessState, RunExecutionFactory } from "./ports";
import type { StartRunInput } from "./types";
import { workflowForRun } from "./workflow-slice";
import type { WorkspaceResolver } from "./workspace-resolver";

export class StartRunUseCase {
  constructor(
    private readonly loader: HarnessStateLoader,
    private readonly factory: RunExecutionFactory,
    private readonly workspaceResolver: WorkspaceResolver,
  ) {}

  async execute(input: StartRunInput): Promise<RunMeta> {
    const state = await this.loader.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = await this.workspaceResolver.resolve(input);
    const program = state.engine.compile(workflowForRun(state.workflow, input));
    const execution = await this.factory({
      root: this.loader.root,
      workflowName: this.loader.workflowName,
      config: state.config,
      workspaceRoot,
      projectName: input.projectName,
      onEvent: input.onEvent,
    });
    const gateForKind = input.gateForKind ?? gateResolverFor();
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
        onGateRequested: (request) => handleGateRequest(gateForKind, request),
        onEvent: execution.onEvent(),
        dispatchPhase: execution.dispatchPhase(),
        abortSignal: input.abortSignal,
      };
      return await state.engine.run(program, runInput, engineServices(state));
    } finally {
      await execution.dispose();
    }
  }
}

function handleGateRequest(gateForKind: (kind: Phase["gate"]) => Gate, request: GateRequest) {
  const gate = gateForKind(request.gateKind);
  return gate.request({
    runId: request.runId,
    phaseId: request.phaseId,
    cwd: request.cwd,
    artefacts: request.artefacts,
    summary: request.summary,
  });
}

function engineServices(state: LoadedHarnessState): EngineServices {
  return {
    config: state.config,
    agents: state.agents,
    runtimeNames: state.runtimeNames,
    runStore: state.runStore,
  };
}
