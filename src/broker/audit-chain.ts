import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";

/**
 * Hash-chained audit log. The broker is the sole writer; entries are
 * append-only, sha256-linked, one JSON envelope per line. Tampering
 * with any line breaks the chain at that line and every line after.
 *
 * Envelope shape on disk (one per JSONL line):
 *
 *   { v, seq, ts, runId, kind, payload, prevHash, thisHash }
 *
 * `thisHash = sha256(canonical({v, seq, ts, runId, kind, payload, prevHash}))`
 *   — i.e. everything written EXCEPT thisHash itself. The verifier
 *   recomputes thisHash from the same fields and compares.
 *
 * `prevHash` of the first entry (seq=0) is 64 hex zeros — avoids a
 * special-case sentinel string the verifier has to remember.
 *
 * Canonical JSON: keys sorted alphabetically (recursively), no
 * whitespace, JSON.stringify's default escaping. Not RFC 8785 JCS —
 * that's overkill for our own data (we never put floats or unicode
 * keys in payloads). The 30-line `canonicalStringify` below is
 * sufficient for tamper-evidence so long as the broker is the only
 * writer and uses this same function.
 *
 * Failure mode: writes are append+fdatasync per entry. The audit chain
 * is only useful if it survives a crash, so per-entry fsync is the
 * right cost trade. Audit volume is tens-to-hundreds of events per run
 * — the latency budget tolerates it.
 */

export const AUDIT_SCHEMA_VERSION = 1;
export const GENESIS_PREV_HASH = "0".repeat(64);

