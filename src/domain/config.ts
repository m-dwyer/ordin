import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * ordin.config.yaml — per-phase defaults, tier overrides, run-store
 * location, and opaque runtime configs.
 *
 * Design invariant: the domain stays provider-neutral. Runtime-specific
 * config shapes (e.g. Claude CLI bin path, AI SDK base URL) live in
 * each runtime's module and are validated there. This file only knows
 * "a runtime named X has some opaque config" — no runtime names or
 * keys baked into the schema.
 *
 * Precedence for each resolved setting: agent frontmatter > tier
 * override > phase default. Phase defaults encode the L-tier / heaviest
 * profile.
 */
export const PhaseDefaultsSchema = z.object({
  model: z.string().min(1),
  allowed_tools: z.array(z.string()).default([]),
});
export type PhaseDefaultsRaw = z.infer<typeof PhaseDefaultsSchema>;

export const RunStoreSchema = z.object({
  base_dir: z.string().default("~/.ordin/runs"),
});
export type RunStoreRaw = z.infer<typeof RunStoreSchema>;

const DEFAULT_RUN_STORE: RunStoreRaw = { base_dir: "~/.ordin/runs" };

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

/**
 * Opaque per-runtime config bag. Each runtime owns its own zod schema
 * and calls `HarnessConfig.runtimeConfig(name)` to fetch its slice —
 * which is validated inside the runtime, not here.
 */
export const RuntimesConfigSchema = z.record(z.string(), z.unknown()).default({});
export type RuntimesConfigRaw = z.infer<typeof RuntimesConfigSchema>;

export const HarnessConfigSchema = z.object({
  run_store: RunStoreSchema.default(DEFAULT_RUN_STORE),
  default_runtime: z.string().default("claude-cli"),
  runtimes: RuntimesConfigSchema,
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
    readonly runStore: RunStoreRaw,
    readonly defaultRuntime: string,
    readonly runtimes: RuntimesConfigRaw,
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
   * Resolve per-phase defaults for a given tier. Precedence per field:
   *   tier override > phase default. Agent frontmatter (if any) wins
   *   over both at composer time.
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

  /**
   * Opaque config slice for a named runtime. Callers validate the shape
   * inside the runtime's own schema (`ClaudeCliRuntime.fromConfig`,
   * etc.) — the domain never interprets it.
   */
  runtimeConfig(name: string): unknown {
    return this.runtimes[name] ?? {};
  }

  runStoreDir(): string {
    return expandHome(this.runStore.base_dir);
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
      result.data.run_store,
      result.data.default_runtime,
      result.data.runtimes,
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
