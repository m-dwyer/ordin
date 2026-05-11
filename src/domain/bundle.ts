import { z } from "zod";

/**
 * A bundle is one workflow plus the agents, skills, and (optionally)
 * evals it depends on, in a single directory. The manifest carries
 * packaging metadata; the workflow file stays the engine input.
 *
 *   bundle.yaml            — this manifest
 *   workflow.yaml          — workflow definition (override via `entry`)
 *   agents/<id>.md         — referenced agents
 *   skills/<id>/SKILL.md   — referenced skills
 *   evals/<phaseId>.eval.ts — optional, not part of the bundle hash
 *   README.md              — optional, not part of the bundle hash
 *
 * The bundle hash covers exactly the load-bearing set (manifest + entry
 * + every agent + every skill). README and evals aren't in that set, so
 * they don't need an exclude list — re-scoring or editing docs leaves
 * the bundle hash unchanged automatically.
 */
export const BundleManifestSchema = z.object({
  name: z.string().min(1),
  version: z.union([z.string(), z.number()]).transform((v) => String(v)),
  description: z.string().optional(),
  entry: z.string().min(1).default("workflow.yaml"),
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
type BundleManifestShape = z.infer<typeof BundleManifestSchema>;

export class BundleManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly entry: string;
  readonly runtime?: string;
  readonly model?: string;

  constructor(shape: BundleManifestShape) {
    this.name = shape.name;
    this.version = shape.version;
    this.description = shape.description;
    this.entry = shape.entry;
    this.runtime = shape.runtime;
    this.model = shape.model;
  }
}

/**
 * Per-bundle content hash. `bundle` is the load-bearing value (used for
 * RunMeta + OTel attributes); per-component hashes are kept for granular
 * regression triage when a bundle hash changes.
 */
export interface BundleHash {
  readonly bundle: string;
  readonly workflow: string;
  readonly agents: ReadonlyMap<string, string>;
  readonly skills: ReadonlyMap<string, string>;
}
