import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditChainWriter,
  canonicalStringify,
  computeThisHash,
  GENESIS_PREV_HASH,
  verifyChainText,
} from "./audit-chain";

describe("canonicalStringify", () => {
  it("sorts keys alphabetically", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
  });

  it("sorts nested keys", () => {
    expect(canonicalStringify({ b: { y: 1, x: 2 }, a: 1 })).toBe(`{"a":1,"b":{"x":2,"y":1}}`);
  });

  it("preserves array order", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles primitives", () => {
    expect(canonicalStringify(null)).toBe("null");
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify("x")).toBe(`"x"`);
    expect(canonicalStringify(true)).toBe("true");
  });

  it("yields identical bytes for objects with different key order", () => {
    const a = { kind: "x", payload: { b: 1, a: 2 }, runId: "r" };
    const b = { runId: "r", payload: { a: 2, b: 1 }, kind: "x" };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });
});

describe("computeThisHash", () => {
  it("is stable across runs", () => {
    const env = {
      v: 1,
      seq: 0,
      ts: "2026-05-02T00:00:00Z",
      runId: "r",
      kind: "k",
      payload: { x: 1 },
      prevHash: GENESIS_PREV_HASH,
    };
    expect(computeThisHash(env)).toBe(computeThisHash(env));
  });

  it("changes when any field changes", () => {
    const base = {
      v: 1,
      seq: 0,
      ts: "2026-05-02T00:00:00Z",
      runId: "r",
      kind: "k",
      payload: { x: 1 },
      prevHash: GENESIS_PREV_HASH,
    };
    const h0 = computeThisHash(base);
    expect(computeThisHash({ ...base, seq: 1 })).not.toBe(h0);
    expect(computeThisHash({ ...base, kind: "k2" })).not.toBe(h0);
    expect(computeThisHash({ ...base, payload: { x: 2 } })).not.toBe(h0);
    expect(computeThisHash({ ...base, prevHash: "1".repeat(64) })).not.toBe(h0);
  });
});

describe("AuditChainWriter + verifyChainText", () => {
  let dir: string;
  let path: string;
  let frozenTs: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audit-chain-"));
    path = join(dir, "audit.jsonl");
    frozenTs = "2026-05-02T00:00:00.000Z";
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends entries with monotonic seq + linked prevHash", async () => {
    const writer = new AuditChainWriter({ path, now: () => frozenTs });
    await writer.open();
    const e0 = await writer.append({ runId: "r", kind: "a", payload: {} });
    const e1 = await writer.append({ runId: "r", kind: "b", payload: { x: 1 } });
    const e2 = await writer.append({ runId: "r", kind: "c", payload: { y: 2 } });
    await writer.close();

    expect(e0.seq).toBe(0);
    expect(e0.prevHash).toBe(GENESIS_PREV_HASH);
    expect(e1.seq).toBe(1);
    expect(e1.prevHash).toBe(e0.thisHash);
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.thisHash);
  });

  it("produces a verifiable file", async () => {
    const writer = new AuditChainWriter({ path, now: () => frozenTs });
    await writer.open();
    await writer.append({ runId: "r", kind: "a", payload: {} });
    await writer.append({ runId: "r", kind: "b", payload: { x: 1 } });
    await writer.append({ runId: "r", kind: "c", payload: { y: 2 } });
    await writer.close();

    const text = await readFile(path, "utf8");
    const result = verifyChainText(text);
    expect(result).toEqual({ ok: true, entries: 3 });
  });

  it("verify detects payload tampering", async () => {
    const writer = new AuditChainWriter({ path, now: () => frozenTs });
    await writer.open();
    await writer.append({ runId: "r", kind: "a", payload: { x: 1 } });
    await writer.append({ runId: "r", kind: "b", payload: { x: 2 } });
    await writer.append({ runId: "r", kind: "c", payload: { x: 3 } });
    await writer.close();

    const lines = (await readFile(path, "utf8")).split("\n");
    // Tamper with line 2's payload but leave thisHash intact — verify
    // should catch the recomputed-vs-stored mismatch.
    const tampered = JSON.parse(lines[1] ?? "");
    tampered.payload = { x: 999 };
    lines[1] = JSON.stringify(tampered);
    await writeFile(path, lines.join("\n"));

    const result = verifyChainText(await readFile(path, "utf8"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.line).toBe(2);
    expect(result.reason).toMatch(/thisHash mismatch/);
  });

  it("verify detects entry deletion (chain break)", async () => {
    const writer = new AuditChainWriter({ path, now: () => frozenTs });
    await writer.open();
    await writer.append({ runId: "r", kind: "a", payload: {} });
    await writer.append({ runId: "r", kind: "b", payload: {} });
    await writer.append({ runId: "r", kind: "c", payload: {} });
    await writer.close();

    const lines = (await readFile(path, "utf8")).split("\n");
    // Delete line 2; lines 1 + 3 remain. Line 3's prevHash now refers
    // to a deleted entry's thisHash → mismatch at line 2 (the new line 2).
    const without = [lines[0], lines[2], lines[3]].filter((s): s is string => s !== undefined);
    await writeFile(path, without.join("\n"));

    const result = verifyChainText(await readFile(path, "utf8"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.line).toBe(2);
    // Could be either seq mismatch (1 → expected 1, got 2) or prevHash;
    // we hit seq first.
    expect(result.reason).toMatch(/seq mismatch|prevHash mismatch/);
  });

  it("tolerates trailing partial line (verify-during-live-write)", async () => {
    const writer = new AuditChainWriter({ path, now: () => frozenTs });
    await writer.open();
    await writer.append({ runId: "r", kind: "a", payload: {} });
    await writer.append({ runId: "r", kind: "b", payload: {} });
    await writer.close();

    const text = await readFile(path, "utf8");
    // Append a partial line (no trailing newline). Verifier should
    // count 2 complete entries, ignore the partial.
    const partial = `${text}{"v":1,"seq":2,"ts":"`;
    await writeFile(path, partial);

    const result = verifyChainText(await readFile(path, "utf8"));
    expect(result).toEqual({ ok: true, entries: 2 });
  });

  it("verify rejects unknown schema version", () => {
    const text = `${JSON.stringify({ v: 99, seq: 0 })}\n`;
    const result = verifyChainText(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unknown schema version/);
  });

  it("verify on empty file = ok with 0 entries", () => {
    expect(verifyChainText("")).toEqual({ ok: true, entries: 0 });
  });

  it("serializes concurrent appends — no duplicate seq", async () => {
    const writer = new AuditChainWriter({ path, now: () => frozenTs });
    await writer.open();
    // Fire 20 appends concurrently. Without serialization, multiple
    // would read the same seq before any incremented → duplicate seq
    // → chain verification fails.
    const promises = Array.from({ length: 20 }, (_, i) =>
      writer.append({ runId: "r", kind: "k", payload: { i } }),
    );
    await Promise.all(promises);
    await writer.close();

    const text = await readFile(path, "utf8");
    expect(verifyChainText(text)).toEqual({ ok: true, entries: 20 });
  });
});
