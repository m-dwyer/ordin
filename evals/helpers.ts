import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";
import { type Artefact, ArtefactManager, ArtefactPaths } from "../src/domain/artefact";
import { AutoGate } from "../src/gates/auto";
import type { RunEvent } from "../src/runtime/harness";
import { HarnessRuntime } from "../src/runtime/harness";
import { AiSdkRuntime } from "../src/runtimes/ai-sdk";

/**
 * Load `.env.local` explicitly at module import. In an activated mise
 * shell this is redundant (mise already sourced it), but `pnpm eval`
 * invoked from an IDE terminal, a fresh subshell, or anywhere without
 * mise active would otherwise lose LITELLM_MASTER_KEY. Node 22's built-in
 * loader keeps us dependency-free.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
{
  const envFile = join(REPO_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/**
 * Glue for `.eval.ts` files. Stages a fresh fixture repo at
 * `.scratch/eval-repo/`, runs a phase through HarnessRuntime with
 * AiSdkRuntime (LiteLLM-backed) in the "claude-cli" slot and AutoGate
 * for all gates, and returns the produced artefact text.
 *
 * Evals run serially (vitest fileParallelism: false), so one shared
 * eval-repo path is sufficient. The repo is left in place after each
 * run for post-failure inspection; the next `runPhase` call wipes it.
 * `.scratch/` is gitignored.
 */

const TEMPLATE = join(REPO_ROOT, "test/fixtures/target-repo-template");
const EVAL_REPO = join(REPO_ROOT, ".scratch/eval-repo");

export interface RunPhaseInput {
  readonly phase: "plan" | "build" | "review";
  readonly task: string;
  readonly slug: string;
  readonly tier?: "S" | "M" | "L";
}

/**
 * Runs one phase and returns the produced artefact. The domain's
 * `Artefact` gives us { path, content, modifiedAt } — path is useful
 * for rubric-failure messages so authors can inspect the output
 * without hunting for it in `.scratch/`.
 */
export async function runPhase(input: RunPhaseInput): Promise<Artefact> {
  await stageRepo();

  const apiKey = process.env.LITELLM_MASTER_KEY;
  if (!apiKey) {
    throw new Error(
      "LITELLM_MASTER_KEY is unset. Copy .env.local.example to .env.local and set the key.",
    );
  }
  // Optional: route all composer-side model names to one explicit backend
  // alias. Lets you compare models across runs without editing configs —
  // `ORDIN_EVAL_MODEL=qwen3-14b pnpm eval`. The alias must exist in
  // litellm/config.yaml's model_list.
  const overrideAlias = process.env.ORDIN_EVAL_MODEL;
  const modelMap = overrideAlias
    ? new Map<string, string>([
        ["claude-opus-4-7", overrideAlias],
        ["claude-sonnet-4-6", overrideAlias],
      ])
    : undefined;

  const runtime = new AiSdkRuntime({
    baseUrl: process.env.ORDIN_EVAL_BASE_URL ?? "http://localhost:4000",
    apiKey,
    ...(modelMap ? { modelMap } : {}),
  });

  const harness = new HarnessRuntime({
    root: REPO_ROOT,
    runtimes: new Map([["claude-cli", runtime]]),
    gateForKind: () => new AutoGate(),
  });

  await harness.startRun({
    task: input.task,
    slug: input.slug,
    repoPath: EVAL_REPO,
    tier: input.tier ?? "S",
    onlyPhases: [input.phase],
    onEvent: logEvent,
  });

  return new ArtefactManager(EVAL_REPO).read(artefactRelPath(input.phase, input.slug));
}

async function stageRepo(): Promise<void> {
  await rm(EVAL_REPO, { recursive: true, force: true });
  await cp(TEMPLATE, EVAL_REPO, { recursive: true });
  const git = simpleGit({ baseDir: EVAL_REPO });
  await git.init();
  await git.addConfig("user.email", "eval@local");
  await git.addConfig("user.name", "eval");
  await git.add(".");
  await git.commit("init");
}

/**
 * One-line stderr progress for each interesting event. Evals run long
 * enough that silence feels like a hang; this gives live feedback
 * without flooding the terminal.
 */
function logEvent(event: RunEvent): void {
  switch (event.type) {
    case "phase.started":
      // Deliberately not printing event.model — it's the composer-side
      // name ("claude-sonnet-4-6" or whatever ordin.config.yaml says),
      // which AiSdkRuntime then rewrites to the LiteLLM alias, which
      // LiteLLM routes to the actual backend. Three layers; showing
      // only the top one is misleading. See litellm/config.yaml for
      // the actual backend routing.
      process.stderr.write(`\n  [${event.phaseId}] start\n`);
      return;
    case "agent.tool.use": {
      const input = event.input as Record<string, unknown>;
      const preview = summariseToolInput(event.name, input);
      process.stderr.write(`  → ${event.name}${preview ? `(${preview})` : ""}\n`);
      return;
    }
    case "agent.tool.result":
      if (!event.ok) process.stderr.write(`    ✗ tool failed: ${event.preview ?? ""}\n`);
      return;
    case "agent.tokens":
      // Overwrite a single status line in place.
      process.stderr.write(
        `\r  tokens: in ${event.usage.input} / out ${event.usage.output}${" ".repeat(10)}`,
      );
      return;
    case "phase.completed":
      process.stderr.write(`\n  [${event.phaseId}] done in ${(event.durationMs / 1000).toFixed(1)}s\n`);
      return;
    case "phase.failed":
      process.stderr.write(`\n  [${event.phaseId}] FAILED: ${event.error}\n`);
      return;
    case "agent.error":
      process.stderr.write(`\n  error: ${event.message}\n`);
      return;
  }
}

function summariseToolInput(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return pick("file_path") ?? "";
    case "Glob":
      return pick("pattern") ?? "";
    case "Grep":
      return [pick("pattern"), pick("path")].filter(Boolean).join(" in ");
    case "Bash":
      return (pick("command") ?? "").slice(0, 60);
    default:
      return "";
  }
}

function artefactRelPath(phase: RunPhaseInput["phase"], slug: string): string {
  switch (phase) {
    case "plan":
      return ArtefactPaths.rfc(slug);
    case "build":
      return ArtefactPaths.buildNotes(slug);
    case "review":
      return ArtefactPaths.review(slug);
  }
}
