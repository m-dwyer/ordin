import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { Command } from "commander";
import { ordin } from "./common";

const execFileAsync = promisify(execFile);

/**
 * Health check — catches the common Stage 1 failure modes before a run:
 *   • Bun version
 *   • `claude` binary present and invokable
 *   • Harness config files readable (plus .claude-plugin/plugin.json valid)
 *
 * Nothing is installed globally; skills discover per-run via --plugin-dir.
 * If a check here fails, no run can succeed.
 */
export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check environment: Bun, claude binary, ordin files, plugin manifest")
    .action(async () => {
      const checks: Promise<DoctorResult>[] = [
        checkBun(),
        checkClaudeBinary(),
        checkOrdinFiles(),
        checkPluginManifest(),
      ];
      const results = await Promise.all(checks);
      let failures = 0;
      for (const { label, ok, detail } of results) {
        const status = ok ? "✓" : "✗";
        process.stdout.write(`${status}  ${label}${detail ? `  — ${detail}` : ""}\n`);
        if (!ok) failures += 1;
      }
      if (failures > 0) process.exitCode = 1;
    });
}

interface DoctorResult {
  label: string;
  ok: boolean;
  detail?: string;
}

async function checkBun(): Promise<DoctorResult> {
  const version = process.versions["bun"];
  if (!version) {
    return {
      label: "Bun >=1.3",
      ok: false,
      detail: "not running under Bun (use `bun src/cli/index.ts` or `bin/ordin`)",
    };
  }
  const [majorStr = "0", minorStr = "0"] = version.split(".");
  const major = Number.parseInt(majorStr, 10);
  const minor = Number.parseInt(minorStr, 10);
  const ok = major > 1 || (major === 1 && minor >= 3);
  return ok
    ? { label: "Bun >=1.3", ok: true, detail: `v${version}` }
    : { label: "Bun >=1.3", ok: false, detail: `v${version} (upgrade required)` };
}

async function checkClaudeBinary(): Promise<DoctorResult> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"]);
    return { label: "claude binary", ok: true, detail: stdout.trim().split("\n")[0] };
  } catch (err) {
    return {
      label: "claude binary",
      ok: false,
      detail: `not found on PATH (${(err as Error).message})`,
    };
  }
}

async function checkOrdinFiles(): Promise<DoctorResult> {
  const paths = ordin().paths();
  for (const p of [paths.configFile, paths.workflowFile, paths.agentsDir, paths.skillsDir]) {
    try {
      await stat(p);
    } catch {
      return { label: "ordin files", ok: false, detail: `missing: ${p}` };
    }
  }
  return { label: "ordin files", ok: true };
}

async function checkPluginManifest(): Promise<DoctorResult> {
  const root = ordin().paths().root;
  try {
    const { stdout } = await execFileAsync("claude", ["plugin", "validate", root]);
    const summary = stdout.trim().split("\n").slice(-1)[0] ?? "";
    return { label: "plugin manifest", ok: true, detail: summary.replace(/^[✔✓]\s*/, "") };
  } catch (err) {
    return {
      label: "plugin manifest",
      ok: false,
      detail: (err as Error).message.split("\n")[0],
    };
  }
}
