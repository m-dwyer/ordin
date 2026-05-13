import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { BrokerClient, ToolIntent } from "../../../broker/client/types";
import { executeTool } from "../../tools/dispatcher";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
  RuntimeEvent,
} from "../types";
import { ScriptedPlanLoader } from "./loader";
import type { ScriptedPlan } from "./types";

export type { ScriptedPhase, ScriptedPlan, ScriptedStep, ScriptedToolCall } from "./types";

/**
 * Deterministic test runtime. Executes a per-phase script of tool
 * calls + text emissions instead of calling an LLM. Same `AgentRuntime`
 * interface as `AiSdkRuntime` (and any future runtime), same tool
 * dispatch path (via `runtimes/shared/dispatcher.ts`), same
 * `RuntimeEvent` stream shape — but reproducible inputs and zero
 * model dependency.
 *
 * Use cases:
 *   - End-to-end sandbox validation without LLM unreliability.
 *   - Eval baselines that don't burn tokens on infra-only checks.
 *   - CI smoke runs of harness changes against a known-good plan.
 *   - Demos where a fixed plan tells a deterministic story.
 *
 * Cooperative scripts only in v1 — each step runs and is expected to
 * succeed. Adversarial scripts (`expect: deny | succeed` annotations)
 * land in Phase 6 on top of this primitive.
 */

export interface ScriptedRuntimeOptions {
  /** Programmatic plan — used by tests/evals. Wins over `planLoader`. */
  readonly plan?: ScriptedPlan;
  /**
   * Lazy loader — used by the CLI / production. Called once on first
   * `invoke()` and the result memoised. Typically loads YAML from
   * `scripts/<workflow-name>.yaml` or a `--script <path>` override.
   */
  readonly planLoader?: () => Promise<ScriptedPlan>;
  /** Fallback transcript dir when `InvokeRequest.runDir` is unset. */
  readonly runsDirFallback?: string;
  /**
   * Tool execution surface (ADR-016). Each step's `tool` invocation
   * goes through `broker.requestApproval` for ACL + audit + (Phase C)
   * scanner, executes worker-side, then `broker.recordResult` for the
   * outcome envelope. Same flow scripted runs share with model-driven
   * runtimes.
   */
  readonly broker: BrokerClient;
}

/**
 * Validated config slice for ScriptedRuntime. Currently empty —
 * scripted bundles carry their plan as `<bundleDir>/script.yaml` and
 * the composition root resolves the path; nothing useful lives in
 * the per-runtime YAML slice today.
 */
export const ScriptedConfigSchema = z.object({});
export type ScriptedConfigRaw = z.infer<typeof ScriptedConfigSchema>;

export interface ScriptedRuntimeFromConfigExtras {
  /** Bundle name — surfaced in errors. */
  readonly bundleName: string;
  /** Harness content root — used only in error messages. */
  readonly harnessRoot: string;
  /** Run-store fallback for transcript writes. */
  readonly runsDirFallback?: string;
  /**
   * Resolved plan-file path. The composition root merges the CLI
   * `--script` override with the in-bundle `script.yaml` fallback
   * before constructing this runtime; undefined means the bundle has
   * no script and no override was given.
   */
  readonly scriptPath?: string;
  /** Broker client for tool dispatch (ADR-016). */
  readonly broker: BrokerClient;
}

export class ScriptedRuntime implements AgentRuntime {
  readonly name = "scripted";
  readonly capabilities: RuntimeCapabilities = {
    nativeSkillDiscovery: false,
    streaming: false,
    mcpSupport: false,
    maxContextTokens: Number.POSITIVE_INFINITY,
  };

  private plan?: ScriptedPlan;
  private readonly planLoader?: () => Promise<ScriptedPlan>;
  private readonly runsDirFallback: string;
  private readonly broker: BrokerClient;

  constructor(opts: ScriptedRuntimeOptions) {
    this.plan = opts.plan;
    this.planLoader = opts.planLoader;
    this.runsDirFallback = opts.runsDirFallback ?? join(homedir(), ".ordin", "runs");
    this.broker = opts.broker;
  }

