import { z } from "zod";

/**
 * Project registry. `projects.yaml` is shared; `projects.local.yaml`
 * is gitignored per-engineer overlay. Local keys win on collision.
 */
export const ProjectEntrySchema = z.object({
  path: z.string().min(1),
  standards_overlay: z.string().optional(),
});
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;

export const ProjectsFileSchema = z.object({
  projects: z.record(z.string(), ProjectEntrySchema).default({}),
});
export type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

export interface ResolvedProject {
  readonly name: string;
  readonly path: string;
  readonly standardsOverlay?: string;
}

export class ProjectRegistry {
  constructor(private readonly projects: Map<string, ResolvedProject>) {}

  get(name: string): ResolvedProject {
    const entry = this.projects.get(name);
    if (!entry) {
      throw new Error(
        `Project "${name}" not registered. Add it to projects.yaml or projects.local.yaml.`,
      );
    }
    return entry;
  }

  has(name: string): boolean {
    return this.projects.has(name);
  }

  names(): string[] {
    return [...this.projects.keys()];
  }

  all(): ResolvedProject[] {
    return [...this.projects.values()];
  }
}
