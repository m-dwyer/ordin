import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Artefact } from "../domain/artefact";

export class ArtefactManager {
  constructor(private readonly repoPath: string) {}

  async read(relPath: string): Promise<Artefact> {
    const full = this.resolve(relPath);
    const [content, stats] = await Promise.all([readFile(full, "utf8"), stat(full)]);
    return { path: full, content, modifiedAt: stats.mtimeMs };
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await stat(this.resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(relPath: string): Promise<void> {
    await mkdir(dirname(this.resolve(relPath)), { recursive: true });
  }

  async findMissing<T extends { readonly path: string }>(
    artefacts: readonly T[],
  ): Promise<readonly T[]> {
    const missing: T[] = [];
    for (const artefact of artefacts) {
      if (!(await this.exists(artefact.path))) {
        missing.push(artefact);
      }
    }
    return missing;
  }

  resolve(relPath: string): string {
    return isAbsolute(relPath) ? relPath : resolve(this.repoPath, relPath);
  }
}