  static fromConfig(raw: unknown, extras: ScriptedRuntimeFromConfigExtras): ScriptedRuntime {
    ScriptedConfigSchema.parse(raw ?? {});
    if (!extras.scriptPath) {
      throw new Error(
        `ScriptedRuntime: bundle "${extras.bundleName}" has no script.yaml ` +
          "and no --script override was provided.",
      );
    }
    const loader = new ScriptedPlanLoader();
    const planPath = extras.scriptPath;
    return new ScriptedRuntime({
      planLoader: () => loader.load(planPath),
      broker: extras.broker,
      ...(extras.runsDirFallback ? { runsDirFallback: extras.runsDirFallback } : {}),
    });
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const plan = await this.resolvePlan();
    const phase = plan.get(req.prompt.phaseId);
    if (!phase) {
      const known = [...plan.keys()].join(", ") || "(none)";
      throw new Error(
        `ScriptedRuntime: no script for phase "${req.prompt.phaseId}". Defined phases: ${known}.`,
      );
    }

    const runDir = req.runDir ?? resolve(this.runsDirFallback, req.runId);
    const transcriptPath = join(runDir, `${req.prompt.phaseId}.jsonl`);
    await mkdir(runDir, { recursive: true });

    const transcript = createWriteStream(transcriptPath, { flags: "a" });
    const started = Date.now();
    const subs = substitutionMap(req);

    const emit = (event: RuntimeEvent): void => {
      transcript.write(`${JSON.stringify(event)}\n`);
      req.onEvent?.(event);
    };

    let toolCounter = 0;

    try {
      for (const step of phase.steps) {
        if (req.abortSignal?.aborted) break;
        if (step.text) emit({ type: "assistant.text", text: substitute(step.text, subs) });
        if (step.thinking) emit({ type: "assistant.thinking" });
        if (step.tool) {
          const id = `scripted-${++toolCounter}`;
          const expanded = substituteInput(step.tool.input, subs);
          const intent: ToolIntent = {
            tool: step.tool.name,
            input: expanded,
            runId: req.runId,
            phaseId: req.prompt.phaseId,
            cwd: req.prompt.cwd,
            skills: req.prompt.skills,
          };
          emit({ type: "tool.use", id, name: step.tool.name, input: expanded });
          const stepStarted = Date.now();
          const approval = await this.broker.requestApproval(intent);
          if (!approval.ok) {
            const message = approval.error.message;
            emit({ type: "tool.result", id, ok: false, result: message });
            await this.broker.recordResult(intent, {
              result: { ok: false, error: approval.error },
              durationMs: Date.now() - stepStarted,
            });
            throw new Error(message);
          }
          const result = await executeTool(step.tool.name, expanded, {
            cwd: req.prompt.cwd,
            skills: req.prompt.skills,
          });
          await this.broker.recordResult(intent, {
            result,
            durationMs: Date.now() - stepStarted,
          });
          if (result.ok) {
            emit({
              type: "tool.result",
              id,
              ok: true,
              ...(result.output ? { result: result.output } : {}),
            });
          } else {
            const message = result.error.message;
            emit({ type: "tool.result", id, ok: false, result: message });
            throw new Error(message);
          }
        }
      }
    } catch (err) {
      await closeStream(transcript);
      const message = (err as Error).message;
      return {
        status: "failed",
        exitCode: 1,
        transcriptPath,
        tokens: ZERO_TOKENS,
        durationMs: Date.now() - started,
        failure: { kind: "tool", message, retryable: false },
        error: message,
      };
    }

    await closeStream(transcript);
    return {
      status: "ok",
      exitCode: 0,
      transcriptPath,
      tokens: ZERO_TOKENS,
      durationMs: Date.now() - started,
    };
  }

  private async resolvePlan(): Promise<ScriptedPlan> {
    if (this.plan) return this.plan;
    if (!this.planLoader) {
      throw new Error(
        "ScriptedRuntime has no plan and no planLoader. " +
          "Pass `plan` for programmatic use or `planLoader` for lazy YAML loading.",
      );
    }
    this.plan = await this.planLoader();
    return this.plan;
  }
}

const ZERO_TOKENS = {
  input: 0,
  output: 0,
  cacheReadInput: 0,
  cacheCreationInput: 0,
  totalInput: 0,
} as const;

/**
 * Variables available for `{var}` substitution in step `text` and
 * tool input strings: `{cwd}`, `{workspace}` (alias), `{run_id}`,
 * `{phase}`. Slugs are not exposed here — slug substitution happens
 * in the orchestrator's artefact-path layer before tool inputs reach
 * the runtime.
 */
function substitutionMap(req: InvokeRequest): Record<string, string> {
  return {
    cwd: req.prompt.cwd,
    workspace: req.prompt.cwd,
    run_id: req.runId,
    phase: req.prompt.phaseId,
  };
}

function substitute(template: string, subs: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (full, key: string) =>
    Object.hasOwn(subs, key) ? (subs[key] ?? full) : full,
  );
}

function substituteInput(
  input: Record<string, unknown>,
  subs: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === "string" ? substitute(v, subs) : v;
  }
  return out;
}

/**
 * Wait for the write stream to fully flush + close. Without this,
 * `invoke()` returns before macOS has finished syncing the transcript
 * file — tests that clean up their scratch dir can race the late
 * writes and trigger uncaught ENOENT.
 */
function closeStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    stream.once("finish", () => resolveClose());
    stream.once("error", rejectClose);
    stream.end();
  });
}
