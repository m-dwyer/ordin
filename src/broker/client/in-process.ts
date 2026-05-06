import type { BrokerDispatch } from "../dispatch";
import type { BrokerClient, ToolIntent, ToolResult } from "./types";

/**
 * Default-mode broker client (ADR-018). Direct method calls into the
 * shared `BrokerDispatch` instance — no serialization, no transport.
 * The trust boundary is logical (code discipline); a sandbox-escape on
 * the agent side reaches the broker's policy code in the same address
 * space. ADR-016's process-level trust separation is the
 * `HttpBrokerClient` (Phase B) over the same `BrokerClient` interface.
 */
export class InProcessBrokerClient implements BrokerClient {
  private readonly dispatch: BrokerDispatch;

  constructor(dispatch: BrokerDispatch) {
    this.dispatch = dispatch;
  }

  dispatchTool(intent: ToolIntent): Promise<ToolResult> {
    return this.dispatch.dispatchTool(intent);
  }
}
