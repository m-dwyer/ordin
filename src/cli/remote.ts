import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import { type GateDecision, OrdinHttpClient, type StartRunRequest } from "../client/http-client";
import { parseTier, slugify } from "./common";

/**
 * `ordin remote ...` — talks to a running `ordin serve` over HTTP. Same
 * task surface as the in-process CLI (`run`, `runs`, …) but routed
 * through `OrdinHttpClient`. Reads `ORDIN_SERVER_URL` and
 * `ORDIN_API_TOKEN` env vars; `--server` / `--token` override.
 *
 * Events stream is rendered as JSON-lines so it composes with `jq`.
 * Pretty-printing is the in-process CLI's job (where clack already
 * lives) — this command targets pipelines and tooling.
 */
export function registerRemote(program: Command): void {
  const remote = program
    .command("remote")
    .description("Drive an `ordin serve` instance over HTTP")
    .option("--server <url>", "Server base URL (overrides ORDIN_SERVER_URL)")
    .option("--token <token>", "Bearer token (overrides ORDIN_API_TOKEN)");

  remote
    .command("start <task...>")
    .description("POST /runs — start a workflow on the remote server")
    .option("-w, --workflow <name>", "Workflow name")
    .option("-p, --project <name>", "Project from server's projects.yaml")
    .option("-r, --repo <path>", "Absolute repo path on the server")
    .option("-t, --tier <tier>", "Task tier (S|M|L)", parseTier, "M" as const)
    .option("-s, --slug <slug>", "Artefact slug (inferred from task if omitted)")
    .option("--from <phase>", "Begin at this phase id")
    .option("--only <phase>", "Run only this phase id")
    .action(async (taskParts: string[], opts: StartOptions, cmd) => {
      const client = makeClient(cmd);
      const input = buildStartRequest(taskParts, opts);
      const { runId } = await client.startRun(input);
      process.stdout.write(`${runId}\n`);
    });

  remote
    .command("preview <task...>")
    .description("POST /preview — composed prompts without running anything")
    .option("-w, --workflow <name>", "Workflow name")
    .option("-p, --project <name>", "Project from server's projects.yaml")
    .option("-r, --repo <path>", "Absolute repo path on the server")
    .option("-t, --tier <tier>", "Task tier (S|M|L)", parseTier, "M" as const)
    .option("-s, --slug <slug>", "Artefact slug (inferred from task if omitted)")
    .action(async (taskParts: string[], opts: StartOptions, cmd) => {
      const client = makeClient(cmd);
      const previews = await client.previewRun(buildStartRequest(taskParts, opts));
      process.stdout.write(`${JSON.stringify(previews, null, 2)}\n`);
    });

  remote
    .command("events <runId>")
    .description("GET /runs/:runId/events — stream RunEvents as JSON lines")
    .action(async (runId: string, _opts, cmd) => {
      const client = makeClient(cmd);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        for await (const event of client.subscribe(runId, controller.signal)) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
          if (event.type === "run.completed") return;
        }
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });

  remote
    .command("decide <runId> <phaseId> <decision> [reason...]")
    .description("POST /runs/:runId/gates/:phaseId/decide — approve|reject")
    .action(
      async (
        runId: string,
        phaseId: string,
        decision: string,
        reasonParts: string[],
        _opts,
        cmd,
      ) => {
        const client = makeClient(cmd);
        const reason = reasonParts.join(" ").trim();
        const payload = parseDecision(decision, reason);
        const { resolved } = await client.resolveGate(runId, phaseId, payload);
        if (!resolved) {
          process.stderr.write(`No pending gate for ${runId}/${phaseId}\n`);
          process.exitCode = 1;
        }
      },
    );

  remote
    .command("list")
    .description("GET /runs — list known runs")
    .action(async (_opts, cmd) => {
      const client = makeClient(cmd);
      const runs = await client.listRuns();
      process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
    });

  remote
    .command("get <runId>")
    .description("GET /runs/:runId — print run metadata")
    .action(async (runId: string, _opts, cmd) => {
      const client = makeClient(cmd);
      const meta = await client.getRun(runId);
      process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
    });

  remote
    .command("gates <runId>")
    .description("GET /runs/:runId/gates — list pending gates")
    .action(async (runId: string, _opts, cmd) => {
      const client = makeClient(cmd);
      const gates = await client.pendingGates(runId);
      process.stdout.write(`${JSON.stringify(gates, null, 2)}\n`);
    });
}

interface RemoteOptions {
  readonly server?: string;
  readonly token?: string;
}

interface StartOptions {
  readonly workflow?: string;
  readonly project?: string;
  readonly repo?: string;
  readonly tier: "S" | "M" | "L";
  readonly slug?: string;
  readonly from?: string;
  readonly only?: string;
}

function makeClient(cmd: Command): OrdinHttpClient {
  const opts = cmd.optsWithGlobals() as RemoteOptions;
  const baseUrl = opts.server ?? process.env["ORDIN_SERVER_URL"] ?? "http://127.0.0.1:8787";
  const token = opts.token ?? process.env["ORDIN_API_TOKEN"];
  return new OrdinHttpClient(token ? { baseUrl, token } : { baseUrl });
}

function buildStartRequest(taskParts: readonly string[], opts: StartOptions): StartRunRequest {
  if (opts.from && opts.only) throw new Error("Use either --only or --from, not both");
  if (!opts.project && !opts.repo) {
    throw new Error(
      "pass --repo <path> or --project <name> (the server has no notion of `this repo`)",
    );
  }
  const task = taskParts.join(" ");
  const slug = opts.slug ?? slugify(task);
  if (!slug) throw new Error("Unable to determine slug; pass --slug");

  return {
    task,
    slug,
    tier: opts.tier,
    ...(opts.project ? { projectName: opts.project } : {}),
    ...(opts.repo ? { repoPath: absolutiseRepo(opts.repo) } : {}),
    ...(opts.from ? { startAt: opts.from } : {}),
    ...(opts.only ? { onlyPhases: [opts.only] } : {}),
  };
}

/**
 * Resolve `--repo` against the client's cwd before sending. If we
 * shipped a relative path, the server would resolve it against *its*
 * working directory — almost certainly the wrong repo.
 */
function absolutiseRepo(value: string): string {
  return isAbsolute(value) ? value : resolvePath(process.cwd(), value);
}

function parseDecision(decision: string, reason: string): GateDecision {
  const normalised = decision.toLowerCase();
  if (normalised === "approve" || normalised === "approved") {
    return reason ? { status: "approved", note: reason } : { status: "approved" };
  }
  if (normalised === "reject" || normalised === "rejected") {
    if (!reason) throw new Error("`reject` requires a reason");
    return { status: "rejected", reason };
  }
  throw new Error(`Unknown decision: ${decision} (expected approve or reject)`);
}
