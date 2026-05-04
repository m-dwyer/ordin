import { describe, expect, it } from "vitest";
import { buildWorkerEnv } from "./worker-env";

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
  it("preserves ambient env for override sandboxes", () => {
    expect(buildWorkerEnv({ kind: "override" }, parentEnv)).toBe(parentEnv);
  });

  it("routes non-srt managed workers through the broker", () => {
    const env = buildWorkerEnv(
      {
        kind: "managed",
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
        kind: "managed",
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
