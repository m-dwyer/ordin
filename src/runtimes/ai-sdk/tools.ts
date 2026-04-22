import { spawn } from "node:child_process";
import { glob as fsGlob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type ToolSet, tool } from "ai";
import { z } from "zod";

/**
 * Tool definitions for AiSdkRuntime. Each tool is a zod schema + async
 * execute handler. The AI SDK owns dispatch, retry, abort, and event
 * emission — this file is just the app-domain tool surface.
 *
 * Parity matters: this set mirrors what ClaudeCliRuntime exposes to
 * agents, so eval signal reflects prompt behaviour, not tool-surface
 * divergence.
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

/** Build the AI SDK tool map filtered by the phase's allowlist. */
export function buildTools(cwd: string, specs: readonly string[]): ToolSet {
  const allowed = new Set(specs.map((s) => parseToolSpec(s).name));
  const all = allTools(cwd);
  const out: ToolSet = {};
  for (const name of allowed) {
    const t = all[name];
    if (t) out[name] = t;
  }
  return out;
}

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function allTools(cwd: string): ToolSet {
  return {
    Read: tool({
      inputSchema: z.object({
        file_path: z.string().describe("Path, relative to CWD or absolute."),
      }),
      execute: async ({ file_path }) => readFile(abs(cwd, file_path), "utf8"),
    }),

    Write: tool({
      inputSchema: z.object({
        file_path: z.string().describe("Target path; parent dirs are created."),
        content: z.string().describe("Full new file contents (overwrites)."),
      }),
      execute: async ({ file_path, content }) => {
        const p = abs(cwd, file_path);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, content, "utf8");
        return `Wrote ${content.length} bytes to ${file_path}`;
      },
    }),

    Edit: tool({
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string().describe("Exact string to replace; must be unique in the file."),
        new_string: z.string(),
      }),
      execute: async ({ file_path, old_string, new_string }) => {
        const p = abs(cwd, file_path);
        const original = await readFile(p, "utf8");
        const count = original.split(old_string).length - 1;
        if (count === 0) throw new Error(`old_string not found in ${file_path}`);
        if (count > 1) throw new Error(`old_string appears ${count}× in ${file_path}`);
        await writeFile(p, original.replace(old_string, new_string), "utf8");
        return `Edited ${file_path}`;
      },
    }),

    Glob: tool({
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'. Max 200 results."),
      }),
      execute: async ({ pattern }) => {
        const matches: string[] = [];
        for await (const entry of fsGlob(pattern, { cwd })) {
          matches.push(typeof entry === "string" ? entry : relative(cwd, String(entry)));
          if (matches.length >= 200) break;
        }
        return matches.length > 0 ? matches.join("\n") : "(no matches)";
      },
    }),

    Grep: tool({
      inputSchema: z.object({
        pattern: z.string().describe("JavaScript regex."),
        path: z.string().optional().describe("Optional glob to scope search (default '**/*')."),
      }),
      execute: async ({ pattern, path }) => {
        const regex = new RegExp(pattern);
        const scope = path && path.length > 0 ? path : "**/*";
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
      },
    }),

    Bash: tool({
      inputSchema: z.object({
        command: z.string().describe("Shell command run in CWD via `bash -lc`."),
      }),
      execute: async ({ command }) => runBash(cwd, command),
    }),
  };
}

function runBash(cwd: string, command: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
