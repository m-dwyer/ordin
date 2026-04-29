import { InvalidArgumentError } from "commander";
import {
  HarnessRuntime,
  type RunEvent,
  type RunMeta,
  type SandboxMode,
  type StartRunInput,
} from "../runtime/harness";
import type { RunHeader } from "./tui/types";

export function parseTier(value: string): "S" | "M" | "L" {
  if (value === "S" || value === "M" || value === "L") return value;
  throw new InvalidArgumentError("Tier must be S, M, or L");
}

export function parseSandboxMode(value: string): SandboxMode {
  if (value === "passthrough" || value === "srt") return value;
  throw new InvalidArgumentError("Sandbox mode must be passthrough or srt");
}

export interface OrdinCliOptions {
  readonly workflow?: string;
  readonly sandboxMode?: SandboxMode;
  readonly scriptPath?: string;
}

/**
 * Build a HarnessRuntime for the read-only CLI commands (`runs`,
 * `retro`, `status`, `doctor`, `serve`, `mcp`, `remote`). These don't
 * trigger phase execution locally, so they don't need a gate prompter
 * — the runtime's default `AutoGate` is safe.
 *
 * `ordin run` doesn't use this; it constructs an `OrdinRunSession`
 * which wires the OpenTUI gate prompter (or the non-TTY fallback)
 * around the runtime.
 */
export function ordin(opts: OrdinCliOptions = {}): HarnessRuntime {
  return new HarnessRuntime({
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
    ...(opts.scriptPath ? { scriptPath: opts.scriptPath } : {}),
  });
}

export interface OrdinRunSession {
  readonly runtime: HarnessRuntime;
  readonly onEvent: (event: RunEvent) => void;
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
  readonly workflow?: string;
  readonly sandboxMode?: SandboxMode;
  readonly scriptPath?: string;
  /**
   * Run input — passed through so we can call `prepareSandbox` BEFORE
   * any TUI work. Under `srt`, the outer process spawns a sandboxed
   * child and waits for it; if the renderer has already initialised
   * raw-mode / mouse tracking / alt-screen, those sequences would
   * pollute the terminal that the inner process now owns.
   */
  readonly runInput?: StartRunInput;
  readonly header: RunHeader;
}): Promise<OrdinRunSession> {
  if (process.stdout.isTTY === true) {
    const runtime = new HarnessRuntime({
      ...(opts.workflow ? { workflow: opts.workflow } : {}),
      ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
      ...(opts.scriptPath ? { scriptPath: opts.scriptPath } : {}),
      // gateForKind set after sandbox prepare — we need the controller
      // first, but the controller mount must happen post-reexec.
    });
    if (opts.runInput) await runtime.prepareSandbox(opts.runInput);
    // Past this line we're either passthrough or post-reexec. Safe to
    // touch the terminal.
    const { OpenTuiRunController } = await import("./tui/controller");
    const { openTuiGateResolver } = await import("./gate-prompters/opentui");
    const controller = new OpenTuiRunController();
    const runtimeWithGates = new HarnessRuntime({
      ...(opts.workflow ? { workflow: opts.workflow } : {}),
      ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
      ...(opts.scriptPath ? { scriptPath: opts.scriptPath } : {}),
      gateForKind: openTuiGateResolver(controller),
    });
    // Pre-populate the footer's phase list so all phases show up as
    // `pending` from the first frame, instead of appearing one-by-one
    // as `phase.started` events arrive. workflowDefinition() just
    // loads the YAML — cheap, no composition.
    const manifest = await runtimeWithGates.workflowDefinition();
    await controller.mount(
      opts.header,
      manifest.phases.map((p) => p.id),
    );
    return {
      runtime: runtimeWithGates,
      onEvent: (ev) => controller.pushEvent(ev),
      finish: (summary) => controller.finish(summary),
      dispose: async () => {
        await controller.dispose();
        // Final summary lands AFTER renderer teardown, on plain
        // stdout — sidesteps OpenTUI's destroy-time scrollback
        // re-flush that was causing the block to print twice.
        controller.printFinalSummary();
      },
    };
  }

  const baseRuntime = new HarnessRuntime({
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
    ...(opts.scriptPath ? { scriptPath: opts.scriptPath } : {}),
  });
  if (opts.runInput) await baseRuntime.prepareSandbox(opts.runInput);
  const { nonTtyRunSession } = await import("./tui/non-tty-sink");
  const session = nonTtyRunSession();
  return {
    runtime: new HarnessRuntime({
      ...(opts.workflow ? { workflow: opts.workflow } : {}),
      ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
      ...(opts.scriptPath ? { scriptPath: opts.scriptPath } : {}),
      gateForKind: session.gateForKind,
    }),
    onEvent: session.onEvent,
    finish: () => session.finish(),
    dispose: () => session.finish(),
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
