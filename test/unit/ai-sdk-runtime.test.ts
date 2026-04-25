import { afterEach, describe, expect, it } from "vitest";
import { AiSdkRuntime } from "../../src/runtimes/ai-sdk";

describe("AiSdkRuntime.fromConfig", () => {
  afterEach(() => {
    delete process.env["ORDIN_TEST_LITELLM_KEY"];
  });

  it("accepts local OpenAI-compatible provider config", () => {
    process.env["ORDIN_TEST_LITELLM_KEY"] = "test-key";

    const runtime = AiSdkRuntime.fromConfig({
      base_url: "http://localhost:4000",
      api_key_env: "ORDIN_TEST_LITELLM_KEY",
      max_steps: 12,
      bypass_cache: true,
    });

    expect(runtime.name).toBe("ai-sdk");
  });

  it("rejects invalid config shapes", () => {
    expect(() => AiSdkRuntime.fromConfig({ base_url: "not-a-url" })).toThrow();
    expect(() => AiSdkRuntime.fromConfig({ max_steps: 0 })).toThrow();
  });
});
