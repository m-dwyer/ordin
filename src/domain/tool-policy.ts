import {
  isKnownToolName,
  normalizeToolMatchValue,
  parseToolSpec,
  type ToolSpec,
  toolMatchValue,
} from "./tool-authority";

/**
 * Per-phase Tool Policy (CONTEXT.md). Built from an Allowed Tools entry
 * list; `decide(intent)` answers whether a Tool Intent satisfies the
 * policy. Broker Dispatch holds these as ACL state and asks them; the
 * decision logic — name allowlisting, pattern matching, cwd-relative
 * path normalization — lives here.
 *
 * Broker Dispatch keeps the catalog-level "unknown tool name" rejection
 * and the wiring-error "no ACL registered" rejection; both are outside
 * the policy's scope.
 */

export interface ToolPolicyInput {
  readonly allowedTools: readonly string[];
  readonly hasSkills: boolean;
  /**
   * Phase working directory. Absolute path inputs (Read/Write/Edit
   * file_path, Grep path) are resolved relative to this before being
   * matched against allowed_tools patterns.
   */
  readonly cwd: string;
}

export interface PolicyIntent {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export type PolicyDecisionReason = "tool_not_allowed" | "missing_match_field" | "pattern_mismatch";

export type PolicyDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PolicyDecisionReason; readonly message: string };

export class ToolPolicy {
  private constructor(
    private readonly specs: readonly ToolSpec[],
    private readonly allowedNames: ReadonlySet<string>,
    private readonly cwd: string,
  ) {}

  static from(input: ToolPolicyInput): ToolPolicy {
    const specs = dedupeSpecs(input.allowedTools.map(parseToolSpec));
    const names = new Set(specs.map((spec) => spec.name));
    if (input.hasSkills) names.add("Skill");
    return new ToolPolicy(specs, names, input.cwd);
  }

  /** Names of all tools the phase exposes (incl. auto-added Skill). */
  toolNames(): readonly string[] {
    return [...this.allowedNames];
  }

  decide(intent: PolicyIntent): PolicyDecision {
    if (!this.allowedNames.has(intent.tool)) {
      return {
        ok: false,
        reason: "tool_not_allowed",
        message: `Tool "${intent.tool}" is not in this phase's allowed_tools.`,
      };
    }
    if (!isKnownToolName(intent.tool)) return { ok: true };

    const patterns = this.specs.filter((spec) => spec.name === intent.tool);
    if (patterns.length === 0) return { ok: true };
    if (patterns.some((spec) => !spec.pattern)) return { ok: true };

    const raw = toolMatchValue(intent.tool, intent.input);
    if (raw === undefined) {
      return {
        ok: false,
        reason: "missing_match_field",
        message: `Tool "${intent.tool}" requires a pattern match, but its input has no matchable field.`,
      };
    }
    const value = normalizeToolMatchValue(intent.tool, raw, this.cwd);
    if (patterns.some((spec) => spec.pattern && globMatches(spec.pattern, value))) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "pattern_mismatch",
      message: `Tool "${intent.tool}" input "${raw}" does not match this phase's allowed_tools patterns.`,
    };
  }
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

function globMatches(pattern: string, value: string): boolean {
  return globRegex(pattern).test(value);
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
