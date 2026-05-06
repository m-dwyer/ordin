import type { Readable, Writable } from "node:stream";
import type { TokenUsage } from "./types";

/**
 * Shared types and parser for the `claude -p --output-format
 * stream-json` line protocol. Lives outside `claude-cli-provider.ts`
 * and `claude-language-model-v2.ts` so both can import it without
 * forming a cycle.
 */

export interface ProviderMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ClaudeToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type ProviderSpawner = (
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ProviderChildProcess;

export interface ProviderChildProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider turn timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

export function interpretClaudeStreamLine(line: string): {
  readonly texts: readonly string[];
  readonly thinking: boolean;
  readonly toolCall?: ClaudeToolCall;
  readonly tokens?: TokenUsage;
  readonly sessionId?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed Claude stream-json line: ${message}`);
  }
  if (!parsed || typeof parsed !== "object") return { texts: [], thinking: false };

  const event = parsed as ClaudeStreamEvent;
  const texts: string[] = [];
  let thinking = false;
  let toolCall: ClaudeToolCall | undefined;
  let tokens: TokenUsage | undefined;
  let sessionId: string | undefined;

  if (event.type === "system" && event.subtype === "init" && event.session_id) {
    sessionId = event.session_id;
  } else if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "thinking") {
        thinking = true;
      } else if (block.type === "tool_use" && block.id && block.name) {
        const input =
          block.input && typeof block.input === "object" && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {};
        toolCall = { id: block.id, name: block.name, input };
      }
    }
    if (event.message.usage) tokens = usageFromClaude(event.message.usage);
  } else if (event.type === "result" && event.usage) {
    tokens = usageFromClaude(event.usage);
    if (event.session_id) sessionId = event.session_id;
  }

  return {
    texts,
    thinking,
    ...(toolCall ? { toolCall } : {}),
    ...(tokens ? { tokens } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function usageFromClaude(usage: ClaudeUsage): TokenUsage {
  const input = usage.input_tokens ?? 0;
  const cacheReadInput = usage.cache_read_input_tokens ?? 0;
  const cacheCreationInput = usage.cache_creation_input_tokens ?? 0;
  return {
    input,
    output: usage.output_tokens ?? 0,
    cacheReadInput,
    cacheCreationInput,
    totalInput: input + cacheReadInput + cacheCreationInput,
  };
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ClaudeContentBlock[]; usage?: ClaudeUsage };
  usage?: ClaudeUsage;
}
interface ClaudeContentBlock {
  type?: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
