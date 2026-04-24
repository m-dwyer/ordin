import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Artefact = a markdown file on disk in the target repo.
 *
 * The harness does not track artefact state in a custom ledger —
 * git history and file timestamps are the ledger. This class only
 * offers thin helpers for reading artefacts after a phase completes
 * and ensuring parent directories exist when a phase's agent writes.
 */
export interface Artefact {
  readonly path: string;
  readonly content: string;
  readonly modifiedAt: number;
}

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

  resolve(relPath: string): string {
    return isAbsolute(relPath) ? relPath : resolve(this.repoPath, relPath);
  }
}
