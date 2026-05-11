import { join } from "node:path";
import type { HarnessPaths, HarnessStateLoader, LoadedHarnessState } from "../application/ports";
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
  readonly engines: Iterable<Engine> | undefined;
}

/**
 * Adapter that materialises HarnessStateLoader from disk: YAML configs,
 * markdown agents and skills, plus engine registration. Memoizes the
 * in-flight load promise so concurrent callers share one read; the
 * cheap runStore() path memoizes config separately to avoid pulling
 * agents/skills/projects when only the run store is needed.
 */
export class DefaultHarnessStateLoader implements HarnessStateLoader {
  readonly root: string;
  readonly workflowName: string;
  private readonly engines: EngineRegistry;
  private loadingPromise?: Promise<LoadedHarnessState>;
  private configPromise?: ReturnType<HarnessConfigLoader["load"]>;

  constructor(private readonly opts: DefaultHarnessStateLoaderOptions) {
    this.root = opts.root;
    this.workflowName = opts.workflowName;
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
