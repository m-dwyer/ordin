import { requireSlug } from "../domain/slug";
import { GateResolver } from "../gates/dispatch";
import type { EngineRunInput, EngineServices, GateRequest } from "../orchestrator/engine";
import type { RunMeta } from "../orchestrator/run-store";
import type { DefaultHarnessStateLoader, LoadedHarnessState } from "./default-harness-state-loader";
import type { RunExecutionFactory } from "./run-execution";
import type { StartRunInput } from "./start-run-input";
import { workflowForRun } from "./workflow-slice";
import type { WorkspaceResolver } from "./workspace-resolver";

export class StartRunUseCase {
  constructor(
    private readonly loader: DefaultHarnessStateLoader,
    private readonly factory: RunExecutionFactory,
    private readonly workspaceResolver: WorkspaceResolver,
  ) {}

  async execute(input: StartRunInput): Promise<RunMeta> {
    const state = await this.loader.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = await this.workspaceResolver.resolve(input);
    const program = state.engine.compile(workflowForRun(state.workflow, input));
    const execution = await this.factory.prepare({
      root: this.loader.root,
      bundleName: this.loader.bundleName,
      config: state.config,
      workspaceRoot,
      projectName: input.projectName,
      onEvent: input.onEvent,
      bundleScriptPath: state.bundle.scriptPath,
    });
    const gateResolver = input.gateResolver ?? new GateResolver();
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
        onGateRequested: (request) => handleGateRequest(gateResolver, request),
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

function handleGateRequest(gateResolver: GateResolver, request: GateRequest) {
  const gate = gateResolver.forKind(request.gateKind);
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
    bundle: state.bundle,
  };
}
