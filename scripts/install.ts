#!/usr/bin/env bun
/**
 * Install the compiled ordin binary + bundles + starter config into the
 * conventional user paths:
 *
 *   ~/.local/bin/ordin         — binary (override with --bin-dir)
 *   ~/.ordin/ordin.config.yaml — copied iff not present (no clobber)
 *   ~/.ordin/projects.yaml     — copied iff not present (no clobber)
 *   ~/.ordin/bundles/<name>/   — each in-tree bundle (overwrites; bundles
 *                                are versioned content, not user state)
 *
 * Expects `mise run package` to have been run first; errors if
 * `dist/ordin` is missing. Pass --dry-run to preview without writing.
 */
import { copyFile, cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROJECTS_STARTER = `# Project registry — name workspaces so you can pass \`ordin run -p <name>\`
# instead of \`ordin run --repo /path/to/repo\`. Relative paths resolve
# against this file's directory.
projects: {}
`;

const ENV_STARTER = `# Environment variables loaded at ordin startup. Sourced into the
# compiled binary's process.env before any runtime constructs. Shell
# exports take precedence — values here are defaults for installed
# users who don't want to wrangle shell env per session.
#
# Examples:
#   LITELLM_MASTER_KEY=sk-...      # auth for runtimes.ai-sdk if pointing at LiteLLM
#   ANTHROPIC_API_KEY=sk-ant-...   # if a runtime adapter reads it
#   LANGFUSE_PUBLIC_KEY=pk-...     # OTel egress auth (sandbox: srt only)
#   LANGFUSE_SECRET_KEY=sk-...
`;

const CONFIG_STARTER = `# ordin starter config. Edit to suit your runtime + sandbox setup.
#
# Layering:
#   run_store / default_runtime / default_model / allowed_tools / tiers
#     are harness-level; schema lives in src/domain/config.ts.
#   runtimes.<name>.*  is opaque to the domain; each runtime validates
#     its own slice. The active runtime is picked per-phase by the
#     workflow; blocks below for unselected runtimes stay dormant.
#   \`sandbox: srt\` adds a \`local_services\` block (see the dev tree's
#     ordin.config.yaml for that shape).

run_store:
  base_dir: ~/.ordin/runs

# Fallback when neither the workflow nor phase declares a runtime. Most
# bundles declare their own, so this rarely wins.
default_runtime: claude-cli-provider
default_model: claude-sonnet-4-6
allowed_tools: []

# Passthrough: agent + broker share an address space; no kernel sandbox.
# Switch to \`srt\` once you've configured local_services for proxying.
sandbox: passthrough

# Config for every supported runtime, declared upfront so any bundle
# (regardless of which runtime it picks) can run without further edits.
# Drop a block if you don't have the corresponding tool installed.
runtimes:
  claude-cli-provider:
    bin: claude
    timeout_ms: 600000
    max_steps: 40

  ai-sdk:
    # OpenAI-compatible endpoint. LiteLLM proxy defaults to :4000; point
    # at any compatible gateway. \`api_key_env\` reads the bearer token
    # from the named env var at run time.
    base_url: http://localhost:4000
    api_key_env: LITELLM_MASTER_KEY
    max_steps: 40

  scripted:
    # Deterministic test runtime — reads a YAML plan, no LLM. Plan path
    # auto-detects from <root>/scripts/<bundle>.yaml; override per-run
    # via \`ordin run --script <path>\`.
    {}

tiers:
  S: {}
  M: {}
  L: {}
`;

interface InstallOpts {
  readonly binDir: string;
  readonly home: string;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): InstallOpts {
  let binDir = join(homedir(), ".local", "bin");
  let home = join(homedir(), ".ordin");
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--bin-dir=")) binDir = resolve(arg.slice("--bin-dir=".length));
    else if (arg.startsWith("--home=")) home = resolve(arg.slice("--home=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { binDir, home, dryRun };
}

const opts = parseArgs(process.argv);
const repoRoot = resolve(import.meta.dir, "..");
const binary = join(repoRoot, "dist", "ordin");

if (!(await exists(binary))) {
  console.error("dist/ordin not found — run `mise run package` first.");
  process.exit(1);
}

type Action =
  | { readonly kind: "copy"; readonly from: string; readonly to: string }
  | { readonly kind: "write"; readonly to: string; readonly content: string }
  | { readonly kind: "skip"; readonly to: string; readonly reason: string };

const actions: Action[] = [];

actions.push({ kind: "copy", from: binary, to: join(opts.binDir, "ordin") });

// ordin.config.yaml: write a minimal starter, not the dev copy. The dev
// config is wired for `sandbox: srt` with Langfuse/LiteLLM auth via env
// vars the installed user almost certainly doesn't have set.
const configDest = join(opts.home, "ordin.config.yaml");
actions.push(
  (await exists(configDest))
    ? { kind: "skip", to: configDest, reason: "exists; not overwriting user config" }
    : { kind: "write", to: configDest, content: CONFIG_STARTER },
);

// projects.yaml: write a *minimal* starter, not the dev copy. The dev
// file references `.scratch/target-repo` which would resolve under
// ~/.ordin after install (broken). Users add their own entries.
const projectsDest = join(opts.home, "projects.yaml");
actions.push(
  (await exists(projectsDest))
    ? { kind: "skip", to: projectsDest, reason: "exists; not overwriting user projects" }
    : { kind: "write", to: projectsDest, content: PROJECTS_STARTER },
);

// .env: starter env file loaded by the binary at startup. Lets
// installed users park LITELLM_MASTER_KEY etc. somewhere stable rather
// than wrangling shell exports per session.
const envDest = join(opts.home, ".env");
actions.push(
  (await exists(envDest))
    ? { kind: "skip", to: envDest, reason: "exists; not overwriting user secrets" }
    : { kind: "write", to: envDest, content: ENV_STARTER },
);

const bundlesRoot = join(repoRoot, "bundles");
for (const name of await readdir(bundlesRoot)) {
  const src = join(bundlesRoot, name);
  if (!(await isDir(src))) continue;
  actions.push({ kind: "copy", from: src, to: join(opts.home, "bundles", name) });
}

// (Tree-sitter Worker and its wasm sibling are embedded directly in
// the compiled binary; setupCompiledRuntime extracts them to a cache
// dir on first run. No sibling files to copy.)

for (const action of actions) {
  const tag = describe(action);
  const detail = action.kind === "copy" ? `${action.from}  →  ${action.to}` : action.to;
  const note = action.kind === "skip" ? `  (${action.reason})` : "";
  console.log(`  ${tag.padEnd(10)} ${detail}${note}`);
  if (action.kind === "skip" || opts.dryRun) continue;
  await mkdir(dirname(action.to), { recursive: true });
  if (action.kind === "write") {
    await writeFile(action.to, action.content, "utf8");
  } else if (await isDir(action.from)) {
    await cp(action.from, action.to, { recursive: true });
  } else {
    await copyFile(action.from, action.to);
  }
}

function describe(action: Action): string {
  if (action.kind === "skip") return "skip";
  if (opts.dryRun) return action.kind === "write" ? "would write" : "would copy";
  return action.kind === "write" ? "write" : "copy";
}

if (!opts.dryRun) {
  console.log("");
  console.log(`✓ ordin installed at ${join(opts.binDir, "ordin")}`);
  console.log(`  config root: ${opts.home}`);
  console.log(`  bundles:     ${join(opts.home, "bundles")}`);
  console.log("");
  console.log("If ~/.local/bin isn't on PATH yet:");
  console.log(`  export PATH="${opts.binDir}:$PATH"`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}
