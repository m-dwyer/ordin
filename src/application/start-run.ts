import type { Gate } from "../gates/types";
import type { EngineRunInput, GateRequest, PhaseDispatchRequest } from "../orchestrator/engine";
import type { PhaseRunResult } from "../orchestrator/phase-runner";
import type { RunMeta } from "../orchestrator/run-store";
import { RunExecution } from "../runtime/run-execution";
import type { SandboxMode } from "../sandbox";
import type { Sandbox } from "../sandbox/types";
import type { HarnessContext } from "./harness-context";
import type { StartRunInput } from "./types";

export interface StartRunUseCaseOptions {
  readonly root: string;
  readonly workflowName: string;
  readonly context: HarnessContext;
  readonly dispatchPhaseOverride?: (request: PhaseDispatchRequest) => Promise<PhaseRunResult>;
  readonly gateResolver: (kind: GateRequest["gateKind"]) => Gate;
  readonly egressGatePrompter?: (req: {
    host: string;
    port: number | undefined;
  }) => Promise<boolean>;
  readonly sandboxOverride?: Sandbox;
  readonly sandboxModeOverride?: SandboxMode;
  readonly scriptPathOverride?: string;
}

export class StartRunUseCase {
  constructor(private readonly opts: StartRunUseCaseOptions) {}

  async execute(input: StartRunInput): Promise<RunMeta> {
    const { state, engine, program, slug, workspaceRoot } =
      await this.opts.context.prepareRun(input);
    const execution = await RunExecution.prepare({
      root: this.opts.root,
      workflowName: this.opts.workflowName,
      config: state.config,
      input,
      workspaceRoot,
      ...(this.opts.dispatchPhaseOverride
        ? { dispatchPhaseOverride: this.opts.dispatchPhaseOverride }
        : {}),
      ...(this.opts.egressGatePrompter ? { egressGatePrompter: this.opts.egressGatePrompter } : {}),
      ...(this.opts.sandboxOverride ? { sandboxOverride: this.opts.sandboxOverride } : {}),
      ...(this.opts.sandboxModeOverride
        ? { sandboxModeOverride: this.opts.sandboxModeOverride }
        : {}),
      ...(this.opts.scriptPathOverride ? { scriptPathOverride: this.opts.scriptPathOverride } : {}),
    });
    try {
      await execution.enter();
      const runInput: EngineRunInput = {
        task: input.task,
        slug,
        workspaceRoot,
        tier: input.tier ?? "M",
        ...(execution.sandboxMode ? { sandboxMode: execution.sandboxMode } : {}),
        ...(input.startAt ? { startAt: input.startAt } : {}),
        ...(input.onlyPhases ? { onlyPhases: input.onlyPhases } : {}),
        onGateRequested: (request) => this.handleGateRequest(request),
        onEvent: execution.onEvent(),
        dispatchPhase: execution.dispatchPhase(),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      };
      return await engine.run(program, runInput, this.opts.context.engineServices(state));
    } finally {
      await execution.dispose();
    }
  }

  private async handleGateRequest(request: GateRequest) {
    const gate = this.opts.gateResolver(request.gateKind);
    return gate.request({
      runId: request.runId,
      phaseId: request.phaseId,
      cwd: request.cwd,
      artefacts: request.artefacts,
      summary: request.summary,
    });
  }
}
