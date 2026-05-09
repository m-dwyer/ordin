import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HarnessPaths, HarnessStateLoader, LoadedHarnessState } from "../application/ports";
import type { SandboxMode } from "../domain/config";
import { AgentLoader } from "../infrastructure/agent-loader";
import { HarnessConfigLoader } from "../infrastructure/config-loader";
import { ProjectRegistryLoader } from "../infrastructure/project-loader";
import { SkillLoader } from "../infrastructure/skill-loader";
import { WorkflowLoader } from "../infrastructure/workflow-loader";
import { type Engine, EngineRegistry } from "../orchestrator/engine";
import { MastraEngine } from "../orchestrator/mastra";
import { RunStore } from "../orchestrator/run-store";
import { KNOWN_RUNTIME_NAMES } from "../worker/runtimes/registry";

export interface DefaultHarnessStateLoaderOptions {
  readonly root: string;
  readonly workflowName: string;
  readonly engineName: string;
  readonly engines?: Iterable<Engine>;
  readonly sandboxModeOverride?: SandboxMode;
}

/**
 * Adapter that materialises HarnessStateLoader from disk: YAML configs,
 * markdown agents and skills, plus engine registration. Memoizes the
 * in-flight load promise so concurrent callers share one read; the
 * cheap runStore() path memoizes config separately to avoid pulling
 * agents/skills/projects when only the run store is needed.
 */
export class DefaultHarnessStateLoader implements HarnessStateLoader {
  private readonly engines: EngineRegistry;
  private loadingPromise?: Promise<LoadedHarnessState>;
  private configPromise?: ReturnType<HarnessConfigLoader["load"]>;

  constructor(private readonly opts: DefaultHarnessStateLoaderOptions) {
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

  load(): Promise<LoadedHarnessState> {
    this.loadingPromise ??= this.doLoad();
    return this.loadingPromise;
  }

  async runStore(): Promise<RunStore> {
    const config = await this.loadConfig();
    return new RunStore(config.runStoreDir());
  }

  async resolveWorkspace(input: {
    readonly projectName?: string;
    readonly repoPath?: string;
  }): Promise<string> {
    if (input.repoPath && input.projectName) {
      throw new Error(
        "startRun accepts either `projectName` (registry) or `repoPath`, not both — " +
          "pick the one that names the workspace you mean to run against.",
      );
    }
    if (!input.repoPath && !input.projectName) {
      throw new Error("startRun requires either `projectName` (registry) or `repoPath`");
    }
    const workspaceRoot = input.repoPath
      ? resolve(input.repoPath)
      : (await this.load()).projects.get(input.projectName ?? "").path;
    await assertWorkspaceDirectory(workspaceRoot);
    return workspaceRoot;
  }

  async sandboxMode(): Promise<SandboxMode> {
    if (this.opts.sandboxModeOverride) return this.opts.sandboxModeOverride;
    const config = await this.loadConfig();
    return config.sandboxMode();
  }

  private async doLoad(): Promise<LoadedHarnessState> {
    const paths = this.paths();
    const [config, workflow, skills, projects] = await Promise.all([
      this.loadConfig(),
      new WorkflowLoader().load(paths.workflowFile),
      new SkillLoader().loadAll(paths.skillsDir),
      new ProjectRegistryLoader().load(paths.projectsFile, paths.projectsLocalFile),
    ]);
    const agents = await new AgentLoader().loadAll(paths.agentsDir, skills);
    return {
      config,
      workflow,
      agents,
      projects,
      runStore: new RunStore(config.runStoreDir()),
      engine: this.engines.get(this.opts.engineName),
      runtimeNames: new Set(KNOWN_RUNTIME_NAMES),
    };
  }

  private loadConfig() {
    this.configPromise ??= new HarnessConfigLoader().load(this.paths().configFile);
    return this.configPromise;
  }
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
