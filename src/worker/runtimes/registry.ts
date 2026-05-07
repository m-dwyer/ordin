import type { BrokerClient } from "../../broker/client/types";
import { buildMastraTracingContainer } from "../observability/mastra-tracing";
import type { AgentRuntime } from "./types";

/**
 * Cross-cutting context the worker hands to whichever runtime adapter
 * it instantiates. The parent owns these paths and ships them in the
 * plan so the worker doesn't compute them itself.
 */
export interface RuntimeBuildContext {
  readonly harnessRoot: string;
  readonly workflowName: string;
  /** Default transcript dir; runtimes use this when `InvokeRequest.runDir` is unset. */
  readonly runsDir: string;
  /** Optional override for `ScriptedRuntime`'s plan file path. */
  readonly scriptPath?: string;
  /**
   * Broker client passed to runtimes that route tool dispatch through
   * the broker (ADR-016). `claude-cli` ignores it (Claude Code's own
   * tools execute inside that subprocess). Required for the others
   * because tool dispatch authority lives broker-side.
   */
  readonly broker?: BrokerClient;
}

/**
 * Single source of truth for runtime instantiation. The worker calls
 * this with one runtime name + the parent-extracted config slice; each
 * adapter's `fromConfig` parses with its own Zod schema. The worker
 * does not load `ordin.config.yaml` itself — slice extraction is the
 * parent's job.
 *
 * Adapters are loaded via dynamic `import()` so the worker bundle
 * doesn't pay for unused runtimes. A claude-cli workflow never loads
 * Vercel AI SDK; an ai-sdk workflow never loads the claude-cli stream
 * parser.
 *
 * Names match the strings that workflow YAML uses in `runtime:` fields.
 */
export const KNOWN_RUNTIME_NAMES = [
  "ai-sdk",
  "claude-cli",
  "claude-cli-provider",
  "scripted",
] as const;
export type KnownRuntimeName = (typeof KNOWN_RUNTIME_NAMES)[number];

export async function buildRuntime(
  name: string,
  configSlice: unknown,
  ctx: RuntimeBuildContext,
): Promise<AgentRuntime> {
  switch (name) {
    case "ai-sdk": {
      const { AiSdkRuntime } = await import("./ai-sdk");
      return AiSdkRuntime.fromConfig(configSlice, {
        runsDir: ctx.runsDir,
        broker: requireBroker(ctx, "ai-sdk"),
        mastraTracing: buildMastraTracingContainer,
      });
    }
    case "claude-cli": {
      const { ClaudeCliRuntime } = await import("./claude-cli");
      return ClaudeCliRuntime.fromConfig(configSlice, {
        pluginDirs: [ctx.harnessRoot],
        runsDirFallback: ctx.runsDir,
      });
    }
    case "claude-cli-provider": {
      const { ClaudeCliProviderRuntime } = await import("./claude-cli-provider");
      return ClaudeCliProviderRuntime.fromConfig(configSlice, {
        harnessRoot: ctx.harnessRoot,
        runsDirFallback: ctx.runsDir,
        broker: requireBroker(ctx, "claude-cli-provider"),
        mastraTracing: buildMastraTracingContainer,
      });
    }
    case "scripted": {
      const { ScriptedRuntime } = await import("./scripted");
      return ScriptedRuntime.fromConfig(configSlice, {
        workflowName: ctx.workflowName,
        harnessRoot: ctx.harnessRoot,
        runsDirFallback: ctx.runsDir,
        broker: requireBroker(ctx, "scripted"),
        ...(ctx.scriptPath ? { scriptPath: ctx.scriptPath } : {}),
      });
    }
    default:
      throw new Error(`Unknown runtime: "${name}"`);
  }
}

function requireBroker(ctx: RuntimeBuildContext, runtimeName: string): BrokerClient {
  if (!ctx.broker) {
    throw new Error(
      `Runtime "${runtimeName}" requires a BrokerClient (ADR-016). ` +
        "Phase A wires `InProcessBrokerClient` for `--sandbox passthrough`; " +
        "`--sandbox seatbelt` is unsupported until Phase B HTTP transport ships.",
    );
  }
  return ctx.broker;
}
