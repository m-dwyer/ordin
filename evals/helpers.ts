import { existsSync, readFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";
import { type Artefact, ArtefactManager } from "../src/domain/artefact";
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
export const EVAL_REPO = join(REPO_ROOT, ".scratch/eval-repo");
const FIXTURES = join(REPO_ROOT, "evals/fixtures");

/**
 * Read a fixture file under `evals/fixtures/<relPath>` as a UTF-8 string.
 * Keeps seeded artefacts (RFCs, diffs, build-notes) as real markdown /
 * text files on disk rather than inline template literals — diffs stay
 * clean, editors syntax-highlight them, and `cat` shows the fixture
 * author exactly what the agent will see.
 */
export function loadFixture(relPath: string): string {
  return readFileSync(join(FIXTURES, relPath), "utf8");
}

export interface RunPhaseInput {
  readonly phase: "plan" | "build" | "review";
  readonly task: string;
  readonly slug: string;
  readonly tier?: "S" | "M" | "L";
  /**
   * Optional hook to stage artefacts or files into the ephemeral repo
   * *after* the fixture template copy + git init but *before* the phase
   * runs. Used by isolation-per-phase fixtures: `build.eval.ts` seeds
   * an approved RFC so Build can start from it without chaining Plan.
   */
  readonly seed?: (repoPath: string) => Promise<void>;
}

/**
 * Runs one phase and returns the produced artefact. The domain's
 * `Artefact` gives us { path, content, modifiedAt } — path is useful
 * for rubric-failure messages so authors can inspect the output
 * without hunting for it in `.scratch/`.
 */
export async function runPhase(input: RunPhaseInput): Promise<Artefact> {
  await stageRepo();
  if (input.seed) await input.seed(EVAL_REPO);

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
 * Per-invocation log state. Written files are tracked here so that
 * successive Writes to the same path can show `+A/-R` line deltas
 * against the previous state — useful for watching an agent iterate
 * on its own output (e.g. the verify-then-rewrite loop some models
 * fall into).
 *
 * Everything here operates on the event stream, which is runtime-
 * neutral: works whether the events came from AiSdkRuntime or a
 * future ClaudeCliRuntime-streamed run.
 */
interface PendingCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}
const pendingCalls = new Map<string, PendingCall>();
const writtenSnapshots = new Map<string, string>();

/**
 * Pretty progress stream. Buffers each tool.use until tool.result
 * arrives so we can print the call + outcome as one aligned block.
 */
function logEvent(event: RunEvent): void {
  switch (event.type) {
    case "phase.started":
      // Deliberately not printing event.model — see the three-layer
      // routing in litellm/config.yaml and ARCHITECTURE.md.
      pendingCalls.clear();
      writtenSnapshots.clear();
      process.stderr.write(`\n  [${event.phaseId}] start\n`);
      return;
    case "agent.tool.use":
      pendingCalls.set(event.id, {
        name: event.name,
        input: event.input as Record<string, unknown>,
      });
      return;
    case "agent.tool.result": {
      const pending = pendingCalls.get(event.id);
      pendingCalls.delete(event.id);
      writeToolLine(pending, event.ok, event.preview);
      return;
    }
    case "agent.tokens":
      // Overwrite a single status line in place.
      process.stderr.write(
        `\r  tokens: in ${event.usage.input} / out ${event.usage.output}${" ".repeat(10)}`,
      );
      return;
    case "phase.completed":
      process.stderr.write(
        `\n  [${event.phaseId}] done in ${(event.durationMs / 1000).toFixed(1)}s\n`,
      );
      return;
    case "phase.failed":
      process.stderr.write(`\n  [${event.phaseId}] FAILED: ${event.error}\n`);
      return;
    case "agent.error":
      process.stderr.write(`\n  error: ${event.message}\n`);
      return;
  }
}

function writeToolLine(
  pending: PendingCall | undefined,
  ok: boolean,
  preview: string | undefined,
): void {
  if (!pending) {
    // Orphaned result — shouldn't happen, log minimally.
    process.stderr.write(`    ← ${ok ? "ok" : `✗ ${preview ?? ""}`}\n`);
    return;
  }
  const { args, outcome, extra } = renderTool(pending.name, pending.input, preview ?? "");
  const shown = ok ? outcome : `✗ ${preview ?? "failed"}`;
  const head = `  → ${pending.name}(${args})`;
  process.stderr.write(shown ? `${head}  →  ${shown}\n` : `${head}\n`);
  if (ok && extra) {
    for (const line of extra) process.stderr.write(`           ${line}\n`);
  }
}

interface ToolRender {
  readonly args: string;
  readonly outcome: string;
  readonly extra?: readonly string[];
}

/**
 * Render one tool call as {args, outcome, optional extra lines}.
 *
 * Glob/Grep/Read infer from the runtime-truncated preview (160 char cap,
 * so counts show "+" when we likely missed some). Write reads the file
 * directly and diffs against the last snapshot — independent of which
 * runtime wrote it. Edit surfaces before/after from the event.input
 * itself, also runtime-agnostic.
 */
function renderTool(
  name: string,
  input: Record<string, unknown>,
  preview: string,
): ToolRender {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const count = (label: string): string => {
    if (!preview || preview === "(no matches)") return "(no matches)";
    const n = preview.split("\n").filter((l) => l.length > 0).length;
    return preview.length >= 160 ? `${n}+ ${label}` : `${n} ${label}`;
  };

  switch (name) {
    case "Read":
      return {
        args: s("file_path"),
        outcome: preview.length >= 160 ? "(truncated preview)" : `${preview.length} B`,
      };
    case "Write":
      return { args: s("file_path"), outcome: writeDelta(input) };
    case "Edit":
      return {
        args: s("file_path"),
        outcome: "edited",
        extra: [
          `-  ${truncate(firstLine(s("old_string")), 100)}`,
          `+  ${truncate(firstLine(s("new_string")), 100)}`,
        ],
      };
    case "Glob":
      return { args: s("pattern"), outcome: count("matches") };
    case "Grep":
      return {
        args: s("path") ? `${s("pattern")} in ${s("path")}` : s("pattern"),
        outcome: count("hits"),
      };
    case "Bash":
      return {
        args: truncate(s("command"), 80),
        outcome: preview ? truncate(preview.replace(/\s+/g, " "), 60) : "ok",
      };
    default:
      return { args: "", outcome: "" };
  }
}

/**
 * Line delta for Write, computed from on-disk state.
 *
 * Strategy: on each Write, snapshot the path's post-write content.
 * On the next Write to the same path, diff old snapshot vs. new
 * content. For the first Write to a path we report `+N (new)`.
 *
 * Cross-runtime: depends only on the event's `file_path` input and
 * the eval's known CWD. Works identically for AiSdk or a future
 * runtime that emits the same event shape.
 */
function writeDelta(input: Record<string, unknown>): string {
  const relPath = typeof input.file_path === "string" ? input.file_path : "";
  if (!relPath) return "";
  let current: string;
  try {
    current = readFileSync(join(EVAL_REPO, relPath), "utf8");
  } catch {
    return ""; // file moved / disappeared between write and log
  }
  const prior = writtenSnapshots.get(relPath);
  writtenSnapshots.set(relPath, current);
  if (prior === undefined) {
    return `+${current.split("\n").length} lines (new)`;
  }
  const { added, removed } = lineDelta(prior, current);
  return added === 0 && removed === 0 ? "no change" : `+${added}/-${removed} lines`;
}

function lineDelta(before: string, after: string): { added: number; removed: number } {
  const beforeSet = new Set(before.split("\n"));
  const afterSet = new Set(after.split("\n"));
  let added = 0;
  let removed = 0;
  for (const line of after.split("\n")) if (!beforeSet.has(line)) added++;
  for (const line of before.split("\n")) if (!afterSet.has(line)) removed++;
  return { added, removed };
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return nl < 0 ? s : s.slice(0, nl);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Eval-side mirror of `software-delivery.yaml`'s declared phase
 * outputs. Hardcoded here (rather than parsed from YAML) because evals
 * are repo-local and we want assertions to fail loudly if a workflow
 * author changes a path without updating eval expectations.
 */
export function artefactPathFor(
  phase: "plan" | "build" | "review",
  slug: string,
): string {
  switch (phase) {
    case "plan":
      return `docs/rfcs/${slug}-rfc.md`;
    case "build":
      return `docs/rfcs/${slug}-build-notes.md`;
    case "review":
      return `reviews/${slug}-review.md`;
  }
}

function artefactRelPath(phase: RunPhaseInput["phase"], slug: string): string {
  return artefactPathFor(phase, slug);
}
