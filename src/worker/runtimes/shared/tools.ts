/**
 * Tool-spec parsing for `allowed_tools` entries. The executors moved
 * to `src/broker/tools/*` per ADR-016 (Phase A); only the parser
 * remains in worker space.
 */

export interface ToolSpec {
  readonly name: string;
  readonly pattern?: string;
}

/** Parse allowlist entries like `Read`, `Write(docs/rfcs/*)`, `Bash(git diff*)`. */
export function parseToolSpec(spec: string): ToolSpec {
  const match = spec.trim().match(/^([A-Za-z]+)(?:\((.+)\))?$/);
  return match ? { name: match[1] as string, pattern: match[2] } : { name: spec.trim() };
}
