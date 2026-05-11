import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Pipes everything written to `process.stderr` into a log file under
 * `~/.ordin/logs/latest.log` (or `$ORDIN_HOME/logs/latest.log`). The
 * original write still happens; we just duplicate to disk.
 *
 * Purpose: under the OpenTUI alt-screen, stderr writes (tree-sitter
 * worker errors, runtime telemetry, etc.) flash on the renderer's
 * frames and disappear when scrolled past. Capturing them to disk
 * means "what went wrong" stays discoverable after the run ends —
 * the dispose handler reads this back and surfaces non-empty content
 * after the TUI tears down.
 *
 * Truncate on each invocation: the log is per-process, not per-run.
 * One ordin invocation = one log file. Useful state is in the
 * audit chain and meta.json; this is just a transient capture for
 * triaging this run.
 */
export interface StderrTee {
  readonly path: string;
  /** Best-effort read of the log file's current contents. */
  readSnapshot(): string;
  /** Flush + close the file handle; safe to await multiple times. */
  close(): Promise<void>;
}

export function installStderrTee(opts: { home?: string } = {}): StderrTee {
  const home = opts.home ?? process.env["ORDIN_HOME"] ?? join(homedir(), ".ordin");
  const logsDir = join(resolve(home), "logs");
  mkdirSync(logsDir, { recursive: true });
  const path = join(logsDir, "latest.log");
  const stream: WriteStream = createWriteStream(path, { flags: "w" });

  // We replace `process.stderr.write` rather than piping the whole
  // stream so that ANSI escapes intended for the terminal still arrive
  // un-buffered. Original write is preserved so the renderer's own
  // stderr (when not in alt-screen) still shows up live.
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    try {
      stream.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
    } catch {
      // Log file write failed — don't let it break the actual stderr.
    }
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;

  let closed = false;
  return {
    path,
    readSnapshot() {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((res) => {
        stream.end(() => res());
      });
    },
  };
}

/**
 * Strip CSI / OSC ANSI sequences for readable plain-text output.
 * Used by callers that print captured stderr after the TUI tears down
 * — raw stderr often carries color codes meant for live display.
 *
 * Built dynamically from string templates to avoid biome's literal
 * control-char lint without forcing per-line suppressions.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[@-~]`, "g");
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`, "g");
export function stripAnsi(s: string): string {
  return s.replace(CSI_RE, "").replace(OSC_RE, "");
}
