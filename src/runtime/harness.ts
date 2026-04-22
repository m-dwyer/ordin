import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Agent, AgentLoader } from "../domain/agent";
import { ArtefactPaths } from "../domain/artefact";
import type { ArtefactPointer } from "../domain/composer";
import { HarnessConfig } from "../domain/config";
import { ProjectRegistry } from "../domain/project";
import { type Skill, SkillLoader } from "../domain/skill";
import { type Phase, type Workflow, WorkflowLoader } from "../domain/workflow";
import { AutoGate } from "../gates/auto";
import { ClackGate } from "../gates/clack";
import type { Gate } from "../gates/types";
import type { RunEvent } from "../orchestrator/events";
import { type RunMeta, RunStore } from "../orchestrator/run-store";
import type { RunInput } from "../orchestrator/sequential";
import { SequentialOrchestrator } from "../orchestrator/sequential";
import { ClaudeCliRuntime } from "../runtimes/claude-cli";
import type { AgentRuntime } from "../runtimes/types";

export type { RunEvent } from "../orchestrator/events";
export type { PhaseMeta, RunMeta } from "../orchestrator/run-store";

/**
 * Stable library surface. The CLI is the Stage 1 client; Phase 2 adds
 * an HTTP adapter that will call the same methods.
 */
export interface HarnessRuntimeOptions {
  /** Harness repo root. Defaults to the repo this module lives in. */
  readonly root?: string;
  /**
   * Which workflow to execute. Defaults to "software-delivery".
   * Resolved as `<root>/workflows/<name>.yaml`.
   */
  readonly workflow?: string;
  /**
   * Override the runtime map. Keys are the runtime names the workflow
   * references (today: "claude-cli"). When provided, the default
   * `ClaudeCliRuntime` construction is skipped entirely — callers supply
   * whatever `AgentRuntime` they want slotted into each workflow-declared
   * name. Used by the eval suite to run phases through `AiSdkRuntime`
   * against a LiteLLM proxy.
   */
  readonly runtimes?: ReadonlyMap<string, AgentRuntime>;
  /**
   * Override how gates are resolved. Defaults to the production mapping
   * (clack for human, auto for auto/pre-commit). The eval suite passes
   * an AutoGate-only resolver so fixtures run unattended.
   */
  readonly gateForKind?: (kind: Phase["gate"]) => Gate;
}

export interface StartRunInput {
  readonly task: string;
  readonly slug: string;
  readonly projectName?: string;
  readonly repoPath?: string;
  readonly tier?: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  /** Begin at this phase; earlier phases are skipped. */
  readonly startAt?: string;
  /** Run only these phases (in workflow order). Overrides startAt. */
  readonly onlyPhases?: readonly string[];
  readonly abortSignal?: AbortSignal;
}

interface LoadedState {
  readonly config: HarnessConfig;
  readonly workflow: Workflow;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly skills: ReadonlyMap<string, Skill>;
  readonly projects: ProjectRegistry;
  readonly runStore: RunStore;
}

export class HarnessRuntime {
  private loaded?: LoadedState;

  private readonly root: string;
  private readonly workflowName: string;
  private readonly runtimesOverride?: ReadonlyMap<string, AgentRuntime>;
  private readonly gateResolver?: (kind: Phase["gate"]) => Gate;

  constructor(opts: HarnessRuntimeOptions = {}) {
    this.root = opts.root ?? defaultRoot();
    this.workflowName = opts.workflow ?? "software-delivery";
    this.runtimesOverride = opts.runtimes;
    this.gateResolver = opts.gateForKind;
  }

