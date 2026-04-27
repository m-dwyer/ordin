import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { resolveClaudeBin } from "../runtime/harness";
import { ordin } from "./common";
import { printStatusLine } from "./tui/print";

/**
 * Run the resolved `claude` binary with stdin explicitly closed. Goes
 * through `resolveClaudeBin` so doctor probes the same binary the
 * runtime would actually launch — `CLAUDE_BIN` env or PATH lookup.
 * Stdin is `'ignore'` because parallel claude children sharing a
 * parent's open pipe can wedge instead of exiting cleanly.
 */
function runClaude(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveClaudeBin(), [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`claude ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}

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
        printStatusLine(ok, label, detail);
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
  const requested = resolveClaudeBin();
  // Bun.which uses bun's PATH — the same lookup `spawn(bin)` does.
  // Surfacing the resolved absolute path makes mise/asdf shim mismatches
  // (bun finds /usr/local/bin/claude while shell finds ~/.mise/.../claude)
  // visible in one line instead of needing a separate diagnostic session.
  const resolvedPath = requested.startsWith("/") ? requested : (Bun.which(requested) ?? requested);
  try {
    const { stdout } = await runClaude(["--version"]);
    const version = stdout.trim().split("\n")[0] ?? "";
    const source = process.env["CLAUDE_BIN"] ? " (via CLAUDE_BIN)" : "";
    return {
      label: "claude binary",
      ok: true,
      detail: `${version} · ${resolvedPath}${source}`,
    };
  } catch (err) {
    return {
      label: "claude binary",
      ok: false,
      detail: `cannot run ${resolvedPath} (${(err as Error).message})`,
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
  // Don't shell out to `claude plugin validate` here — older claude
  // builds don't have the subcommand and treat it as a one-shot prompt,
  // and resolving `claude` via spawn can land on a different binary
  // than the shell's PATH (mise/asdf shims). Reading + parsing the
  // manifest directly is faster, deterministic, and catches the only
  // failure modes that matter at doctor time: missing file, invalid
  // JSON, missing required `name` field.
  const manifestPath = join(ordin().paths().root, ".claude-plugin", "plugin.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name !== "string" || parsed.name.length === 0) {
      return {
        label: "plugin manifest",
        ok: false,
        detail: `${manifestPath} missing required "name" field`,
      };
    }
    return { label: "plugin manifest", ok: true, detail: parsed.name };
  } catch (err) {
    return {
      label: "plugin manifest",
      ok: false,
      detail:
        err instanceof SyntaxError
          ? `${manifestPath} is not valid JSON`
          : `cannot read ${manifestPath}: ${(err as Error).message}`,
    };
  }
}
