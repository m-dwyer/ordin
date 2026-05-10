import { requireSlug } from "../domain/slug";
import type { Phase } from "../domain/workflow";
import { AutoGate } from "../gates/auto";
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
  ) {}

  async execute(input: StartRunInput): Promise<RunMeta> {
    const state = await this.loader.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = await this.loader.resolveWorkspace(input);
    const program = state.engine.compile(workflowForRun(state.workflow, input));
    const execution = await this.factory.prepare({
      root: this.loader.root,
      workflowName: this.loader.workflowName,
      config: state.config,
      workspaceRoot,
      projectName: input.projectName,
      onEvent: input.onEvent,
    });
    const gateForKind = input.gateForKind ?? defaultGateResolver;
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

/**
 * Strict default: only `auto` gates are auto-approved. `human` and
 * `pre-commit` require an explicit `gateForKind` resolver — the CLI
 * wires clack + HumanGate, headless callers wrap session.resolveGate,
 * eval/CI callers supply `() => new AutoGate()` to opt into headless
 * approval. Failing closed here prevents a caller from silently
 * shipping past a human checkpoint by forgetting to wire a resolver.
 */
function defaultGateResolver(kind: Phase["gate"]): Gate {
  switch (kind) {
    case "auto":
      return new AutoGate();
    case "human":
    case "pre-commit":
      throw new Error(
        `Gate kind "${kind}" requires an explicit gate resolver. Pass StartRunInput.gateForKind ` +
          "(e.g. clack-backed HumanGate for CLI, deferred prompter for HTTP/MCP, or " +
          "`() => new AutoGate()` for headless).",
      );
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown gate kind: ${String(_exhaustive)}`);
    }
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
