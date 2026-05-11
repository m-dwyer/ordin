import { describe, expect, it } from "vitest";
import { buildWorkerEnv, workerReadRoots } from "./worker-policy";

const parentEnv: NodeJS.ProcessEnv = {
  HOME: "/Users/test",
  PATH: "/usr/bin:/bin",
  TERM: "xterm-256color",
  TMPDIR: "/tmp/test",
  LANG: "en_AU.UTF-8",
  LC_CTYPE: "UTF-8",
  SHELL: "/bin/zsh",
  USER: "test",
  HTTP_PROXY: "http://parent-proxy",
  HTTPS_PROXY: "http://parent-proxy",
  LANGFUSE_PUBLIC_KEY: "pk",
  LANGFUSE_SECRET_KEY: "sk",
  LITELLM_MASTER_KEY: "llm",
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GITHUB_TOKEN: "github",
};

describe("buildWorkerEnv", () => {
  it("routes non-srt workers through the broker", () => {
    const env = buildWorkerEnv(
      {
        sandbox: { name: "passthrough" },
        broker: { proxyUrl: () => "http://ordin:secret@127.0.0.1:1234" },
      },
      parentEnv,
    );
    expect(env["HTTP_PROXY"]).toBe("http://ordin:secret@127.0.0.1:1234");
    expect(env["ANTHROPIC_API_KEY"]).toBe("anthropic");
  });

  it("allowlists only operational env for srt workers", () => {
    const env = buildWorkerEnv(
      {
        sandbox: { name: "srt" },
        broker: { proxyUrl: () => "http://ordin:secret@127.0.0.1:1234" },
      },
      parentEnv,
    );
    expect(env).toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      TMPDIR: "/tmp/test",
      LANG: "en_AU.UTF-8",
      LC_CTYPE: "UTF-8",
    });
    expect(JSON.stringify(env)).not.toContain("secret");
  });
});

describe("workerReadRoots", () => {
  it("returns directories for absolute worker argv entries", () => {
    const prev = process.env["ORDIN_WORKER_ARGV"];
    process.env["ORDIN_WORKER_ARGV"] = JSON.stringify([
      "/Users/test/.local/bin/bun",
      "/repo/src/worker/entry.ts",
      "relative-arg",
    ]);
    try {
      expect(workerReadRoots("/repo")).toEqual(["/Users/test/.local/bin", "/repo/src/worker"]);
    } finally {
      if (prev === undefined) delete process.env["ORDIN_WORKER_ARGV"];
      else process.env["ORDIN_WORKER_ARGV"] = prev;
    }
  });
});
