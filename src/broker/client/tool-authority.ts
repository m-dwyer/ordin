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
   * matching against allowed_tools patterns — workflow authors write
   * relative patterns (`Write(docs/rfcs/*)`), agents pass absolute
   * paths, and the matcher bridges them.
   */
  readonly cwd: string;
}

export interface ToolPolicy {
  readonly specs: readonly ToolSpec[];
  readonly toolNames: readonly string[];
  readonly cwd: string;
}

/** Parse allowlist entries like `Read`, `Write(docs/rfcs/*)`, `Bash(git diff*)`. */
export function parseToolSpec(spec: string): ToolSpec {
  const match = spec.trim().match(/^([A-Za-z]+)(?:\((.+)\))?$/);
  return match ? { name: match[1] as string, pattern: match[2] } : { name: spec.trim() };
}

/**
 * Derive the effective tool policy for a phase. This is behavior-preserving:
 * unknown names are kept so the broker can reject them consistently, and
 * patterns are parsed but not enforced yet.
 */
export function deriveToolPolicy(input: ToolPolicyInput): ToolPolicy {
  const specs = dedupeSpecs(input.allowedTools.map(parseToolSpec));
  const toolNames = unique(specs.map((spec) => spec.name));
  if (input.hasSkills && !toolNames.includes("Skill")) {
    toolNames.push("Skill");
  }
  return { specs, toolNames, cwd: input.cwd };
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
