import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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

  static async load(sharedPath: string, localPath?: string): Promise<ProjectRegistry> {
    const shared = await ProjectRegistry.readFile(sharedPath);
    const local = localPath ? await ProjectRegistry.readFileOrEmpty(localPath) : { projects: {} };

    const merged = { ...shared.projects, ...local.projects };
    const resolved = new Map<string, ResolvedProject>();
    for (const [name, entry] of Object.entries(merged)) {
      resolved.set(name, {
        name,
        path: ProjectRegistry.expandHome(entry.path),
        standardsOverlay: entry.standards_overlay,
      });
    }
    return new ProjectRegistry(resolved);
  }

  private static async readFile(path: string): Promise<ProjectsFile> {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = parseYaml(raw) ?? {};
    const result = ProjectsFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid projects file at ${path}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  private static async readFileOrEmpty(path: string): Promise<ProjectsFile> {
    try {
      return await ProjectRegistry.readFile(path);
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { projects: {} };
      }
      throw err;
    }
  }

  private static expandHome(p: string): string {
    if (p === "~" || p.startsWith("~/")) {
      return resolve(homedir(), p.slice(2));
    }
    return isAbsolute(p) ? p : resolve(p);
  }
}
