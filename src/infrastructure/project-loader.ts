import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProjectRegistry, type ProjectsFile, ProjectsFileSchema } from "../domain/project";

export class ProjectRegistryLoader {
  /**
   * Relative paths in projects.yaml resolve against the *projects file's
   * directory*, not `process.cwd()`. Running `ordin run --project X` from
   * a subdirectory must still find the same workspace. Each project's
   * path inherits the file that declared it: local overrides anchor to
   * `localPath`'s dir; shared entries anchor to `sharedPath`'s dir.
   */
  async load(sharedPath: string, localPath?: string): Promise<ProjectRegistry> {
    const shared = await this.readFile(sharedPath);
    const local = localPath ? await this.readFileOrEmpty(localPath) : { projects: {} };

    const sharedRoot = dirname(sharedPath);
    const localRoot = localPath ? dirname(localPath) : sharedRoot;

    const resolved = new Map();
    for (const [name, entry] of Object.entries(shared.projects)) {
      resolved.set(name, projectEntry(name, entry, sharedRoot));
    }
    for (const [name, entry] of Object.entries(local.projects)) {
      resolved.set(name, projectEntry(name, entry, localRoot));
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

function projectEntry(
  name: string,
  entry: { path: string; standards_overlay?: string },
  anchor: string,
): { name: string; path: string; standardsOverlay?: string } {
  return {
    name,
    path: expandPath(entry.path, anchor),
    standardsOverlay: entry.standards_overlay,
  };
}

function expandPath(p: string, anchor: string): string {
  if (p === "~" || p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(anchor, p);
}
