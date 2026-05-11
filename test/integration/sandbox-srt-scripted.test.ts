import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Harness } from "../../src/composition/harness";
import { AutoGate } from "../../src/gates/dispatch";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hasSrt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

describe.skipIf(!hasSrt)("srt sandbox scripted e2e", () => {
  it("runs the deterministic sandbox validation workflow and verifies audit", async () => {
    const workspace = await makeWorkspace();
    const restoreEnv = withParentSecrets();
    try {
      process.env["ORDIN_WORKER_ARGV"] = JSON.stringify([
        findOnPath("bun"),
        join(repoRoot, "src", "worker", "entry.ts"),
      ]);
      const harness = new Harness({
        root: repoRoot,
        workflow: "sandbox-validation",
        sandboxMode: "srt",
      });

      const meta = await harness.startRun({
        task: "validate sandbox boundary",
        slug: "sandbox-e2e",
        repoPath: workspace,
        tier: "S",
        gateForKind: () => new AutoGate(),
      });

      expect(meta.status).toBe("completed");
      expect(meta.phases).toHaveLength(1);
      expect(meta.phases[0]?.status).toBe("completed");

      const report = await readFile(
        join(workspace, "reviews", "sandbox-validation-report.md"),
        "utf8",
      );
      expect(report).toContain("env secret check");
      expect(report).toContain("All six probes succeeded");

      const marker = await readFile(join(workspace, ".sandbox-validation-marker"), "utf8");
      expect(marker).toContain("shell write OK");

      const audit = await harness.verifyAudit(meta.runId);
      expect(audit.ok).toBe(true);
      expect(audit.entries).toBeGreaterThan(0);
    } finally {
      restoreEnv();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});

function withParentSecrets(): () => void {
  const keys = [
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LITELLM_MASTER_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "ORDIN_WORKER_ARGV",
  ] as const;
  const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  process.env["LANGFUSE_PUBLIC_KEY"] = "env-test-pk";
  process.env["LANGFUSE_SECRET_KEY"] = "env-test-sk";
  process.env["LITELLM_MASTER_KEY"] = "env-test-litellm";
  process.env["ANTHROPIC_API_KEY"] = "env-test-anthropic";
  process.env["OPENAI_API_KEY"] = "env-test-openai";
  process.env["GITHUB_TOKEN"] = "env-test-github";
  process.env["AWS_SECRET_ACCESS_KEY"] = "env-test-aws";
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function findOnPath(bin: string): string {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find ${bin} on PATH`);
}

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "ordin-srt-e2e-workspace-"));
  await write(
    join(workspace, "README.md"),
    "# sandbox fixture\n\nThis workspace exists for the srt scripted e2e test.\n",
  );
  await write(join(workspace, "package.json"), '{"name":"sandbox-fixture","private":true}\n');
  return workspace;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
