import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProjectRegistry, type ProjectsFile, ProjectsFileSchema } from "../domain/project";

export class ProjectRegistryLoader {
  async load(sharedPath: string, localPath?: string): Promise<ProjectRegistry> {
    const shared = await this.readFile(sharedPath);
    const local = localPath ? await this.readFileOrEmpty(localPath) : { projects: {} };

    const merged = { ...shared.projects, ...local.projects };
    const resolved = new Map();
    for (const [name, entry] of Object.entries(merged)) {
      resolved.set(name, {
        name,
        path: expandHome(entry.path),
        standardsOverlay: entry.standards_overlay,
      });
    }
    return new ProjectRegistry(resolved);
  }

  private async readFile(path: string): Promise<ProjectsFile> {
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

  private async readFileOrEmpty(path: string): Promise<ProjectsFile> {
    try {
      return await this.readFile(path);
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
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return isAbsolute(p) ? p : resolve(p);
}
