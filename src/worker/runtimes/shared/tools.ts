import { spawn } from "node:child_process";
import { glob as fsGlob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Skill } from "../../../domain/skill";

/**
 * Canonical agent tool surface. Pure async executors — no SDK coupling,
 * no closure state beyond the cwd argument. Runtime adapters
 * (AiSdkRuntime, ScriptedRuntime, future Claude Agent SDK runtime)
 * wrap these in their SDK's tool-builder syntax.
 *
 * Why extracted here: parity across runtimes (one source of truth for
 * what an agent's tools mean) and a single hook point for the v3
 * pre-execution pattern scanner (ADR-012).
 */

export interface ToolSpec {
  readonly name: string;
  readonly pattern?: string;
}

/** Parse allowlist entries like `Read`, `Write(docs/rfcs/*)`, `Bash(git diff*)`. */
export function parseToolSpec(spec: string): ToolSpec {
  const match = spec.trim().match(/^([A-Za-z]+)(?:\((.+)\))?$/);
  return match ? { name: match[1] as string, pattern: match[2] } : { name: spec.trim() };
}

export interface ReadInput {
  readonly file_path: string;
}

export interface WriteInput {
  readonly file_path: string;
  readonly content: string;
}

export interface EditInput {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
}

export interface GlobInput {
  readonly pattern: string;
}

export interface GrepInput {
  readonly pattern: string;
  readonly path?: string;
}

export interface BashInput {
  readonly command: string;
}

export interface SkillInput {
  readonly name: string;
}

export async function executeRead(cwd: string, input: ReadInput): Promise<string> {
  return readFile(abs(cwd, input.file_path), "utf8");
}

export async function executeWrite(cwd: string, input: WriteInput): Promise<string> {
  const p = abs(cwd, input.file_path);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, input.content, "utf8");
  return `Wrote ${input.content.length} bytes to ${input.file_path}`;
}

export async function executeEdit(cwd: string, input: EditInput): Promise<string> {
  const p = abs(cwd, input.file_path);
  const original = await readFile(p, "utf8");
  const count = original.split(input.old_string).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${input.file_path}`);
  if (count > 1) throw new Error(`old_string appears ${count}× in ${input.file_path}`);
  await writeFile(p, original.replace(input.old_string, input.new_string), "utf8");
  return `Edited ${input.file_path}`;
}

export async function executeGlob(cwd: string, input: GlobInput): Promise<string> {
  const matches: string[] = [];
  for await (const entry of fsGlob(input.pattern, { cwd })) {
    matches.push(typeof entry === "string" ? entry : relative(cwd, String(entry)));
    if (matches.length >= 200) break;
  }
  return matches.length > 0 ? matches.join("\n") : "(no matches)";
}

export async function executeGrep(cwd: string, input: GrepInput): Promise<string> {
  const regex = new RegExp(input.pattern);
  const scope = input.path && input.path.length > 0 ? input.path : "**/*";
  const hits: string[] = [];
  outer: for await (const entry of fsGlob(scope, { cwd })) {
    const rel = typeof entry === "string" ? entry : relative(cwd, String(entry));
    let content: string;
    try {
      content = await readFile(abs(cwd, rel), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i] ?? "")) {
        hits.push(`${rel}:${i + 1}: ${lines[i]}`);
        if (hits.length >= 200) break outer;
      }
    }
  }
  return hits.length > 0 ? hits.join("\n") : "(no matches)";
}

export async function executeBash(cwd: string, input: BashInput): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", ["-c", input.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: bashToolEnv(process.env),
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout?.on("data", (b: Buffer) => out.push(b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => err.push(b.toString("utf8")));
    child.on("close", (code) => {
      const stdout = out.join("");
      const stderr = err.join("");
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        const msg = [stdout, stderr].filter(Boolean).join("\n");
        reject(new Error(`${msg}\n(exit ${code ?? "?"})`.trim()));
      }
    });
  });
}

function bashToolEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  delete env["BASH_ENV"];
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  return env;
}

/**
 * Skill execution is special: the input names a skill from the per-
 * phase skills list. Returns the skill body as a string. Caller is
 * responsible for binding the available skills.
 */
export async function executeSkill(skills: readonly Skill[], input: SkillInput): Promise<string> {
  const skill = skills.find((s) => s.name === input.name);
  if (!skill) {
    const known = skills.map((s) => s.name).join(", ");
    throw new Error(
      `Unknown skill "${input.name}". Available: ${known || "(none for this phase)"}.`,
    );
  }
  return skill.body;
}

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}
