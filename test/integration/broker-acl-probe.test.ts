import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Harness } from "../../src/composition/harness";
import { AutoGate } from "../../src/gates/dispatch";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("broker ACL e2e", () => {
  it("chains allow + deny envelopes when a phase calls a tool outside its allowed_tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ordin-broker-acl-"));
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "README.md"), "# fixture\n", "utf8");

    const harness = new Harness({
      root: repoRoot,
      bundle: "broker-acl-probe",
      sandboxMode: "passthrough",
    });

    let runId: string | undefined;
    try {
      const meta = await harness.startRun({
        task: "broker acl probe",
        slug: "broker-acl-probe",
        repoPath: workspace,
        tier: "S",
        gateForKind: () => new AutoGate(),
      });
      runId = meta.runId;

      expect(meta.status).toBe("failed");

      const auditPath = join(homedir(), ".ordin", "runs", runId, "audit.jsonl");
      const envelopes = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });

      const brokerTool = envelopes.filter((e) => e.kind.startsWith("broker.tool."));
      expect(brokerTool).toMatchObject([
        { kind: "broker.tool.dispatch", payload: { tool: "Read", decision: "allow" } },
        { kind: "broker.tool.result", payload: { tool: "Read", ok: true } },
        {
          kind: "broker.tool.dispatch",
          payload: { tool: "Edit", decision: "deny", errorKind: "denied" },
        },
        {
          kind: "broker.tool.result",
          payload: { tool: "Edit", ok: false, errorKind: "denied" },
        },
      ]);

      const verify = await harness.verifyAudit(runId);
      expect(verify.ok).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      if (runId) {
        await rm(join(homedir(), ".ordin", "runs", runId), {
          recursive: true,
          force: true,
        });
      }
    }
  });
});
