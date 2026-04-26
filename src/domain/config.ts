import { z } from "zod";

/**
 * ordin.config.yaml — global defaults, tier overrides, run-store
 * location, and opaque runtime configs.
 *
 * Design invariant: the domain stays provider-neutral. Runtime-specific
 * config shapes (e.g. Claude CLI bin path, AI SDK base URL) live in
 * each runtime's module and are validated there. This file only knows
 * "a runtime named X has some opaque config" — no runtime names or
 * keys baked into the schema.
 *
 * Workflow-specific phase defaults live in workflows/*.yaml. This file
 * deliberately knows nothing about workflow phase ids.
 */
export const RunStoreSchema = z.object({
  base_dir: z.string().default("~/.ordin/runs"),
});
export type RunStoreRaw = z.infer<typeof RunStoreSchema>;

const DEFAULT_RUN_STORE: RunStoreRaw = { base_dir: "~/.ordin/runs" };

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
  default_runtime: z.string().default("ai-sdk"),
  default_model: z.string().min(1).default("qwen3-8b"),
  allowed_tools: z.array(z.string()).default([]),
  runtimes: RuntimesConfigSchema,
  tiers: TiersSchema,
});

export class HarnessConfig {
  constructor(
    readonly runStore: RunStoreRaw,
    readonly defaultRuntime: string,
    readonly defaultModel: string,
    readonly allowedTools: readonly string[],
    readonly runtimes: RuntimesConfigRaw,
    readonly tiers: TiersRaw,
  ) {}

  tierModel(tier: TierKey): string | undefined {
    return this.tiers[tier].model;
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
    return this.runStore.base_dir;
  }
}
