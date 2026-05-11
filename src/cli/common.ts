import { InvalidArgumentError } from "commander";
import {
  type Gate,
  Harness,
  type Phase,
  type RunEvent,
  type RunMeta,
  type SandboxMode,
} from "../composition/harness";
import type { RunHeader } from "./tui/types";

export function parseTier(value: string): "S" | "M" | "L" {
  if (value === "S" || value === "M" || value === "L") return value;
  throw new InvalidArgumentError("Tier must be S, M, or L");
}

export function parseSandboxMode(value: string): SandboxMode {
  if (value === "passthrough" || value === "broker" || value === "srt") return value;
  throw new InvalidArgumentError("Sandbox mode must be passthrough, broker, or srt");
}

export interface OrdinCliOptions {
  readonly bundle?: string;
  readonly bundleDir?: string;
  readonly sandboxMode?: SandboxMode;
  readonly scriptPath?: string;
}

/**
 * Build a Harness for the read-only CLI commands (`runs`,
 * `retro`, `status`, `doctor`, `serve`, `mcp`, `remote`). These don't
 * trigger phase execution locally, so they don't need a gate prompter
 * — the runtime's default `AutoGate` is safe.
 *
 * `ordin run` doesn't use this; it constructs an `OrdinRunSession`
 * which wires the OpenTUI gate prompter (or the non-TTY fallback)
 * around the runtime.
 */
export function ordin(opts: OrdinCliOptions = {}): Harness {
  return new Harness({
    bundle: opts.bundle ?? "software-delivery",
    ...(opts.bundleDir ? { bundleDir: opts.bundleDir } : {}),
    ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
    ...(opts.scriptPath ? { scriptPath: opts.scriptPath } : {}),
  });
}

export interface OrdinRunSession {
  readonly runtime: Harness;
  readonly onEvent: (event: RunEvent) => void;
  readonly gateForKind: (kind: Phase["gate"]) => Gate;
  readonly finish: (summary: { runId: string; status: RunMeta["status"] }) => void;
  readonly dispose: () => Promise<void> | void;
}

/**
 * Build a session for `ordin run`. Branches on TTY availability:
 *
 *   - **TTY**: mount the OpenTUI footer controller. Gate prompts
 *     surface in the footer panel and resolve via keypress; phase
 *     progress and agent output stream into real terminal scrollback
 *     above.
 *
 *   - **non-TTY** (CI logs, `| tee`, redirected stdout, ssh w/o -t):
 *     plain stdout line-writer, no footer. Gates can't be answered
 *     without a keyboard, so the prompter throws with a message
 *     pointing at HTTP + `ordin remote decide` for headless flows.
 *
 * Dynamic imports for both paths keep the OpenTUI native bits
 * (Zig-backed renderer, tree-sitter assets) out of cold paths —
 * `ordin --help`, `ordin doctor`, the test suite, `ordin serve` all
 * load `common.ts` but never trigger the renderer load.
 */
export async function ordinRunSession(opts: {
  readonly bundle: string;
  readonly bundleDir?: string;
  readonly sandboxMode?: SandboxMode;
  readonly scriptPath?: string;
  readonly header: RunHeader;
}): Promise<OrdinRunSession> {
  const sharedOpts = {
    bundle: opts.bundle,
    ...(opts.bundleDir ? { bundleDir: opts.bundleDir } : {}),
    ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
    ...(opts.scriptPath ? { scriptPath: opts.scriptPath } : {}),
  };

  if (process.stdout.isTTY !== true) {
    const { nonTtyRunSession } = await import("./tui/non-tty-sink");
    const session = nonTtyRunSession();
    return {
      runtime: new Harness(sharedOpts),
      onEvent: session.onEvent,
      gateForKind: session.gateForKind,
      finish: () => session.finish(),
      dispose: () => session.finish(),
    };
  }

  // Tee stderr to ~/.ordin/logs/latest.log BEFORE anything that might
  // write to it: tree-sitter worker errors, runtime telemetry, etc.
  // The TUI's alt-screen masks live stderr, so capturing to disk is
  // the only way to surface failures after the run ends.
  const { installStderrTee, stripAnsi } = await import("./run-log");
  const stderrTee = installStderrTee();

  // Under L2, the parent owns the TUI for the entire run. Mounting it
  // up-front (before the runtime ever spawns a worker) means there's no
  // alt-screen race with sandboxed children — the inner is just a
  // worker process whose stdout/stderr the parent captures.
  const { OpenTuiRunController } = await import("./tui/controller");
  const { openTuiEgressGatePrompter, openTuiGateResolver } = await import(
    "./gate-prompters/opentui"
  );
  const controller = new OpenTuiRunController();
  const runtime = new Harness({
    ...sharedOpts,
    egressGatePrompter: openTuiEgressGatePrompter(controller),
  });
  // Pre-populate the footer's phase list so all phases show up as
  // `pending` from the first frame, instead of appearing one-by-one
  // as `phase.started` events arrive. workflowDefinition() just loads
  // the YAML — cheap, no composition.
  const manifest = await runtime.workflowDefinition();
  // Validate run-time infra (broker, audit, sandbox selection, env-var
  // auth for local_services) BEFORE the renderer mounts. If any of
  // that throws after the TUI has issued its OSC terminal-capability
  // probes, the terminal's async responses leak onto the user's shell
  // when ordin exits. Preflight surfaces those errors as plain stderr.
  await runtime.preflight();
  await controller.mount(
    opts.header,
    manifest.phases.map((p) => p.id),
  );
  return {
    runtime,
    onEvent: (ev) => controller.pushEvent(ev),
    gateForKind: openTuiGateResolver(controller),
    finish: (summary) => controller.finish(summary),
    dispose: async () => {
      await controller.dispose();
      // Final summary lands AFTER renderer teardown, on plain stdout —
      // sidesteps OpenTUI's destroy-time scrollback re-flush.
      controller.printFinalSummary();
      // Surface any stderr captured during the run (tree-sitter,
      // runtime warnings, etc.). The TUI swallowed them while mounted;
      // this is the only place the user reliably sees them. Trim heavy
      // ANSI to keep the printout readable.
      const captured = stderrTee.readSnapshot().trim();
      if (captured.length > 0) {
        process.stdout.write(`\n  stderr captured at ${stderrTee.path}:\n`);
        const lines = captured.split("\n");
        const tail = lines.slice(-30);
        for (const line of tail) {
          process.stdout.write(`    ${stripAnsi(line)}\n`);
        }
        if (lines.length > tail.length) {
          process.stdout.write(`    … (${lines.length - tail.length} earlier lines)\n`);
        }
      }
      await stderrTee.close();
    },
  };
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
