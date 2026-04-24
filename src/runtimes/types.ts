import type { ComposedPrompt } from "../domain/composer";

/**
 * Runtime contract. Runtimes adapt a specific agent CLI or SDK to the
 * harness; swapping runtimes is an isolated adapter change.
 *
 * Today's runtimes: `ClaudeCliRuntime` (subprocess `claude -p` — the
 * only way to drive Claude under a Max plan subscription) and
 * `AiSdkRuntime` (Vercel AI SDK against any OpenAI-compatible
 * provider, used for evals). Neither is a committed long-term
 * production choice; both sit behind this interface so the engine
 * swaps one for another without domain changes.
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
   * Directory where this run's artefacts live (`meta.json`,
   * `<phase>.jsonl` transcripts, any debug logs). Orchestrator-owned
   * path; runtimes write into it rather than computing their own.
   */
  readonly runDir?: string;
  /**
   * Disable session persistence for this invocation. Maps to
   * `--no-session-persistence` for the Claude CLI. Eval fixtures opt
   * in so repeat runs don't accumulate on-disk session history.
   */
  readonly ephemeralSession?: boolean;
  /**
   * Emit token-level streaming events. Maps to
   * `--include-partial-messages` for the Claude CLI. Interactive CLI
   * runs turn this on for live typing; eval runs leave it off.
   */
  readonly streamPartial?: boolean;
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
  /**
   * Session identifier captured from the agent, when the runtime
   * surfaces one (Claude CLI's `system` init message). Persisted on
   * `PhaseMeta` for future `ordin continue` / `--resume` support.
   */
  readonly sessionId?: string;
  /**
   * Structured failure detail when `status === "failed"`. Orchestrator
   * extensions (retry, iteration) can dispatch on `kind` / `retryable`
   * without string-parsing stderr.
   */
  readonly failure?: RuntimeFailure;
  /**
   * Convenience string form of the failure — kept for `PhaseMeta.error`
   * back-compat. When `failure` is set, this mirrors `failure.message`.
   */
  readonly error?: string;
}

export type RuntimeFailureKind =
  | "rate_limit"
  | "auth"
  | "tool"
  | "model"
  | "timeout"
  | "crash"
  | "unknown";

export interface RuntimeFailure {
  readonly kind: RuntimeFailureKind;
  readonly message: string;
  readonly retryable: boolean;
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
      /** Set when the tool use belongs to a subagent (Task tool). */
      readonly parentToolUseId?: string;
    }
  | {
      readonly type: "tool.result";
      readonly id: string;
      readonly ok: boolean;
      readonly preview?: string;
      /** Set when the tool result belongs to a subagent (Task tool). */
      readonly parentToolUseId?: string;
    }
  | { readonly type: "tokens"; readonly usage: TokenUsage }
  | { readonly type: "error"; readonly message: string };
