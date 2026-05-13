import { join } from "node:path";
import type { Agent } from "../domain/agent";
import type { HarnessConfig } from "../domain/config";
import type { ProjectRegistry } from "../domain/project";
import type { WorkflowManifest } from "../domain/workflow";
import { BundleLoader } from "../infrastructure/bundle-loader";
import { BundleResolver } from "../infrastructure/bundle-resolver";
import { HarnessConfigLoader } from "../infrastructure/config-loader";
import { ProjectRegistryLoader } from "../infrastructure/project-loader";
import { type Engine, EngineRegistry } from "../orchestrator/engine";
import { MastraEngine } from "../orchestrator/mastra-engine";
import { RunStore } from "../orchestrator/run-store";
import { KNOWN_RUNTIME_NAMES } from "../worker/runtimes/registry";

export interface HarnessPaths {
  /** Harness config root (where ordin.config.yaml + projects.yaml live). */
  readonly root: string;
  readonly configFile: string;
  readonly projectsFile: string;
  readonly projectsLocalFile: string;
}

/** Provenance for the loaded bundle — flowed into RunMeta and OTel spans. */
export interface LoadedBundleInfo {
  readonly name: string;
  readonly version: string;
  readonly hash: string;
  /**
   * Absolute path to the bundle's `script.yaml`, if present. Picked up
   * by `ScriptedRuntime` as the third-tier plan-path fallback (after
   * the `--script` CLI override and the `script_path` config slice).
   */
  readonly scriptPath?: string;
}

export interface LoadedHarnessState {
  readonly config: HarnessConfig;
  readonly workflow: WorkflowManifest;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly projects: ProjectRegistry;
  readonly runStore: RunStore;
  readonly engine: Engine;
  readonly runtimeNames: ReadonlySet<string>;
  readonly bundle: LoadedBundleInfo;
}

export interface DefaultHarnessStateLoaderOptions {
  /** Where ordin.config.yaml + projects.yaml live (the harness config root). */
  readonly root: string;
  readonly bundleName: string;
  /** Explicit bundle directory; bypasses search-path lookup when set. */
  readonly bundleDir?: string;
  readonly engineName: string;
  readonly engines: Iterable<Engine> | undefined;
}

/**
 * Loads the harness state from disk: harness config + projects from
 * `root`; workflow + agents + skills from a bundle directory resolved
 * via BundleResolver. Memoizes the in-flight load promise so concurrent
 * callers share one read; the cheap runStore() path memoizes config
 * separately to avoid pulling the bundle when only the run store is
 * needed.
 */
export class DefaultHarnessStateLoader {
  readonly root: string;
  readonly bundleName: string;
  private readonly resolver: BundleResolver;
  private readonly engines: EngineRegistry;
  private bundleDirPromise?: Promise<string>;
  private loadingPromise?: Promise<LoadedHarnessState>;
  private configPromise?: ReturnType<HarnessConfigLoader["load"]>;

  constructor(private readonly opts: DefaultHarnessStateLoaderOptions) {
    this.root = opts.root;
    this.bundleName = opts.bundleName;
    // The harness config root doubles as the bundle search-path root —
    // `<root>/bundles/<name>` is the dev-tree convention.
    this.resolver = new BundleResolver({ cwd: opts.root });
    this.engines = new EngineRegistry([new MastraEngine(), ...(opts.engines ?? [])]);
  }

  paths(): HarnessPaths {
    return {
      root: this.opts.root,
      configFile: join(this.opts.root, "ordin.config.yaml"),
      projectsFile: join(this.opts.root, "projects.yaml"),
      projectsLocalFile: join(this.opts.root, "projects.local.yaml"),
    };
  }

  bundleDir(): Promise<string> {
    this.bundleDirPromise ??= this.opts.bundleDir
      ? Promise.resolve(this.opts.bundleDir)
      : this.resolver.resolve(this.opts.bundleName);
    return this.bundleDirPromise;
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
    const bundleDir = await this.bundleDir();
    const [config, bundle, projects] = await Promise.all([
      this.loadConfig(),
      new BundleLoader().load(bundleDir),
      new ProjectRegistryLoader().load(paths.projectsFile, paths.projectsLocalFile),
    ]);
    return {
      config,
      workflow: bundle.workflow,
      agents: bundle.agents,
      projects,
      runStore: new RunStore(config.runStoreDir()),
      engine: this.engines.get(this.opts.engineName),
      runtimeNames: new Set(KNOWN_RUNTIME_NAMES),
      bundle: {
        name: bundle.manifest.name,
        version: bundle.manifest.version,
        hash: bundle.hash.bundle,
        ...(bundle.scriptPath ? { scriptPath: bundle.scriptPath } : {}),
      },
    };
  }

  private loadConfig() {
    this.configPromise ??= new HarnessConfigLoader().load(this.paths().configFile);
    return this.configPromise;
  }
}
