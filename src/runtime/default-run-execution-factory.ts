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
 *
 * Constructor accepts `Partial<RunExecutionFactoryOverrides>` so
 * callers can pass `{}` (production default — no overrides) or only
 * the fields they care about; missing slots flow through as `undefined`
 * and the assignment below works without conditional spreads.
 */
export class DefaultRunExecutionFactory implements RunExecutionFactory {
  constructor(private readonly overrides: Partial<RunExecutionFactoryOverrides> = {}) {}

  async prepare(opts: RunExecutionPrepareOptions): Promise<RunExecution> {
    const execution = new DefaultRunExecution({
      ...opts,
      dispatchPhaseOverride: this.overrides.dispatchPhaseOverride,
      egressGatePrompter: this.overrides.egressGatePrompter,
      sandboxModeOverride: this.overrides.sandboxModeOverride,
      scriptPathOverride: this.overrides.scriptPathOverride,
    });
    await execution.prepareInfra();
    return execution;
  }
}
