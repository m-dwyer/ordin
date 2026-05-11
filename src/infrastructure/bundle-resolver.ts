import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/**
 * Resolves a bundle name to an on-disk directory by walking an ordered
 * search path. Search order (top wins):
 *
 *   1. explicit `bundleDir` override (full path; bypasses lookup)
 *   2. $ORDIN_BUNDLE_PATH (colon-separated dirs)
 *   3. <cwd>/bundles
 *   4. ~/.ordin/bundles
 *
 * A directory qualifies as a bundle iff it contains `bundle.yaml`. The
 * resolver does not parse the manifest — that's BundleLoader's job.
 */
export interface BundleResolverOptions {
  readonly cwd?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export class BundleResolver {
  private readonly cwd: string;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: BundleResolverOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.home = opts.home ?? homedir();
    this.env = opts.env ?? process.env;
  }

  searchPath(): readonly string[] {
    const path: string[] = [];
    const envPath = this.env["ORDIN_BUNDLE_PATH"];
    if (envPath) {
      for (const dir of envPath.split(":")) {
        if (dir) path.push(resolvePath(dir));
      }
    }
    path.push(join(this.cwd, "bundles"));
    path.push(join(this.home, ".ordin", "bundles"));
    // Caller-provided cwd can collapse with $HOME/.ordin (e.g. the compiled
    // binary falls back to ~/.ordin as its config root). Dedupe so error
    // messages don't show the same path twice.
    return Array.from(new Set(path));
  }

  /**
   * Enumerate every bundle reachable via the search path. Earlier
   * search-path entries shadow later ones — matching `resolve()`
   * precedence — so `bundle list` shows the bundle the loader would
   * actually pick.
   */
  async list(): Promise<readonly { name: string; dir: string; source: string }[]> {
    const seen = new Set<string>();
    const out: { name: string; dir: string; source: string }[] = [];
    for (const root of this.searchPath()) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        continue;
      }
      for (const name of entries.sort()) {
        if (seen.has(name)) continue;
        const dir = join(root, name);
        if (!(await hasManifest(dir))) continue;
        seen.add(name);
        out.push({ name, dir, source: root });
      }
    }
    return out;
  }

  async resolve(name: string, override?: { bundleDir?: string }): Promise<string> {
    if (override?.bundleDir) {
      const dir = resolvePath(override.bundleDir);
      if (!(await hasManifest(dir))) {
        throw new Error(`No bundle.yaml found at ${dir}`);
      }
      return dir;
    }
    const searched: string[] = [];
    for (const root of this.searchPath()) {
      const candidate = join(root, name);
      searched.push(candidate);
      if (await hasManifest(candidate)) return candidate;
    }
    throw new Error(`Bundle "${name}" not found. Searched:\n  ${searched.join("\n  ")}`);
  }
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    const s = await stat(join(dir, "bundle.yaml"));
    return s.isFile();
  } catch {
    return false;
  }
}
