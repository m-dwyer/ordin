import { describe, expect, it } from "vitest";
import { resolveRuntimeConfig } from "./run-execution";

describe("resolveRuntimeConfig", () => {
  it("merges the runtime profile for the effective sandbox mode", () => {
    const slice = {
      max_steps: 40,
      profiles: {
        srt: { base_url: "http://llm-gateway/v1" },
        passthrough: {
          base_url: "http://localhost:4000/v1",
          api_key_env: "LITELLM_MASTER_KEY",
        },
      },
    };

    expect(resolveRuntimeConfig("ai-sdk", slice, "srt")).toEqual({
      max_steps: 40,
      base_url: "http://llm-gateway/v1",
    });
    expect(resolveRuntimeConfig("ai-sdk", slice, "passthrough")).toEqual({
      max_steps: 40,
      base_url: "http://localhost:4000/v1",
      api_key_env: "LITELLM_MASTER_KEY",
    });
  });

  it("falls back to top-level runtime config when no mode profile exists", () => {
    expect(
      resolveRuntimeConfig(
        "ai-sdk",
        {
          base_url: "http://localhost:4000/v1",
          max_steps: 12,
          profiles: {
            srt: { base_url: "http://llm-gateway/v1" },
          },
        },
        "passthrough",
      ),
    ).toEqual({
      base_url: "http://localhost:4000/v1",
      max_steps: 12,
    });
  });

  it("rejects non-object runtime profiles", () => {
    expect(() =>
      resolveRuntimeConfig("ai-sdk", { profiles: { srt: "http://llm-gateway/v1" } }, "srt"),
    ).toThrow(/profile "srt" must be an object/);
  });
});
