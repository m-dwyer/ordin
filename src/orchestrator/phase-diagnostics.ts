import type { ArtefactPointer } from "../domain/composer";
import type { RuntimeEvent } from "../worker/runtimes/types";

export function diagnoseMissingOutputs(
  missing: readonly ArtefactPointer[],
  events: readonly RuntimeEvent[],
  transcriptPath: string | undefined,
): string {
  const relevant = relevantToolAttempts(missing, events);
  const failed = relevant.find((attempt) => attempt.result?.ok === false);
  if (failed?.result) {
    return joinParts([
      `Relevant ${failed.name} tool call failed for ${failed.path}.`,
      failed.result.result ? `Tool error: ${oneLine(failed.result.result, 240)}` : undefined,
      transcriptHint(transcriptPath),
    ]);
  }

  if (relevant.length > 0) {
    return joinParts([
      `A tool call targeted ${relevant.map((attempt) => attempt.path).join(", ")}, but the file was still missing during post-flight verification.`,
      "Check whether the tool wrote outside the workspace, used a different relative path, or failed without surfacing an error.",
      transcriptHint(transcriptPath),
    ]);
  }

  return joinParts([
    `No Write/Edit/Bash tool call appears to target the missing output path(s): ${missing.map((m) => m.path).join(", ")}.`,
    toolSummary(events),
    lastAssistantText(events),
    transcriptHint(transcriptPath),
  ]);
}

interface ToolAttempt {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly result?: Extract<RuntimeEvent, { type: "tool.result" }>;
}

function relevantToolAttempts(
  missing: readonly ArtefactPointer[],
  events: readonly RuntimeEvent[],
): readonly ToolAttempt[] {
  const results = new Map(
    events
      .filter((e): e is Extract<RuntimeEvent, { type: "tool.result" }> => e.type === "tool.result")
      .map((e) => [e.id, e]),
  );
  return events
    .filter((e): e is Extract<RuntimeEvent, { type: "tool.use" }> => e.type === "tool.use")
    .map((e) => toolPath(e))
    .filter((attempt): attempt is ToolAttempt => {
      if (!attempt) return false;
      return missing.some((m) => pathLooksRelevant(attempt.path, m.path));
    })
    .map((attempt) => ({ ...attempt, result: results.get(attempt.id) }));
}

function toolPath(event: Extract<RuntimeEvent, { type: "tool.use" }>): ToolAttempt | undefined {
  if (event.name === "Write" || event.name === "Edit") {
    const filePath = inputString(event.input, "file_path");
    return filePath ? { id: event.id, name: event.name, path: filePath } : undefined;
  }
  if (event.name === "Bash") {
    const command = inputString(event.input, "command");
    return command ? { id: event.id, name: event.name, path: command } : undefined;
  }
  return undefined;
}

function inputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pathLooksRelevant(candidate: string, expected: string): boolean {
  return (
    candidate === expected || candidate.endsWith(`/${expected}`) || candidate.includes(expected)
  );
}

function toolSummary(events: readonly RuntimeEvent[]): string | undefined {
  const toolNames = events
    .filter((e): e is Extract<RuntimeEvent, { type: "tool.use" }> => e.type === "tool.use")
    .map((e) => e.name);
  if (toolNames.length === 0) return "The runtime did not emit any tool calls.";
  return `Tools used: ${toolNames.join(" -> ")}.`;
}

function lastAssistantText(events: readonly RuntimeEvent[]): string | undefined {
  const text = events
    .filter(
      (e): e is Extract<RuntimeEvent, { type: "assistant.text" }> => e.type === "assistant.text",
    )
    .at(-1)?.text;
  return text ? `Last assistant text: ${oneLine(text, 240)}` : undefined;
}

function transcriptHint(transcriptPath: string | undefined): string | undefined {
  return transcriptPath ? `Transcript: ${transcriptPath}` : undefined;
}

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

function oneLine(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}
