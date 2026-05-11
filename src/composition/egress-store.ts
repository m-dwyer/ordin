import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/**
 * Per-project store for egress approvals (ADR-013 — "approve once,
 * enforce always"). The first time a phase tries to reach a host
 * outside the static `local_services` map, the broker prompts the
 * user; the answer persists here so subsequent runs of the same
 * project don't re-prompt.
 *
 * Layout:
 *   ~/.ordin/projects/<project>/egress.yaml
 *
 * Project key is the workspace-root basename. Two workspaces with the
 * same basename in different directories share approvals — fine for
 * the dev-loop use case and arguably correct (the project identity
 * comes from the repo, not its filesystem path). Multi-tenant
 * deployments would route through `projectName` from the registry.
 *
 * File shape:
 *   hosts:
 *     - api.anthropic.com:443
 *     - registry.npmjs.org:443
 *
 * Manually editable; missing file means "no approvals yet".
 */

const EgressFileSchema = z.object({
  hosts: z.array(z.string()).default([]),
});

export interface EgressApproval {
  readonly host: string;
  readonly port: number | undefined;
}

export class EgressApprovalStore {
  private readonly path: string;

  constructor(opts: { ordinDir: string; projectKey: string }) {
    this.path = join(opts.ordinDir, "projects", opts.projectKey, "egress.yaml");
  }

  static projectKeyForWorkspace(workspaceRoot: string, projectName?: string): string {
    return projectName ?? basename(workspaceRoot);
  }

  async load(): Promise<readonly EgressApproval[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const parsed = EgressFileSchema.safeParse(parseYaml(raw) ?? {});
    if (!parsed.success) {
      throw new Error(
        `Invalid ${this.path}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data.hosts.map(parseHostPort);
  }

  async add(host: string, port: number | undefined): Promise<void> {
    const existing = await this.load();
    const key = serializeHostPort(host, port);
    if (existing.some((a) => serializeHostPort(a.host, a.port) === key)) return;
    const next = [...existing.map((a) => serializeHostPort(a.host, a.port)), key].sort();
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeFile(this.path, stringifyYaml({ hosts: next }), "utf8");
  }
}

function serializeHostPort(host: string, port: number | undefined): string {
  return port === undefined ? host : `${host}:${port}`;
}

function parseHostPort(entry: string): EgressApproval {
  const idx = entry.lastIndexOf(":");
  if (idx < 0) return { host: entry, port: undefined };
  const portStr = entry.slice(idx + 1);
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port)) return { host: entry, port: undefined };
  return { host: entry.slice(0, idx), port };
}
