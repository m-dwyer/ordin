import { existsSync, readFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";
import type { Artefact } from "../src/domain/artefact";
import { PhasePreparer, resolveArtefacts } from "../src/domain/phase-preview";
import { AgentLoader } from "../src/infrastructure/agent-loader";
import { ArtefactManager } from "../src/infrastructure/artefact-manager";
import { HarnessConfigLoader } from "../src/infrastructure/config-loader";
import { SkillLoader } from "../src/infrastructure/skill-loader";
import { WorkflowLoader } from "../src/infrastructure/workflow-loader";
import { withSpan } from "../src/observability/spans";
import type { RunEvent } from "../src/orchestrator/events";
import { PhaseRunner } from "../src/orchestrator/phase-runner";
import { generateRunId, RunStore } from "../src/orchestrator/run-store";
import { AiSdkRuntime } from "../src/runtimes/ai-sdk";
import { judgeModel } from "./judge";

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
   * Model to compose the prompt with — wins over workflow YAML defaults.
   * Optional; falls back to `ORDIN_EVAL_MODEL` env var. The eval owns
   * the (agent, model, runtime) tuple it's testing, not the workflow's
   * production declaration.
   */
  readonly model?: string;
  /**
   * Optional hook to stage artefacts or files into the ephemeral repo
   * *after* the fixture template copy + git init but *before* the phase
   * runs. Used by isolation-per-phase fixtures: `build.eval.ts` seeds
   * an approved RFC so Build can start from it without chaining Plan.
   */
  readonly seed?: (repoPath: string) => Promise<void>;
}

/**
 * Runs one phase as an isolated `(agent, model, runtime, inputs) →
 * artefact` test. Composes the phase via `PhasePreparer` and invokes
 * via `PhaseRunner` directly — bypasses `harness.startRun` and the
 * workflow engine entirely. The eval owns the model under test; the
 * workflow YAML supplies *defaults* for production runs but is not
 * load-bearing for eval signal.
 *
 * The domain's `Artefact` returned here gives us `{ path, content,
 * modifiedAt }` — path is useful for rubric-failure messages so
 * authors can inspect the output without hunting for it in `.scratch/`.
 */
export async function runPhase(input: RunPhaseInput): Promise<Artefact> {
  judgeModel(); // fail-fast: judge model must be configured

  const model = input.model ?? process.env.ORDIN_EVAL_MODEL;
  if (!model) {
    throw new Error(
      "Agent model not configured. Pass `model` to runPhase or set ORDIN_EVAL_MODEL.",
    );
  }

  const apiKey = process.env.LITELLM_MASTER_KEY;
  if (!apiKey) {
    throw new Error(
      "LITELLM_MASTER_KEY is unset. Copy .env.local.example to .env.local and set the key.",
    );
  }

  const slug = input.slug;
  const tier = input.tier ?? "S";
  const runId = generateRunId(slug);

  return withSpan(
    `ordin.eval.phase.${input.phase}`,
    {
      "ordin.run_id": runId,
      "ordin.phase_id": input.phase,
      "ordin.eval": true,
      "ordin.model": model,
      "ordin.tier": tier,
      "langfuse.trace.name": `${input.phase}: ${input.slug}`,
      "langfuse.trace.input": input.task,
      "langfuse.session.id": runId,
    },
    async (span) => {
      await stageRepo();
      if (input.seed) await input.seed(EVAL_REPO);

      const paths = harnessPaths();
      const [config, workflow, skills] = await Promise.all([
        new HarnessConfigLoader().load(paths.configFile),
        new WorkflowLoader().load(paths.workflowFile),
        new SkillLoader().loadAll(paths.skillsDir),
      ]);
      const agents = await new AgentLoader().loadAll(paths.agentsDir, skills);

      const phase = workflow.findPhase(input.phase);
      const agent = agents.get(phase.agent);
      if (!agent) {
        throw new Error(`Agent "${phase.agent}" declared by phase "${phase.id}" not loaded`);
      }

      const artefactInputs = resolveArtefacts(phase.inputs, slug);
      const artefactOutputs = resolveArtefacts(phase.outputs, slug);

      const artefacts = new ArtefactManager(EVAL_REPO);
      const missingIn = await artefacts.findMissing(artefactInputs);
      if (missingIn.length > 0) {
        throw new Error(
          `Phase "${phase.id}" inputs missing on disk: ${missingIn.map((m) => m.path).join(", ")}`,
        );
      }

      const preview = new PhasePreparer().prepare({
        phase,
        agent,
        workflow,
        config,
        task: input.task,
        cwd: EVAL_REPO,
        tier,
        artefactInputs,
        artefactOutputs,
        model,
      });

      const runtime = new AiSdkRuntime({
        baseUrl: process.env.ORDIN_EVAL_BASE_URL ?? "http://localhost:4000",
        apiKey,
      });

      const runStore = new RunStore(config.runStoreDir());
      const runDir = await runStore.ensureRunDir(runId);

      const result = await new PhaseRunner().run({
        preview,
        runtime,
        context: { runId, runDir, iteration: 1 },
        emit: logEvent,
      });

      if (result.invokeResult.status === "failed") {
        throw new Error(result.invokeResult.error ?? `phase "${phase.id}" runtime failed`);
      }

      const missingOut = await artefacts.findMissing(artefactOutputs);
      if (missingOut.length > 0) {
        throw new Error(
          `Phase "${phase.id}" declared outputs that were not written: ${missingOut.map((m) => m.path).join(", ")}`,
        );
      }

      const artefact = await artefacts.read(artefactRelPath(input.phase, slug));
      span.setAttribute("langfuse.trace.output", artefact.path);
      return artefact;
    },
  );
}

interface HarnessPaths {
  readonly configFile: string;
  readonly workflowFile: string;
  readonly agentsDir: string;
  readonly skillsDir: string;
}

function harnessPaths(): HarnessPaths {
  return {
    configFile: join(REPO_ROOT, "ordin.config.yaml"),
    workflowFile: join(REPO_ROOT, "workflows", "software-delivery.yaml"),
    agentsDir: join(REPO_ROOT, "agents"),
    skillsDir: join(REPO_ROOT, "skills"),
  };
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
      pendingCalls.clear();
      writtenSnapshots.clear();
      process.stderr.write(
        `\n  [${event.phaseId}] start  agent: ${event.model}  judge: ${judgeModel()}\n`,
      );
      return;
    case "agent.text": {
      const trimmed = event.text.trim();
      if (trimmed) process.stderr.write(`  · ${truncate(firstLine(trimmed), 140)}\n`);
      return;
    }
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
    case "Skill":
      return {
        args: s("name"),
        outcome: preview ? `${preview.length}+ B body` : "loaded",
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
