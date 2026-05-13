import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type VerifyResult, verifyChainText } from "../broker/audit-chain";
import type { RunMeta } from "../orchestrator/run-store";
import type { DefaultHarnessStateLoader } from "./default-harness-state-loader";

export class ListRunsUseCase {
  constructor(private readonly loader: DefaultHarnessStateLoader) {}

  async execute(): Promise<RunMeta[]> {
    const runStore = await this.loader.runStore();
    return runStore.listRuns();
  }
}

export class GetRunUseCase {
  constructor(private readonly loader: DefaultHarnessStateLoader) {}

  async execute(runId: string): Promise<RunMeta> {
    const runStore = await this.loader.runStore();
    return runStore.readMeta(runId);
  }
}

export class VerifyAuditUseCase {
  constructor(private readonly loader: DefaultHarnessStateLoader) {}

  async execute(runId: string): Promise<VerifyResult> {
    const runStore = await this.loader.runStore();
    const path = join(runStore.runDir(runId), "audit.jsonl");
    const text = await readFile(path, "utf8");
    return verifyChainText(text);
  }
}
