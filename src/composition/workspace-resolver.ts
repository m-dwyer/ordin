import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DefaultHarnessStateLoader } from "./default-harness-state-loader";

export interface ResolveWorkspaceInput {
  readonly projectName?: string;
  readonly repoPath?: string;
}

/**
 * Resolves a run's target workspace from caller input. Layered on top
 * of the harness state loader so loader stays focused on disk reads:
 * validation rules ("exactly one of projectName | repoPath", "must be
 * a directory") and the project-registry lookup are policy, not
 * infrastructure.
 */
export class WorkspaceResolver {
  constructor(private readonly loader: DefaultHarnessStateLoader) {}

  async resolve(input: ResolveWorkspaceInput): Promise<string> {
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
      : (await this.loader.load()).projects.get(input.projectName ?? "").path;
    await assertWorkspaceDirectory(workspaceRoot);
    return workspaceRoot;
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
