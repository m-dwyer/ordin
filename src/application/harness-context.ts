import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Agent } from "../domain/agent";
import type { HarnessConfig, SandboxMode } from "../domain/config";
import type { ProjectRegistry } from "../domain/project";
import type { WorkflowManifest } from "../domain/workflow";
import { AgentLoader } from "../infrastructure/agent-loader";
import { HarnessConfigLoader } from "../infrastructure/config-loader";
import { ProjectRegistryLoader } from "../infrastructure/project-loader";
import { SkillLoader } from "../infrastructure/skill-loader";
import { WorkflowLoader } from "../infrastructure/workflow-loader";
import {
  type Engine,
  EngineRegistry,
  type EngineServices,
  type WorkflowProgram,
} from "../orchestrator/engine";
import { MastraEngine } from "../orchestrator/mastra";
import { RunStore } from "../orchestrator/run-store";
import { KNOWN_RUNTIME_NAMES } from "../worker/runtimes/registry";
import type { StartRunInput } from "./types";

export interface HarnessPaths {
  readonly root: string;
  readonly configFile: string;
  readonly workflowFile: string;
  readonly agentsDir: string;
  readonly skillsDir: string;
  readonly projectsFile: string;
  readonly projectsLocalFile: string;
}

export interface LoadedHarnessState {
  readonly config: HarnessConfig;
  readonly workflow: WorkflowManifest;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly projects: ProjectRegistry;
  readonly runStore: RunStore;
}

export interface PreparedRun {
  readonly state: LoadedHarnessState;
  readonly engine: Engine;
  readonly program: WorkflowProgram;
  readonly slug: string;
  readonly workspaceRoot: string;
}

export interface HarnessContextOptions {
  readonly root: string;
  readonly workflowName: string;
  readonly engineName: string;
  readonly engines?: Iterable<Engine>;
  readonly sandboxModeOverride?: SandboxMode;
}

export class HarnessContext {
  private loaded?: LoadedHarnessState;
  private readonly engines: EngineRegistry;

  constructor(private readonly opts: HarnessContextOptions) {
    this.engines = new EngineRegistry([new MastraEngine(), ...(opts.engines ?? [])]);
  }

  paths(): HarnessPaths {
    return {
      root: this.opts.root,
      configFile: join(this.opts.root, "ordin.config.yaml"),
      workflowFile: join(this.opts.root, "workflows", `${this.opts.workflowName}.yaml`),
      agentsDir: join(this.opts.root, "agents"),
      skillsDir: join(this.opts.root, "skills"),
      projectsFile: join(this.opts.root, "projects.yaml"),
      projectsLocalFile: join(this.opts.root, "projects.local.yaml"),
    };
  }

  async load(): Promise<LoadedHarnessState> {
    if (this.loaded) return this.loaded;
    const paths = this.paths();
    const configLoader = new HarnessConfigLoader();
    const projectLoader = new ProjectRegistryLoader();
    const [config, workflow, skills, projects] = await Promise.all([
      configLoader.load(paths.configFile),
      new WorkflowLoader().load(paths.workflowFile),
      new SkillLoader().loadAll(paths.skillsDir),
      projectLoader.load(paths.projectsFile, paths.projectsLocalFile),
    ]);
    const agents = await new AgentLoader().loadAll(paths.agentsDir, skills);
    this.loaded = {
      config,
      workflow,
      agents,
      projects,
      runStore: new RunStore(config.runStoreDir()),
    };
    return this.loaded;
  }

  async prepareRun(input: StartRunInput): Promise<PreparedRun> {
    const state = await this.load();
    const slug = requireSlug(input.slug);
    const workspaceRoot = await this.resolveRunWorkspace(input, state.projects);
    const engine = this.engines.get(this.opts.engineName);
    const program = engine.compile(workflowForRun(state.workflow, input));
    return { state, engine, program, slug, workspaceRoot };
  }

  async workflowDefinition(): Promise<WorkflowManifest> {
    const { workflow } = await this.load();
    return workflow;
  }

  async resolveRunWorkspace(
    input: Pick<StartRunInput, "projectName" | "repoPath">,
    projects?: ProjectRegistry,
  ): Promise<string> {
    const registry = projects ?? (await this.load()).projects;
    if (input.repoPath && input.projectName) {
      throw new Error(
        "startRun accepts either `projectName` (registry) or `repoPath`, not both — " +
          "pick the one that names the workspace you mean to run against.",
      );
    }
    const workspaceRoot = input.repoPath
      ? resolve(input.repoPath)
      : input.projectName
        ? registry.get(input.projectName).path
        : undefined;
    if (!workspaceRoot) {
      throw new Error("startRun requires either `projectName` (registry) or `repoPath`");
    }
    await assertWorkspaceDirectory(workspaceRoot);
    return workspaceRoot;
  }

  async sandboxMode(): Promise<SandboxMode> {
    if (this.opts.sandboxModeOverride) return this.opts.sandboxModeOverride;
    const { config } = await this.load();
    return config.sandboxMode();
  }

  engineServices(state: LoadedHarnessState): EngineServices {
    return {
      config: state.config,
      agents: state.agents,
      runtimeNames: new Set(KNOWN_RUNTIME_NAMES),
      runStore: state.runStore,
    };
  }
}

function requireSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}": use lowercase kebab-case (e.g. "add-user-search")`);
  }
  return slug;
}

function workflowForRun(workflow: WorkflowManifest, input: StartRunInput): WorkflowManifest {
  if (input.onlyPhases) return workflow.only(input.onlyPhases);
  if (input.startAt) return workflow.startingAt(input.startAt);
  return workflow;
}

async function assertWorkspaceDirectory(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (err) {
    const code =
      typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      throw new Error(`Workspace path does not exist: ${path}`);
    }
    throw err;
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${path}`);
  }
}
