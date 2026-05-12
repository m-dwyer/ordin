import type { Agent } from "../../domain/agent";
import type { HarnessConfig } from "../../domain/config";
import type { ProjectRegistry } from "../../domain/project";
import type { WorkflowManifest } from "../../domain/workflow";
import type { Engine } from "../../orchestrator/engine";
import type { RunStore } from "../../orchestrator/run-store";

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

export interface HarnessStateLoader {
  readonly root: string;
  readonly bundleName: string;
  paths(): HarnessPaths;
  /** Resolved bundle directory (search-path lookup; throws if not found). */
  bundleDir(): Promise<string>;
  load(): Promise<LoadedHarnessState>;
  runStore(): Promise<RunStore>;
}
