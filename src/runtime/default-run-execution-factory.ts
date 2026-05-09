import type {
  RunExecution,
  RunExecutionFactory,
  RunExecutionFactoryOverrides,
  RunExecutionPrepareOptions,
} from "../application/ports";
import { DefaultRunExecution } from "./run-execution";

/**
 * Composition-root factory: every call constructs a fresh
 * `DefaultRunExecution` whose infra (broker, audit, sandbox) is bound
 * to a single run. Session-scoped overrides (test-time dispatch
 * shortcut, sandbox injections, egress prompter) are pinned at factory
 * construction and merged into each `prepare()` so use cases stay
 * ignorant of them.
 */
export class DefaultRunExecutionFactory implements RunExecutionFactory {
  constructor(private readonly overrides: RunExecutionFactoryOverrides = {}) {}

  async prepare(opts: RunExecutionPrepareOptions): Promise<RunExecution> {
    const execution = new DefaultRunExecution({
      ...opts,
      ...(this.overrides.dispatchPhaseOverride
        ? { dispatchPhaseOverride: this.overrides.dispatchPhaseOverride }
        : {}),
      ...(this.overrides.egressGatePrompter
        ? { egressGatePrompter: this.overrides.egressGatePrompter }
        : {}),
      ...(this.overrides.sandboxOverride
        ? { sandboxOverride: this.overrides.sandboxOverride }
        : {}),
      ...(this.overrides.sandboxModeOverride
        ? { sandboxModeOverride: this.overrides.sandboxModeOverride }
        : {}),
      ...(this.overrides.scriptPathOverride
        ? { scriptPathOverride: this.overrides.scriptPathOverride }
        : {}),
    });
    await execution.prepareInfra();
    return execution;
  }
}
