import type { HarnessConfig } from "../domain/config";
import { AiSdkRuntime } from "./ai-sdk";
import { ClaudeCliRuntime } from "./claude-cli";
import { ScriptedRuntime } from "./scripted";
import type { AgentRuntime } from "./types";

/**
 * Cross-cutting context all runtimes draw from. The harness owns these
 * paths; runtimes shouldn't compute them themselves.
 */
export interface RuntimeBuildContext {
  readonly harnessRoot: string;
  readonly workflowName: string;
  /** Optional override for `ScriptedRuntime`'s plan file path. */
  readonly scriptPath?: string;
}

/**
 * Single source of truth for runtime instantiation. Used both by the
 * parent harness (validating a phase's runtime name + serving the
 * registry to engine-services) and by the per-phase worker (building
 * exactly the one runtime it needs to invoke).
 *
 * Names match the strings that workflow YAML uses in `runtime:` fields.
 */
export const KNOWN_RUNTIME_NAMES = ["ai-sdk", "claude-cli", "scripted"] as const;
export type KnownRuntimeName = (typeof KNOWN_RUNTIME_NAMES)[number];

export function buildRuntime(
  name: string,
  config: HarnessConfig,
  ctx: RuntimeBuildContext,
): AgentRuntime {
  switch (name) {
    case "ai-sdk":
      return AiSdkRuntime.fromConfig(config.runtimeConfig("ai-sdk"), {
        runsDir: config.runStoreDir(),
      });
    case "claude-cli":
      return ClaudeCliRuntime.fromConfig(config.runtimeConfig("claude-cli"), {
        pluginDirs: [ctx.harnessRoot],
        runsDirFallback: config.runStoreDir(),
      });
    case "scripted":
      return ScriptedRuntime.fromConfig(config.runtimeConfig("scripted"), {
        workflowName: ctx.workflowName,
        harnessRoot: ctx.harnessRoot,
        runsDirFallback: config.runStoreDir(),
        ...(ctx.scriptPath ? { scriptPath: ctx.scriptPath } : {}),
      });
    default:
      throw new Error(`Unknown runtime: "${name}"`);
  }
}

export function buildAllRuntimes(
  config: HarnessConfig,
  ctx: RuntimeBuildContext,
): ReadonlyMap<string, AgentRuntime> {
  return new Map<string, AgentRuntime>(
    KNOWN_RUNTIME_NAMES.map((name) => [name, buildRuntime(name, config, ctx)]),
  );
}
