import type { Agent } from "../../domain/agent";
import type { HarnessConfig } from "../../domain/config";
import type { ProjectRegistry } from "../../domain/project";
import type { WorkflowManifest } from "../../domain/workflow";
import type { Engine } from "../../orchestrator/engine";
import type { RunStore } from "../../orchestrator/run-store";

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
  readonly engine: Engine;
  readonly runtimeNames: ReadonlySet<string>;
}

export interface HarnessStateLoader {
  readonly root: string;
  readonly workflowName: string;
  paths(): HarnessPaths;
  load(): Promise<LoadedHarnessState>;
  runStore(): Promise<RunStore>;
}
