import type { BrokerDispatch } from "../dispatch";
import type { ApprovalResult, BrokerClient, RecordedResult, ToolIntent } from "./types";

/**
 * Default-mode broker client (ADR-018). Direct method calls into the
 * shared `BrokerDispatch` instance — no serialization, no transport.
 *
 * Used in `--sandbox passthrough` runs where the agent and the broker
 * share an address space. The trust boundary is logical (code
 * discipline + ACL + scanner); there is no kernel sandbox in this
 * mode. Phase C's pattern scanner is the primary defense here.
 *
 * `HttpBrokerClient` (Phase B) speaks the same `BrokerClient`
 * interface for sandboxed runs.
 */
export class InProcessBrokerClient implements BrokerClient {
  private readonly dispatch: BrokerDispatch;

  constructor(dispatch: BrokerDispatch) {
    this.dispatch = dispatch;
  }

  requestApproval(intent: ToolIntent): Promise<ApprovalResult> {
    return this.dispatch.requestApproval(intent);
  }

  recordResult(intent: ToolIntent, recorded: RecordedResult): Promise<void> {
    return this.dispatch.recordResult(intent, recorded);
  }
}