  async startRun(input: StartRunInput): Promise<RunMeta> {
    const { config, workflow, agents, skills, projects, runStore } = await this.load();

    const repo = this.resolveRepo(input, projects);
    const slug = requireSlug(input.slug);
    const tier = input.tier ?? "M";

    const trimmedWorkflow = input.onlyPhases
      ? workflow.only(input.onlyPhases)
      : input.startAt
        ? workflow.startingAt(input.startAt)
        : workflow;
    const startPhase = trimmedWorkflow.firstPhase();

    const artefactOutputs = new Map<string, readonly ArtefactPointer[]>([
      [
        "plan",
        [
          {
            label: "RFC",
            path: ArtefactPaths.rfc(slug),
            description: "Reviewable RFC for this problem",
          },
        ],
      ],
      [
        "build",
        [
          {
            label: "Build notes",
            path: ArtefactPaths.buildNotes(slug),
            description: "Summary of build decisions, tests added, risks",
          },
        ],
      ],
      [
        "review",
        [
          {
            label: "Review",
            path: ArtefactPaths.review(slug),
            description: "Independent review against the RFC",
          },
        ],
      ],
    ]);

    const artefactInputs = this.buildInputsFor(startPhase.id, slug);

    const runtimes =
      this.runtimesOverride ??
      new Map<string, AgentRuntime>([
        [
          "claude-cli",
          new ClaudeCliRuntime({
            bin: config.claudeBin(),
            runsDir: config.runsDir(),
            // The ordin repo itself is a Claude Code plugin
            // (.claude-plugin/plugin.json + top-level skills/). Loading it
            // per-invocation means zero pollution of ~/.claude/.
            pluginDirs: [this.root],
          }),
        ],
      ]);

    const orchestrator = new SequentialOrchestrator({
      workflow: trimmedWorkflow,
      config,
      agents,
      skills,
      runtimes,
      runStore,
      gateForKind: this.gateResolver ?? this.gateForKind.bind(this),
    });

    const runInput: RunInput = {
      task: input.task,
      slug,
      repo,
      tier,
      artefactInputs,
      artefactOutputs,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    };
    return orchestrator.run(runInput);
  }

  async listRuns(): Promise<RunMeta[]> {
    const { runStore } = await this.load();
    return runStore.listRuns();
  }

  async getRun(runId: string): Promise<RunMeta> {
    const { runStore } = await this.load();
    return runStore.readMeta(runId);
  }

  async workflowDefinition(): Promise<Workflow> {
    const { workflow } = await this.load();
    return workflow;
  }

  /** Paths ordin knows about — useful for the CLI `doctor` command. */
  paths(): HarnessPaths {
    return {
      root: this.root,
      configFile: join(this.root, "ordin.config.yaml"),
      workflowFile: join(this.root, "workflows", `${this.workflowName}.yaml`),
      agentsDir: join(this.root, "agents"),
      skillsDir: join(this.root, "skills"),
      projectsFile: join(this.root, "projects.yaml"),
      projectsLocalFile: join(this.root, "projects.local.yaml"),
    };
  }

  private async load(): Promise<LoadedState> {
    if (this.loaded) return this.loaded;
    const paths = this.paths();
    const [config, workflow, agents, skills, projects] = await Promise.all([
      HarnessConfig.load(paths.configFile),
      new WorkflowLoader().load(paths.workflowFile),
      new AgentLoader().loadAll(paths.agentsDir),
      new SkillLoader().loadAll(paths.skillsDir),
      ProjectRegistry.load(paths.projectsFile, paths.projectsLocalFile),
    ]);
    this.loaded = {
      config,
      workflow,
      agents,
      skills,
      projects,
      runStore: new RunStore(config.runsDir()),
    };
    return this.loaded;
  }

  private resolveRepo(input: StartRunInput, projects: ProjectRegistry): string {
    if (input.repoPath) return resolve(input.repoPath);
    if (input.projectName) return projects.get(input.projectName).path;
    throw new Error("startRun requires either `projectName` (registry) or `repoPath`");
  }

  private gateForKind(kind: Phase["gate"]): Gate {
    switch (kind) {
      case "human":
        return new ClackGate();
      case "auto":
        return new AutoGate();
      case "pre-commit":
        // Phase 1: pre-commit is a placeholder — we gate on the host hook,
        // not in-harness. Treat as auto-approve here; the real check is the
        // repo's pre-commit running during Build.
        return new AutoGate();
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unknown gate kind: ${String(_exhaustive)}`);
      }
    }
  }

  private buildInputsFor(phaseId: string, slug: string): ArtefactPointer[] {
    const rfc: ArtefactPointer = {
      label: "Approved RFC",
      path: ArtefactPaths.rfc(slug),
      description: "Plan-phase output; source of truth for Build and Review",
    };
    const buildNotes: ArtefactPointer = {
      label: "Build notes",
      path: ArtefactPaths.buildNotes(slug),
      description: "Build-phase summary",
    };
    switch (phaseId) {
      case "plan":
        return [];
      case "build":
        return [rfc];
      case "review":
        return [rfc, buildNotes];
      default:
        return [];
    }
  }
}

export interface HarnessPaths {
  readonly root: string;
  readonly configFile: string;
  readonly workflowFile: string;
  readonly agentsDir: string;
  readonly skillsDir: string;
  readonly projectsFile: string;
  readonly projectsLocalFile: string;
}

function requireSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}": use lowercase kebab-case (e.g. "add-user-search")`);
  }
  return slug;
}

function defaultRoot(): string {
  // Walk up from this file: src/runtime/harness.ts → src/runtime → src → root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
