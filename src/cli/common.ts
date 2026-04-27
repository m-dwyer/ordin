import { InvalidArgumentError } from "commander";
import { HarnessRuntime, type RunEvent, type RunMeta } from "../runtime/harness";
import type { RunHeader } from "./tui/types";

export function parseTier(value: string): "S" | "M" | "L" {
  if (value === "S" || value === "M" || value === "L") return value;
  throw new InvalidArgumentError("Tier must be S, M, or L");
}

export interface OrdinCliOptions {
  readonly workflow?: string;
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
  });
}

export interface OrdinRunSession {
  readonly runtime: HarnessRuntime;
  readonly onEvent: (event: RunEvent) => void;
  readonly finish: (summary: { runId: string; status: RunMeta["status"] }) => void;
  readonly dispose: () => void;
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
  readonly header: RunHeader;
}): Promise<OrdinRunSession> {
  if (process.stdout.isTTY === true) {
    const { OpenTuiRunController } = await import("./tui/controller");
    const { openTuiGateResolver } = await import("./gate-prompters/opentui");
    const controller = new OpenTuiRunController();
    const runtime = new HarnessRuntime({
      ...(opts.workflow ? { workflow: opts.workflow } : {}),
      gateForKind: openTuiGateResolver(controller),
    });
    // Pre-populate the footer's phase list so all phases show up as
    // `pending` from the first frame, instead of appearing one-by-one
    // as `phase.started` events arrive. workflowDefinition() just
    // loads the YAML — cheap, no composition.
    const manifest = await runtime.workflowDefinition();
    await controller.mount(
      opts.header,
      manifest.phases.map((p) => p.id),
    );
    return {
      runtime,
      onEvent: (ev) => controller.pushEvent(ev),
      finish: (summary) => controller.finish(summary),
      dispose: () => controller.dispose(),
    };
  }

  const { nonTtyRunSession } = await import("./tui/non-tty-sink");
  const session = nonTtyRunSession();
  return {
    runtime: new HarnessRuntime({
      ...(opts.workflow ? { workflow: opts.workflow } : {}),
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
