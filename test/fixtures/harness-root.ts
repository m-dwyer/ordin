import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as toYaml } from "yaml";

export const FIXTURE_BUNDLE_NAME = "software-delivery";

/**
 * Build a temp harness root containing the in-tree bundle, ready for
 * Harness({ root, bundle: FIXTURE_BUNDLE_NAME }) to load.
 *
 * Layout:
 *   <root>/ordin.config.yaml — minimal config with isolated runs/ dir
 *   <root>/projects.yaml      — empty registry
 *   <root>/bundles            — symlink → <repo>/bundles (where the
 *                               real software-delivery bundle lives)
 *
 * The symlink keeps tests honest: they exercise the same workflow,
 * agents, and skills that ship to users — no synthesised duplicate.
 */
export async function makeHarnessRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ordin-fixture-"));

  await write(
    join(root, "ordin.config.yaml"),
    toYaml({
      run_store: { base_dir: join(root, "runs") },
      default_runtime: "ai-sdk",
      default_model: "m",
      allowed_tools: [],
      runtimes: { "ai-sdk": { base_url: "http://localhost:4000" } },
      tiers: { S: {}, M: {}, L: {} },
    }),
  );
  await write(join(root, "projects.yaml"), toYaml({ projects: {} }));
  await symlink(repoBundlesDir(), join(root, "bundles"));

  return root;
}

function repoBundlesDir(): string {
  // test/fixtures/harness-root.ts → test/fixtures → test → repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bundles");
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
