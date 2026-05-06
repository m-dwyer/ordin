import type { BrokerClient, ToolResult } from "../../../broker/client/types";
import type { Skill } from "../../../domain/skill";

/**
 * Compatibility shim. `ToolDispatcher` previously executed tools in the
 * worker's address space; ADR-016 / Phase A moved that authority to the
 * broker. The `BrokerClient` is now the one and only execution path.
 *
 * This shim exists so a few legacy call sites (ScriptedRuntime, runtime
 * test fakes that subclass `ToolDispatcher`) keep compiling without a
 * sweeping rename. New code should call `BrokerClient.dispatchTool`
 * directly.
 *
 * Phase B is expected to delete the shim outright once the surface is
 * fully migrated; until then the class delegates straight to a
 * BrokerClient and surfaces errors via `throw` to match the old
 * "string out / Error thrown" contract callers depended on.
 */

export interface ToolDispatchContext {
  readonly cwd: string;
  readonly skills: readonly Skill[];
  readonly runId: string;
  readonly phaseId: string;
  readonly allowedTools: readonly string[];
}

export class ToolDispatcher {
  private readonly broker: BrokerClient;

  constructor(broker: BrokerClient) {
    this.broker = broker;
  }

  async dispatch(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolDispatchContext,
  ): Promise<string> {
    const result: ToolResult = await this.broker.dispatchTool({
      tool: name,
      input,
      runId: ctx.runId,
      phaseId: ctx.phaseId,
      cwd: ctx.cwd,
      allowedTools: ctx.allowedTools,
      skills: ctx.skills,
    });
    if (result.ok) return result.output;
    throw new Error(result.error.message);
  }
}
