import { describe, expect, it } from "vitest";
import type { SandboxParams } from "../types";
import { buildSrtConfig } from "./config";
import { SrtSandbox } from "./index";
import { defaultPolicy, mergePolicy, NetworkPolicySchema } from "./policy";

const homeDir = "/Users/test";
const params: SandboxParams = {
  workspaceRoot: "/tmp/ws",
  runStoreDir: "/tmp/runs",
  harnessRoot: "/tmp/ordin",
  tempDir: "/tmp/runtmp",
};

describe("NetworkPolicySchema", () => {
  it("defaults both arrays to empty when omitted", () => {
    const parsed = NetworkPolicySchema.parse({});
    expect(parsed.allowedDomains).toEqual([]);
    expect(parsed.deniedDomains).toEqual([]);
  });

  it("rejects empty hostname strings", () => {
    expect(() => NetworkPolicySchema.parse({ allowedDomains: [""] })).toThrow();
  });
});

describe("defaultPolicy", () => {
  it("is empty by default — only localhost (NO_PROXY bypass) reaches", () => {
    const p = defaultPolicy({ env: {} });
    expect(p.allowedDomains).toEqual([]);
    expect(p.deniedDomains).toEqual([]);
  });

  it("includes provided local-service names (forward + internal alike)", () => {
    // Both forward services (otel, llm-gateway) and internal services
    // (audit) must appear in allowedDomains so srt's filter approves
    // inner traffic destined for the broker.
    const p = defaultPolicy({ localServiceNames: ["otel", "llm-gateway", "audit"] });
    expect(p.allowedDomains).toEqual(expect.arrayContaining(["otel", "llm-gateway", "audit"]));
  });
});

describe("mergePolicy", () => {
  it("dedupes appended allowedDomains", () => {
    const merged = mergePolicy(defaultPolicy({ env: {} }), {
      allowedDomains: ["*.npmjs.org", "*.npmjs.org"],
    });
    expect(merged.allowedDomains).toEqual(["*.npmjs.org"]);
  });

  it("preserves base deny list", () => {
    const base = { allowedDomains: ["a.com"], deniedDomains: ["evil.com"] };
    const merged = mergePolicy(base, { allowedDomains: ["b.com"] });
    expect(merged.deniedDomains).toEqual(["evil.com"]);
  });
});

describe("buildSrtConfig", () => {
  it("maps params + policy into the srt schema shape", () => {
    const cfg = buildSrtConfig({
      params,
      policy: defaultPolicy({ env: {} }),
      homeDir,
    });
    expect(cfg.network.allowedDomains).toEqual([]);
    expect(cfg.filesystem.allowWrite).toContain(params.workspaceRoot);
    expect(cfg.filesystem.allowWrite).toContain(params.runStoreDir);
    expect(cfg.filesystem.allowWrite).toContain(params.tempDir);
  });

  it("denies sensitive credential dirs", () => {
    const cfg = buildSrtConfig({ params, policy: defaultPolicy({ env: {} }), homeDir });
    const denies = cfg.filesystem.denyRead;
    expect(denies).toContain(`${homeDir}/.ssh`);
    expect(denies).toContain(`${homeDir}/.aws`);
    expect(denies).toContain(`${homeDir}/.gnupg`);
    expect(denies).toContain(`${homeDir}/.netrc`);
  });

  it("allows ~/.claude read for ADR-006 Max-plan auth", () => {
    const cfg = buildSrtConfig({ params, policy: defaultPolicy({ env: {} }), homeDir });
    expect(cfg.filesystem.allowRead).toContain(`${homeDir}/.claude`);
  });

  it("does not include harnessRoot in allowWrite (the allow-only model denies it by default)", () => {
    const cfg = buildSrtConfig({ params, policy: defaultPolicy({ env: {} }), homeDir });
    expect(cfg.filesystem.allowWrite).not.toContain(params.harnessRoot);
  });

  it("leaves denyWrite empty — allow-only model handles defense, no overlap with allowWrite", () => {
    const cfg = buildSrtConfig({ params, policy: defaultPolicy({ env: {} }), homeDir });
    expect(cfg.filesystem.denyWrite).toEqual([]);
  });

  it("enables allowPty so TUI raw-mode setRawMode works inside the sandbox", () => {
    const cfg = buildSrtConfig({ params, policy: defaultPolicy({ env: {} }), homeDir });
    expect(cfg.allowPty).toBe(true);
  });
});

