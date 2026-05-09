import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type VerifyResult, verifyChainText } from "../broker/audit-chain";
import type { RunMeta } from "../orchestrator/run-store";
import type { HarnessContext } from "./harness-context";

export class ListRunsUseCase {
  constructor(private readonly context: HarnessContext) {}

  async execute(): Promise<RunMeta[]> {
    const { runStore } = await this.context.load();
    return runStore.listRuns();
  }
}

export class GetRunUseCase {
  constructor(private readonly context: HarnessContext) {}

  async execute(runId: string): Promise<RunMeta> {
    const { runStore } = await this.context.load();
    return runStore.readMeta(runId);
  }
}

export class VerifyAuditUseCase {
  constructor(private readonly context: HarnessContext) {}

  async execute(runId: string): Promise<VerifyResult> {
    const { runStore } = await this.context.load();
    const path = join(runStore.runDir(runId), "audit.jsonl");
    const text = await readFile(path, "utf8");
    return verifyChainText(text);
  }
}
