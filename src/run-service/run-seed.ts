import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ArtefactContract, Phase, WorkflowManifest } from "../domain/workflow";
import { resolveArtefactPath } from "../domain/workflow";

export interface ArtifactSeed {
  readonly sourceRepo: string;
  readonly sourceSlug: string;
  readonly targetRepo: string;
  readonly targetSlug: string;
  readonly phase: Phase;
}

export interface FixtureSeed {
  readonly fixturesRoot: string;
  readonly name: string;
  readonly targetRepo: string;
}

export interface FixtureCapture {
  readonly fixturesRoot: string;
  readonly name: string;
  readonly sourceRepo: string;
  readonly sourceSlug: string;
  readonly workflow: WorkflowManifest;
  readonly completedPhaseIds?: readonly string[];
  readonly phase?: Phase;
  readonly force?: boolean;
}

export async function seedFromFixture(input: FixtureSeed): Promise<void> {
  const source = fixturePath(input.fixturesRoot, input.name);
  await copyTreeContents(source, resolve(input.targetRepo));
}

export async function seedPhaseInputsFromRun(input: ArtifactSeed): Promise<void> {
  const missing: string[] = [];
  for (const contract of input.phase.inputs ?? []) {
    const sourcePath = join(input.sourceRepo, resolveArtefactPath(contract, input.sourceSlug));
    if (!(await exists(sourcePath))) missing.push(sourcePath);
  }
  if (missing.length > 0) {
    throw new Error(`Missing source artefacts:\n${missing.map((p) => `- ${p}`).join("\n")}`);
  }

  for (const contract of input.phase.inputs ?? []) {
    const sourcePath = join(input.sourceRepo, resolveArtefactPath(contract, input.sourceSlug));
    const targetPath = join(input.targetRepo, resolveArtefactPath(contract, input.targetSlug));
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
  }
}

export async function captureFixture(input: FixtureCapture): Promise<void> {
  const target = fixturePath(input.fixturesRoot, input.name);
  if ((await exists(target)) && !input.force) {
    throw new Error(`Fixture "${input.name}" already exists; pass --force to overwrite`);
  }
  const contracts = input.phase?.inputs ?? declaredWorkflowArtefacts(input.workflow);
  const existing: ArtefactContract[] = [];
  const missing: string[] = [];
  for (const contract of contracts) {
    const sourcePath = join(input.sourceRepo, resolveArtefactPath(contract, input.sourceSlug));
    if (await exists(sourcePath)) existing.push(contract);
    else missing.push(sourcePath);
  }

  if (input.phase && missing.length > 0) {
    throw new Error(`Missing source artefacts:\n${missing.map((p) => `- ${p}`).join("\n")}`);
  }
  if (!input.phase && existing.length === 0) {
    throw new Error(
      `No declared workflow artefacts found in ${input.sourceRepo} for slug "${input.sourceSlug}"`,
    );
  }

  if (input.force) await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const contract of existing) {
    const rel = resolveArtefactPath(contract, input.sourceSlug);
    const sourcePath = join(input.sourceRepo, rel);
    const targetPath = join(target, rel);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
  }
}

function declaredWorkflowArtefacts(workflow: WorkflowManifest): ArtefactContract[] {
  const byPath = new Map<string, ArtefactContract>();
  for (const phase of workflow.phases) {
    for (const contract of [...(phase.inputs ?? []), ...(phase.outputs ?? [])]) {
      byPath.set(contract.path, contract);
    }
  }
  return [...byPath.values()];
}

function fixturePath(root: string, name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error("Fixture name must be a single path segment");
  }
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, name);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error("Fixture name must stay under fixtures/runs");
  }
  return resolved;
}

async function copyTreeContents(source: string, target: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    const src = join(source, entry.name);
    const dest = join(target, entry.name);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