export interface AuditEvent {
  readonly runId: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface AuditEnvelope {
  readonly v: number;
  readonly seq: number;
  readonly ts: string;
  readonly runId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly thisHash: string;
}

/**
 * Stable JSON serialization. Keys sorted alphabetically at every depth;
 * arrays preserved in input order; primitives serialized via
 * JSON.stringify. Returns a deterministic byte-string for any
 * JSON-shaped value that uses string keys — sufficient for our own
 * envelopes and payloads.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Compute thisHash from the envelope-without-thisHash. Pure; the same
 * inputs always produce the same bytes.
 */
export function computeThisHash(envelope: Omit<AuditEnvelope, "thisHash">): string {
  const canonical = canonicalStringify(envelope);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface AuditChainWriterOptions {
  readonly path: string;
  /** Inject for tests. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
}

/**
 * Append-only writer. Holds the file handle open across appends, tracks
 * the running seq + prevHash in memory. One writer per run-file —
 * concurrent writers would race on seq + chain state.
 */
export class AuditChainWriter {
  private readonly path: string;
  private readonly now: () => string;
  private fh?: FileHandle;
  private seq = 0;
  private prevHash = GENESIS_PREV_HASH;
  /** Tail of the append queue. Serializes concurrent append() calls so
   *  the seq + prevHash state mutates atomically per entry. Without
   *  this, two interleaved appends both read the same seq before
   *  either increments → duplicate seq numbers, broken chain. */
  private appendQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: AuditChainWriterOptions) {
    this.path = opts.path;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async open(): Promise<void> {
    if (this.fh) return;
    // Append mode; create if missing. If the file already exists (e.g.
    // a prior process wrote partial audit and crashed), we should
    // resume from its tail rather than clobber. For step 2 we keep it
    // simple: a new writer always starts a fresh chain. Resuming from
    // a partially-written file is a follow-on (`AuditChainWriter.resume`).
    this.fh = await open(this.path, "a");
  }

  async close(): Promise<void> {
    // Drain any in-flight appends before closing the handle. Errors on
    // queued appends are surfaced to their own callers, not here.
    await this.appendQueue.catch(() => {});
    if (!this.fh) return;
    await this.fh.close();
    this.fh = undefined;
  }

  /**
   * Append one event. Returns the written envelope. Throws if the file
   * handle isn't open. Concurrent calls are queued — each append
   * completes (write + datasync + state update) before the next reads
   * the seq counter.
   */
  append(event: AuditEvent): Promise<AuditEnvelope> {
    const next = this.appendQueue.then(() => this.appendOne(event));
    // Swallow at the queue level so one failure doesn't poison the
    // chain for subsequent callers. The original promise still
    // rejects to its own caller.
    this.appendQueue = next.catch(() => {});
    return next;
  }

  private async appendOne(event: AuditEvent): Promise<AuditEnvelope> {
    if (!this.fh) throw new Error("AuditChainWriter: open() before append()");
    const base: Omit<AuditEnvelope, "thisHash"> = {
      v: AUDIT_SCHEMA_VERSION,
      seq: this.seq,
      ts: this.now(),
      runId: event.runId,
      kind: event.kind,
      payload: event.payload,
      prevHash: this.prevHash,
    };
    const thisHash = computeThisHash(base);
    const envelope: AuditEnvelope = { ...base, thisHash };
    // Single write per envelope; \n terminator. Followed by datasync so
    // the entry survives a crash before the next append.
    await this.fh.appendFile(`${JSON.stringify(envelope)}\n`);
    await this.fh.datasync();
    this.seq += 1;
    this.prevHash = thisHash;
    return envelope;
  }
}

export type VerifyResult =
  | { readonly ok: true; readonly entries: number }
  | {
      readonly ok: false;
      readonly entries: number;
      readonly line: number;
      readonly reason: string;
    };

/**
 * Walk a JSONL audit file line-by-line and verify the chain. Tolerates
 * a trailing partial line (no terminating newline) so a verifier run
 * during a live write doesn't false-alarm; the partial line is reported
 * as a count of complete entries verified, with a note in the result.
 *
 * `lines` is the file contents as a single string. The verifier is
 * pure — file I/O lives at the call site so testing is just string-in,
 * result-out.
 */
export function verifyChainText(text: string): VerifyResult {
  const allLines = text.split("\n");
  // Last element is empty when text ends with "\n"; otherwise it's a
  // partial line. We treat a non-empty last element as partial and
  // skip it (consistent with verifying-during-live-write).
  const lastIsPartial = allLines.length > 0 && allLines[allLines.length - 1] !== "";
  const lines = lastIsPartial ? allLines.slice(0, -1) : allLines;
  const completeLines = lines.filter((l) => l.length > 0);

  let expectedSeq = 0;
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < completeLines.length; i++) {
    const lineNo = i + 1;
    const raw = completeLines[i] ?? "";
    let envelope: AuditEnvelope;
    try {
      envelope = JSON.parse(raw) as AuditEnvelope;
    } catch (err) {
      return {
        ok: false,
        entries: i,
        line: lineNo,
        reason: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (envelope.v !== AUDIT_SCHEMA_VERSION) {
      return {
        ok: false,
        entries: i,
        line: lineNo,
        reason: `unknown schema version v=${envelope.v} (verifier supports v=${AUDIT_SCHEMA_VERSION})`,
      };
    }
    if (envelope.seq !== expectedSeq) {
      return {
        ok: false,
        entries: i,
        line: lineNo,
        reason: `seq mismatch: expected ${expectedSeq}, got ${envelope.seq}`,
      };
    }
    if (envelope.prevHash !== expectedPrev) {
      return {
        ok: false,
        entries: i,
        line: lineNo,
        reason: `prevHash mismatch: expected ${expectedPrev}, got ${envelope.prevHash}`,
      };
    }
    const { thisHash, ...rest } = envelope;
    const recomputed = computeThisHash(rest);
    if (recomputed !== thisHash) {
      return {
        ok: false,
        entries: i,
        line: lineNo,
        reason: `thisHash mismatch: expected ${recomputed}, got ${thisHash}`,
      };
    }
    expectedSeq += 1;
    expectedPrev = thisHash;
  }
  return { ok: true, entries: completeLines.length };
}
