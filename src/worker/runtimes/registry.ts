import type { MastraTracingFactory } from "../observability/mastra-tracing";
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
   * Mastra container factory. Mastra-Agent-based runtimes thread the
   * resulting container into their `Agent` constructor so Mastra's
   * tracing pipeline ships chat / tool spans through the configured
   * exporter (today: `LangfuseExporter` via the broker). Other
   * runtimes ignore it. The factory lives in
   * `src/worker/observability/mastra-tracing.ts`; the runtime never
   * imports `@mastra/langfuse` directly.
   */
  readonly mastraTracing?: MastraTracingFactory;
  /**
   * Parent OTel trace context, parsed by the worker entry from W3C
   * `TRACEPARENT`. Mastra-Agent-based runtimes pass these to
   * `agent.stream`'s `tracingOptions` so spans nest under the parent
   * `ordin.phase.*` span instead of producing a sibling trace tree
   * in Langfuse.
   */
  readonly parentTraceId?: string;
  readonly parentSpanId?: string;
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
        ...(ctx.mastraTracing ? { mastraTracing: ctx.mastraTracing } : {}),
        ...(ctx.parentTraceId ? { parentTraceId: ctx.parentTraceId } : {}),
        ...(ctx.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
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
      });
    }
    case "scripted": {
      const { ScriptedRuntime } = await import("./scripted");
      return ScriptedRuntime.fromConfig(configSlice, {
        workflowName: ctx.workflowName,
        harnessRoot: ctx.harnessRoot,
        runsDirFallback: ctx.runsDir,
        ...(ctx.scriptPath ? { scriptPath: ctx.scriptPath } : {}),
      });
    }
    default:
      throw new Error(`Unknown runtime: "${name}"`);
  }
}
