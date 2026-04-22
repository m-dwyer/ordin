import type { ComposedPrompt } from "../domain/composer";

/**
 * Runtime contract. Runtimes adapt a specific agent CLI or SDK to the
 * harness; swapping runtimes is an isolated adapter change.
 *
 * Stage 1 has one runtime: ClaudeCliRuntime (subprocess `claude -p`).
 * Future: SdkRuntime when Phase 10 triggers.
 */
export interface AgentRuntime {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  invoke(req: InvokeRequest): Promise<InvokeResult>;
}

export interface RuntimeCapabilities {
  readonly nativeSkillDiscovery: boolean;
  readonly streaming: boolean;
  readonly mcpSupport: boolean;
  readonly maxContextTokens: number;
}

export interface InvokeRequest {
  readonly runId: string;
  readonly prompt: ComposedPrompt;
  /**
   * Called for each structured event emitted by the runtime.
   * These are runtime-local; the orchestrator tags them with runId +
   * phaseId before surfacing as `RunEvent` to higher layers.
   */
  readonly onEvent?: (event: RuntimeEvent) => void;
  readonly abortSignal?: AbortSignal;
}

export interface InvokeResult {
  readonly status: "ok" | "failed";
  readonly exitCode: number;
  readonly transcriptPath: string;
  readonly tokens: TokenUsage;
  readonly durationMs: number;
  readonly error?: string;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheReadInput: number;
  readonly cacheCreationInput: number;
}

/**
 * Runtime-local events observed from within a single phase invocation
 * (one `invoke()` call = one subprocess = one stream, including any
 * subagent activity the runtime delegates internally).
 *
 * No runId/phaseId — those are added by the orchestrator when promoting
 * these to `RunEvent`.
 */
export type RuntimeEvent =
  | { readonly type: "assistant.text"; readonly text: string }
  | { readonly type: "assistant.thinking" }
  | {
      readonly type: "tool.use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool.result";
      readonly id: string;
      readonly ok: boolean;
      readonly preview?: string;
    }
  | { readonly type: "tokens"; readonly usage: TokenUsage }
  | { readonly type: "error"; readonly message: string };