describe("SrtSandbox.readiness", () => {
  it("ok on darwin with sandbox-exec present", async () => {
    const s = new SrtSandbox({
      platform: () => "darwin",
      hasFile: () => true,
    });
    const r = await s.readiness();
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("not ok on linux", async () => {
    const s = new SrtSandbox({
      platform: () => "linux",
      hasFile: () => true,
    });
    const r = await s.readiness();
    expect(r.ok).toBe(false);
    expect(r.reasons.join("|")).toMatch(/macOS/i);
  });

  it("not ok if sandbox-exec missing on darwin", async () => {
    const s = new SrtSandbox({
      platform: () => "darwin",
      hasFile: () => false,
    });
    const r = await s.readiness();
    expect(r.ok).toBe(false);
    expect(r.reasons.join("|")).toMatch(/sandbox-exec/);
  });
});

describe("SrtSandbox.enterIfNeeded", () => {
  it("no-ops when SANDBOX_RUNTIME=1 (already inside)", async () => {
    let initCalled = false;
    const fakeManager = {
      initialize: async () => {
        initCalled = true;
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub for unused methods
    } as any;
    const s = new SrtSandbox({
      env: () => ({ SANDBOX_RUNTIME: "1" }),
      manager: fakeManager,
    });
    await s.enterIfNeeded(params);
    expect(initCalled).toBe(false);
  });

  it("initializes srt, wraps argv, runs wrapped, exits with child code", async () => {
    const calls: string[] = [];
    let receivedConfig: unknown;
    const fakeManager = {
      initialize: async (cfg: unknown) => {
        calls.push("initialize");
        receivedConfig = cfg;
      },
      waitForNetworkInitialization: async () => {
        calls.push("waitForNetworkInitialization");
        return true;
      },
      wrapWithSandbox: async (cmd: string) => {
        calls.push("wrapWithSandbox");
        return `WRAPPED(${cmd})`;
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    let runWrappedArg: string | undefined;
    let runWrappedCwd: string | undefined;
    let exitCode: number | undefined;
    const s = new SrtSandbox({
      policy: defaultPolicy({ env: {} }),
      manager: fakeManager,
      env: () => ({}),
      argv: () => ["/bin/bun", "src/cli/index.ts", "run", "verify"],
      runWrapped: async (w, opts) => {
        runWrappedArg = w;
        runWrappedCwd = opts.cwd;
        calls.push("runWrapped");
        return 42;
      },
      exit: ((code: number) => {
        exitCode = code;
        calls.push("exit");
        // Don't actually exit in tests — throw the marker that
        // production callers won't see.
        throw new Error("__test_exit__");
      }) as never,
    });

    await expect(s.enterIfNeeded(params)).rejects.toThrow("__test_exit__");
    expect(calls).toEqual([
      "initialize",
      "waitForNetworkInitialization",
      "wrapWithSandbox",
      "runWrapped",
      "exit",
    ]);
    expect(runWrappedArg).toMatch(/^WRAPPED\(/);
    expect(runWrappedArg).toContain("'/bin/bun'");
    expect(runWrappedArg).toContain("'src/cli/index.ts'");
    expect(runWrappedArg).toContain("'verify'");
    expect(runWrappedCwd).toBeUndefined();
    expect(exitCode).toBe(42);
    expect(receivedConfig).toMatchObject({
      network: { allowedDomains: [] },
    });
  });
});
