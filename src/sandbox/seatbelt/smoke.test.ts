import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderProfile } from "./profile";

/**
 * End-to-end smoke tests that spawn real `sandbox-exec` invocations.
 * Validates that:
 *   1. The rendered profile is syntactically valid (sandbox-exec accepts it).
 *   2. The deny rules actually deny when probed.
 *   3. The allow rules actually allow when probed.
 *
 * Gated to darwin + sandbox-exec presence so the suite still passes on
 * Linux CI without skipping silently. Phase 6 expands this into a
 * structured probe table; Phase 5 is just "does the wiring work."
 */

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const isDarwinWithSandbox = process.platform === "darwin" && existsSync(SANDBOX_EXEC);

describe.runIf(isDarwinWithSandbox)("SeatbeltSandbox smoke", () => {
  // Smoke tests mirror production: the profile's tempDir is the actual
  // system tmpdir, since Bun (and any other tool) uses os.tmpdir()
  // internally for scratch space. We carve our smoke-test workspace /
  // run-store / harness-root scratch dirs *underneath* tmpdir.
  const scratch = mkdtempSync(join(tmpdir(), "ordin-sandbox-smoke-"));
  const workspaceRoot = join(scratch, "workspace");
  const runStoreDir = join(scratch, "runs");
  const harnessRoot = join(scratch, "harness");
  mkdirSync(workspaceRoot);
  mkdirSync(runStoreDir);
  mkdirSync(harnessRoot);

  const profile = renderProfile({
    workspaceRoot,
    runStoreDir,
    harnessRoot,
    tempDir: tmpdir(),
    homeDir: homedir(),
  });

  function runSandboxed(code: string): { status: number | null; stderr: string } {
    // Run bun with cwd inside the workspace so its cwd-discovery and
    // upward package.json scan stays within allowed paths — same shape
    // as a production `ordin run`.
    const result = spawnSync(SANDBOX_EXEC, ["-p", profile, "bun", "-e", code], {
      encoding: "utf-8",
      timeout: 10_000,
      cwd: workspaceRoot,
    });
    return {
      status: result.status,
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  }

  it("accepts the rendered profile and runs a trivial exit-0 program", () => {
    const result = runSandboxed("process.exit(0)");
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });

  it("allows writes to the workspace root", () => {
    const target = join(workspaceRoot, "smoke-allowed.txt");
    const result = runSandboxed(
      `require("node:fs").writeFileSync(${JSON.stringify(target)}, "ok"); process.exit(0)`,
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });

  it("allows writes to the run store dir", () => {
    const target = join(runStoreDir, "smoke-runstore.txt");
    const result = runSandboxed(
      `require("node:fs").writeFileSync(${JSON.stringify(target)}, "ok"); process.exit(0)`,
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });

  it("denies writes outside the workspace, run store, and temp dir", () => {
    // Pick a path that's clearly outside any allowed write zone but
    // inside an allowed-read zone (so the dirname lookup itself works).
    const target = join(homedir(), "ordin-sandbox-smoke-DENIED.txt");
    const result = runSandboxed(
      `try { require("node:fs").writeFileSync(${JSON.stringify(target)}, "x"); process.exit(0) } catch (e) { process.exit(2) }`,
    );
    expect(result.status, `stderr: ${result.stderr}`).not.toBe(0);
  });

  it("denies reads of ~/.ssh (defense-in-depth)", () => {
    const target = join(homedir(), ".ssh");
    const result = runSandboxed(
      `try { require("node:fs").readdirSync(${JSON.stringify(target)}); process.exit(0) } catch (e) { process.exit(2) }`,
    );
    expect(result.status, `stderr: ${result.stderr}`).not.toBe(0);
  });

  it("denies reads of ~/.aws (defense-in-depth)", () => {
    const target = join(homedir(), ".aws");
    const result = runSandboxed(
      `try { require("node:fs").readdirSync(${JSON.stringify(target)}); process.exit(0) } catch (e) { process.exit(2) }`,
    );
    expect(result.status, `stderr: ${result.stderr}`).not.toBe(0);
  });
});
