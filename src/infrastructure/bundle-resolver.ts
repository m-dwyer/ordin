import { stat } from "node:fs/promises";
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
    return path;
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
