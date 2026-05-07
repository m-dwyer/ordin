import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { SandboxParams } from "../types";
import { buildSrtConfig } from "./config";
import { SrtSandbox } from "./index";
import { defaultPolicy, mergePolicy, NetworkPolicySchema } from "./policy";

function emptyStdout(): NodeJS.ReadableStream {
  return Readable.from([]);
}

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

  it("denies the home root and re-allows only required home paths", () => {
    const cfg = buildSrtConfig({ params, policy: defaultPolicy({ env: {} }), homeDir });
    expect(cfg.filesystem.denyRead).toContain(homeDir);
    expect(cfg.filesystem.allowRead).toContain(`${homeDir}/.claude`);
    expect(cfg.filesystem.allowRead).not.toContain(`${homeDir}/.ssh`);
    expect(cfg.filesystem.allowRead).not.toContain(`${homeDir}/.aws`);
  });

  it("allows ~/.claude read for ADR-006 Max-plan auth", () => {
    const cfg = buildSrtConfig({ params, policy: defaultPolicy({ env: {} }), homeDir });
    expect(cfg.filesystem.allowRead).toContain(`${homeDir}/.claude`);
  });

  it("allows ~/.claude.json read — claude-cli stops on the first read deny", () => {
    const cfg = buildSrtConfig({ params, policy: defaultPolicy({ env: {} }), homeDir });
    expect(cfg.filesystem.allowRead).toContain(`${homeDir}/.claude.json`);
  });

  it("allows explicit extra read roots for the worker interpreter", () => {
    const cfg = buildSrtConfig({
      params: {
        ...params,
        workerReadRoots: ["/Users/test/.local/share/mise/installs/bun/1.3.13/bin"],
      },
      policy: defaultPolicy({ env: {} }),
      homeDir,
    });
    expect(cfg.filesystem.allowRead).toContain(
      "/Users/test/.local/share/mise/installs/bun/1.3.13/bin",
    );
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

describe("SrtSandbox lifecycle", () => {
  it("enterIfNeeded brings up srt; spawnWorker wraps argv and resolves with the exit code", async () => {
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

    let spawnedWrapped: string | undefined;
    const s = new SrtSandbox({
      policy: defaultPolicy({ env: {} }),
      manager: fakeManager,
      spawnWrapped: (w) => {
        spawnedWrapped = w;
        calls.push("spawnWrapped");
        return { exit: Promise.resolve(42), kill: () => {}, stdout: emptyStdout() };
      },
    });

    await s.enterIfNeeded(params);
    const handle = s.spawnWorker({
      argv: ["/bin/bun", "src/runtime/worker/entry.ts", "--plan", "/tmp/p.json"],
      env: {},
    });
    await expect(handle.exit).resolves.toBe(42);

    expect(calls).toEqual([
      "initialize",
      "waitForNetworkInitialization",
      "wrapWithSandbox",
      "spawnWrapped",
    ]);
    expect(spawnedWrapped).toMatch(/^WRAPPED\(/);
    expect(spawnedWrapped).toContain("'/bin/bun'");
    expect(spawnedWrapped).toContain("'src/runtime/worker/entry.ts'");
    expect(spawnedWrapped).toContain("'/tmp/p.json'");
    expect(receivedConfig).toMatchObject({ network: { allowedDomains: [] } });
  });

  it("spawnWorker throws if called before enterIfNeeded", () => {
    const s = new SrtSandbox({
      manager: {
        initialize: async () => {},
        waitForNetworkInitialization: async () => true,
        wrapWithSandbox: async (cmd: string) => cmd,
        // biome-ignore lint/suspicious/noExplicitAny: test stub
      } as any,
      spawnWrapped: () => ({ exit: Promise.resolve(0), kill: () => {}, stdout: emptyStdout() }),
    });
    expect(() => s.spawnWorker({ argv: ["true"], env: {} })).toThrow(/before enterIfNeeded/);
  });

  it("strips credential and proxy env vars before spawning", async () => {
    const fakeManager = {
      initialize: async () => {},
      waitForNetworkInitialization: async () => true,
      wrapWithSandbox: async (cmd: string) => cmd,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const s = new SrtSandbox({
      policy: defaultPolicy({ env: {} }),
      manager: fakeManager,
      spawnWrapped: (_w, opts) => {
        receivedEnv = opts.env;
        return { exit: Promise.resolve(0), kill: () => {}, stdout: emptyStdout() };
      },
    });

    await s.enterIfNeeded(params);
    const handle = s.spawnWorker({
      argv: ["true"],
      env: {
        PATH: "/usr/bin",
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
        LITELLM_MASTER_KEY: "llm",
        ANTHROPIC_API_KEY: "anthropic",
        OPENAI_API_KEY: "openai",
        GITHUB_TOKEN: "github",
        HTTP_PROXY: "http://ordin:secret@127.0.0.1:1234",
        HTTPS_PROXY: "http://ordin:secret@127.0.0.1:1234",
      },
    });
    await handle.exit;

    expect(receivedEnv).toEqual({ PATH: "/usr/bin" });
  });

  it("does not spawn if killed before wrapWithSandbox resolves", async () => {
    let resolveWrap: ((wrapped: string) => void) | undefined;
    const fakeManager = {
      initialize: async () => {},
      waitForNetworkInitialization: async () => true,
      wrapWithSandbox: () =>
        new Promise<string>((resolve) => {
          resolveWrap = resolve;
        }),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    let spawned = false;
    const s = new SrtSandbox({
      policy: defaultPolicy({ env: {} }),
      manager: fakeManager,
      spawnWrapped: () => {
        spawned = true;
        return { exit: Promise.resolve(0), kill: () => {}, stdout: emptyStdout() };
      },
    });

    await s.enterIfNeeded(params);
    const handle = s.spawnWorker({ argv: ["true"], env: {} });
    handle.kill("SIGTERM");
    resolveWrap?.("wrapped true");

    await expect(handle.exit).resolves.toBe(143);
    expect(spawned).toBe(false);
  });

  it("enterIfNeeded passes a sandboxAskCallback that delegates to broker.askApproval", async () => {
    let receivedCallback:
      | ((p: { host: string; port: number | undefined }) => Promise<boolean>)
      | undefined;
    const fakeManager = {
      initialize: async (
        _cfg: unknown,
        cb?: (p: { host: string; port: number | undefined }) => Promise<boolean>,
      ) => {
        receivedCallback = cb;
      },
      waitForNetworkInitialization: async () => true,
      wrapWithSandbox: async (cmd: string) => cmd,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    let askedHost: string | undefined;
    const fakeBroker = {
      services: [],
      proxyUrl: () => "http://ordin:secret@127.0.0.1:0",
      start: async () => {},
      stop: async () => {},
      askApproval: async (host: string) => {
        askedHost = host;
        return true;
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Broker stub
    } as any;

    const s = new SrtSandbox({
      policy: defaultPolicy({ env: {} }),
      manager: fakeManager,
      broker: fakeBroker,
      spawnWrapped: () => ({ exit: Promise.resolve(0), kill: () => {}, stdout: emptyStdout() }),
    });

    await s.enterIfNeeded(params);
    expect(receivedCallback).toBeDefined();
    const allowed = await receivedCallback?.({ host: "example.com", port: 443 });
    expect(allowed).toBe(true);
    expect(askedHost).toBe("example.com");
  });
});
