import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * ordin.config.yaml — per-phase model and tool allowlist defaults,
 * runtime configuration, and per-tier overrides.
 *
 * Design invariant: the domain stays provider-neutral. Model IDs are
 * opaque strings that each runtime interprets; tiers are a harness
 * concept. Runtime-specific knobs (Claude's `--effort`, permission modes,
 * plugin dirs) live inside the runtime, not here.
 *
 * Precedence for each resolved setting: agent frontmatter > tier override
 * > phase default. Phase defaults encode the L-tier / heaviest profile.
 */
export const PhaseDefaultsSchema = z.object({
  model: z.string().min(1),
  allowed_tools: z.array(z.string()).default([]),
});
export type PhaseDefaultsRaw = z.infer<typeof PhaseDefaultsSchema>;

const CLAUDE_CLI_DEFAULTS = { bin: "claude", runs_dir: "~/.ordin/runs" } as const;
const RUNTIME_DEFAULTS = { default: "claude-cli", claude_cli: CLAUDE_CLI_DEFAULTS } as const;

export const ClaudeCliConfigSchema = z.object({
  bin: z.string().default(CLAUDE_CLI_DEFAULTS.bin),
  runs_dir: z.string().default(CLAUDE_CLI_DEFAULTS.runs_dir),
});
export type ClaudeCliConfigRaw = z.infer<typeof ClaudeCliConfigSchema>;

export const RuntimeConfigSchema = z.object({
  default: z.string().default(RUNTIME_DEFAULTS.default),
  claude_cli: ClaudeCliConfigSchema.default(CLAUDE_CLI_DEFAULTS),
});
export type RuntimeConfigRaw = z.infer<typeof RuntimeConfigSchema>;

export const BudgetsConfigSchema = z.record(
  z.string(),
  z.object({ soft_tokens: z.number().int().positive().optional() }),
);
export type BudgetsConfigRaw = z.infer<typeof BudgetsConfigSchema>;

export const TierKeySchema = z.enum(["S", "M", "L"]);
export type TierKey = z.infer<typeof TierKeySchema>;

export const TierProfileSchema = z.object({
  model: z.string().min(1).optional(),
});
export type TierProfile = z.infer<typeof TierProfileSchema>;

const EMPTY_TIER: TierProfile = {};
const DEFAULT_TIERS = { S: EMPTY_TIER, M: EMPTY_TIER, L: EMPTY_TIER } as const;

/**
 * Coerce null → {} before each tier is parsed. YAML like
 *
 *   tiers:
 *     L:
 *
 * parses `L` as null (not undefined), which bypasses `.default()`. This
 * preprocess lets users leave a tier empty without boilerplate.
 */
const TierFieldSchema = z.preprocess((v) => (v == null ? {} : v), TierProfileSchema);

export const TiersSchema = z
  .object({
    S: TierFieldSchema,
    M: TierFieldSchema,
    L: TierFieldSchema,
  })
  .default(DEFAULT_TIERS);
export type TiersRaw = z.infer<typeof TiersSchema>;

export const HarnessConfigSchema = z.object({
  runtime: RuntimeConfigSchema.default(RUNTIME_DEFAULTS),
  phases: z.record(z.string(), PhaseDefaultsSchema),
  tiers: TiersSchema,
  budgets: BudgetsConfigSchema.default({}),
});

export interface ResolvedPhaseDefaults {
  readonly model: string;
  readonly allowedTools: readonly string[];
  readonly softTokenBudget?: number;
}

export class HarnessConfig {
  constructor(
    readonly runtime: RuntimeConfigRaw,
    readonly phases: Readonly<Record<string, PhaseDefaultsRaw>>,
    readonly tiers: TiersRaw,
    readonly budgets: Readonly<Record<string, { soft_tokens?: number }>>,
  ) {}

  phaseDefaults(phaseId: string): PhaseDefaultsRaw {
    const defaults = this.phases[phaseId];
    if (!defaults) {
      throw new Error(
        `No defaults for phase "${phaseId}" in ordin.config.yaml (set \`phases.${phaseId}.model\` and \`phases.${phaseId}.allowed_tools\`)`,
      );
    }
    return defaults;
  }

  /**
   * Resolve per-phase defaults for a given tier. The tier's `model`
   * overrides the phase's declared default when set. Runtime-specific
   * concerns (effort, permissions) are not represented here — those
   * belong inside the runtime and are derived from `prompt.tier`.
   */
  resolveDefaults(phaseId: string, tier: TierKey): ResolvedPhaseDefaults {
    const phase = this.phaseDefaults(phaseId);
    const tierProfile = this.tiers[tier];
    const softTokenBudget = this.softTokenBudget(phaseId);
    return {
      model: tierProfile.model ?? phase.model,
      allowedTools: phase.allowed_tools,
      ...(softTokenBudget !== undefined ? { softTokenBudget } : {}),
    };
  }

  softTokenBudget(phaseId: string): number | undefined {
    return this.budgets[phaseId]?.soft_tokens;
  }

  runsDir(): string {
    return expandHome(this.runtime.claude_cli.runs_dir);
  }

  claudeBin(): string {
    return this.runtime.claude_cli.bin;
  }

  static async load(path: string): Promise<HarnessConfig> {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = HarnessConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid ${path}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return new HarnessConfig(
      result.data.runtime,
      result.data.phases,
      result.data.tiers,
      result.data.budgets,
    );
  }
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return isAbsolute(p) ? p : resolve(p);
}
