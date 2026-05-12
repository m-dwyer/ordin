import { isAbsolute, relative } from "node:path";
import { z } from "zod";

/**
 * Domain rules for Allowed Tools and Tool Intent metadata. The broker
 * enforces these rules; worker/runtime adapters consume the same
 * catalog so tool names, schemas, match fields, and path semantics
 * cannot drift.
 */
export const TOOL_CATALOG = {
  Read: {
    description: "Read a UTF-8 file relative to CWD or absolute. Returns its full contents.",
    inputSchema: z.object({
      file_path: z.string().describe("Path, relative to CWD or absolute."),
    }),
    matchField: "file_path",
    pathField: "file_path",
  },
  Write: {
    description: "Overwrite (or create) a file with the given contents. Parent dirs are created.",
    inputSchema: z.object({
      file_path: z.string().describe("Target path; parent dirs are created."),
      content: z.string().describe("Full new file contents (overwrites)."),
    }),
    matchField: "file_path",
    pathField: "file_path",
  },
  Edit: {
    description: "Replace exactly one occurrence of `old_string` with `new_string` in a file.",
    inputSchema: z.object({
      file_path: z.string(),
      old_string: z.string().describe("Exact string to replace; must be unique in the file."),
      new_string: z.string(),
    }),
    matchField: "file_path",
    pathField: "file_path",
  },
  Glob: {
    description: "List files matching a glob pattern. Max 200 results.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'. Max 200 results."),
    }),
    matchField: "pattern",
  },
  Grep: {
    description: "Search file contents for a JavaScript regex.",
    inputSchema: z.object({
      pattern: z.string().describe("JavaScript regex."),
      path: z.string().optional().describe("Optional glob to scope search (default '**/*')."),
    }),
    matchField: "path",
    pathField: "path",
  },
  Bash: {
    description:
      "Run a shell command in CWD via `bash -c`. Returns stdout; throws on non-zero exit.",
    inputSchema: z.object({
      command: z.string().describe("Shell command run in CWD via `bash -c`."),
    }),
    matchField: "command",
  },
  Skill: {
    description: "Load a skill body by name. Catalog is in the user prompt.",
    inputSchema: z.object({
      name: z.string().describe("Name of the skill to load. Catalog is in the user prompt."),
    }),
    matchField: "name",
  },
} as const;

export type ToolName = keyof typeof TOOL_CATALOG;

export interface ToolSpec {
  readonly name: string;
  readonly pattern?: string;
}

export interface ToolPolicyInput {
  readonly allowedTools: readonly string[];
  readonly hasSkills: boolean;
  /**
   * Phase working directory. Used to resolve absolute path inputs
   * (Read/Write/Edit file_path, Grep path) to cwd-relative form before
   * matching against allowed_tools patterns.
   */
  readonly cwd: string;
}

export interface ToolPolicy {
  readonly specs: readonly ToolSpec[];
  readonly toolNames: readonly string[];
  readonly cwd: string;
}

export function knownToolNames(): readonly ToolName[] {
  return Object.keys(TOOL_CATALOG) as ToolName[];
}

export function isKnownToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_CATALOG, name);
}

export function toolDefinition(name: ToolName): (typeof TOOL_CATALOG)[ToolName] {
  return TOOL_CATALOG[name];
}

/** Parse allowlist entries like `Read`, `Write(docs/rfcs/*)`, `Bash(git diff*)`. */
export function parseToolSpec(spec: string): ToolSpec {
  const match = spec.trim().match(/^([A-Za-z]+)(?:\((.+)\))?$/);
  return match ? { name: match[1] as string, pattern: match[2] } : { name: spec.trim() };
}

/**
 * Derive the effective tool policy for a phase. Unknown names are kept
 * so Broker Dispatch can reject them consistently.
 */
export function deriveToolPolicy(input: ToolPolicyInput): ToolPolicy {
  const specs = dedupeSpecs(input.allowedTools.map(parseToolSpec));
  const toolNames = unique(specs.map((spec) => spec.name));
  if (input.hasSkills && !toolNames.includes("Skill")) {
    toolNames.push("Skill");
  }
  return { specs, toolNames, cwd: input.cwd };
}

export function toolMatchValue(tool: ToolName, input: Record<string, unknown>): string | undefined {
  const field = TOOL_CATALOG[tool].matchField;
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

export function normalizeToolMatchValue(tool: ToolName, value: string, cwd: string): string {
  const definition = TOOL_CATALOG[tool];
  const pathField = "pathField" in definition ? definition.pathField : undefined;
  if (!pathField || !cwd || !isAbsolute(value)) return value;
  return relative(cwd, value);
}

export function normalizeToolPathInput(
  tool: ToolName,
  input: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const definition = TOOL_CATALOG[tool];
  const field = "pathField" in definition ? definition.pathField : undefined;
  if (!field) return input;
  const value = input[field];
  if (typeof value !== "string" || !isAbsolute(value)) return input;

  const rel = relative(cwd, value);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${tool} path is outside the workspace: ${value}`);
  }
  return { ...input, [field]: rel || "." };
}

function dedupeSpecs(specs: readonly ToolSpec[]): ToolSpec[] {
  const seen = new Set<string>();
  const out: ToolSpec[] = [];
  for (const spec of specs) {
    const key = `${spec.name}\0${spec.pattern ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return out;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
