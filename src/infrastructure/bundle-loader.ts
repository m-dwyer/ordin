import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Agent } from "../domain/agent";
import { type BundleHash, BundleManifest, BundleManifestSchema } from "../domain/bundle";
import type { Skill } from "../domain/skill";
import type { WorkflowManifest } from "../domain/workflow";
import { AgentLoader } from "./agent-loader";
import { SkillLoader } from "./skill-loader";
import { WorkflowLoader } from "./workflow-loader";

export interface LoadedBundle {
  readonly manifest: BundleManifest;
  readonly workflow: WorkflowManifest;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly skills: ReadonlyMap<string, Skill>;
  readonly hash: BundleHash;
  /** Absolute path to the bundle directory. */
  readonly source: string;
  /**
   * Absolute path to `<source>/script.yaml` if the file exists. Used
   * by `ScriptedRuntime` as the default plan-path fallback so the
   * bundle is self-contained (no parallel `scripts/` directory).
   */
  readonly scriptPath?: string;
}

/**
 * Loads a bundle from a directory and computes its content hash. The
 * hash covers the load-bearing files only (bundle.yaml, the workflow
 * file, every agent, every skill); README/evals/auxiliary files are
 * out-of-set by construction so the hash doesn't shift when they change.
 *
 * Hash form: sha256 over the sorted concatenation of `<rel>\n<sha256>\n`
 * tuples. Per-component hashes are the raw sha256 of each file's bytes —
 * useful for narrowing a regression to a specific agent or skill.
 */
export class BundleLoader {
  constructor(
    private readonly workflows: WorkflowLoader = new WorkflowLoader(),
    private readonly agents: AgentLoader = new AgentLoader(),
    private readonly skills: SkillLoader = new SkillLoader(),
  ) {}

  async load(bundleDir: string): Promise<LoadedBundle> {
    const manifestPath = join(bundleDir, "bundle.yaml");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const parsed: unknown = parseYaml(manifestRaw);
    const result = BundleManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid bundle manifest at ${manifestPath}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const manifest = new BundleManifest(result.data);

    const workflowPath = join(bundleDir, manifest.entry);
    const workflowRaw = await readFile(workflowPath, "utf8");
    const workflow = await this.workflows.load(workflowPath);

    const skills = await loadIfPresent(() => this.skills.loadAll(join(bundleDir, "skills")));
    const agents = await loadIfPresent(() =>
      this.agents.loadAll(join(bundleDir, "agents"), skills),
    );

    const skillBytes = new Map<string, string>();
    for (const skill of skills.values()) {
      skillBytes.set(skill.name, await readFile(skill.source, "utf8"));
    }
    const agentBytes = new Map<string, string>();
    for (const agent of agents.values()) {
      agentBytes.set(agent.name, await readFile(agent.source, "utf8"));
    }

    const scriptAbsPath = join(bundleDir, "script.yaml");
    const scriptBody = await readIfPresent(scriptAbsPath);

    const hash = computeBundleHash({
      manifest: manifestRaw,
      workflow: workflowRaw,
      workflowRel: manifest.entry,
      agents: agentBytes,
      skills: skillBytes,
      script: scriptBody,
    });

    return {
      manifest,
      workflow,
      agents,
      skills,
      hash,
      source: bundleDir,
      ...(scriptBody !== undefined ? { scriptPath: scriptAbsPath } : {}),
    };
  }
}

interface HashInputs {
  readonly manifest: string;
  readonly workflow: string;
  readonly workflowRel: string;
  readonly agents: ReadonlyMap<string, string>;
  readonly skills: ReadonlyMap<string, string>;
  readonly script?: string;
}

function computeBundleHash(inputs: HashInputs): BundleHash {
  const workflowHash = sha256Hex(inputs.workflow);
  const agentHashes = new Map<string, string>();
  for (const [name, body] of inputs.agents) agentHashes.set(name, sha256Hex(body));
  const skillHashes = new Map<string, string>();
  for (const [name, body] of inputs.skills) skillHashes.set(name, sha256Hex(body));

  const entries: { path: string; sha: string }[] = [
    { path: "bundle.yaml", sha: sha256Hex(inputs.manifest) },
    { path: inputs.workflowRel, sha: workflowHash },
  ];
  for (const [name, sha] of agentHashes) entries.push({ path: `agents/${name}`, sha });
  for (const [name, sha] of skillHashes) entries.push({ path: `skills/${name}`, sha });
  if (inputs.script !== undefined) {
    entries.push({ path: "script.yaml", sha: sha256Hex(inputs.script) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const canonical = entries.map((e) => `${e.path}\n${e.sha}\n`).join("");
  return {
    bundle: sha256Hex(canonical),
    workflow: workflowHash,
    agents: agentHashes,
    skills: skillHashes,
  };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function loadIfPresent<T>(load: () => Promise<Map<string, T>>): Promise<Map<string, T>> {
  try {
    return await load();
  } catch (err) {
    if (isMissingDir(err)) return new Map();
    throw err;
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isMissingDir(err)) return undefined;
    throw err;
  }
}

function isMissingDir(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
