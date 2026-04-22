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

/**
 * Conventional artefact paths, parameterised by slug.
 * Centralised here so a future workflow profile can swap paths
 * without rewriting every agent prompt.
 */
export const ArtefactPaths = {
  rfc: (slug: string) => `docs/rfcs/${slug}-rfc.md`,
  buildNotes: (slug: string) => `docs/rfcs/${slug}-build-notes.md`,
  review: (slug: string) => `reviews/${slug}-review.md`,
  explore: (slug: string) => `explore/${slug}.md`,
  problem: (slug: string) => `problems/${slug}.md`,
} as const;

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
