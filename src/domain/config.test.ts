import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, SandboxModeSchema } from "./config";

describe("HarnessConfigSchema — sandbox field", () => {
  it("defaults to passthrough mode + empty services when omitted", () => {
    const result = HarnessConfigSchema.parse({});
    expect(result.sandbox.mode).toBe("passthrough");
    expect(result.sandbox.local_services).toEqual({});
  });

  it("accepts the legacy string form", () => {
    const result = HarnessConfigSchema.parse({ sandbox: "srt" });
    expect(result.sandbox.mode).toBe("srt");
  });

  it("accepts the object form with local_services", () => {
    const result = HarnessConfigSchema.parse({
      sandbox: {
        mode: "srt",
        local_services: { otel: { target: "127.0.0.1:3000" } },
      },
    });
    expect(result.sandbox.mode).toBe("srt");
    expect(result.sandbox.local_services).toEqual({ otel: { target: "127.0.0.1:3000" } });
  });

  it("accepts a service entry with basic auth", () => {
    const result = HarnessConfigSchema.parse({
      sandbox: {
        mode: "srt",
        local_services: {
          otel: {
            target: "127.0.0.1:3000",
            auth: { type: "basic", username_env: "U", password_env: "P" },
          },
        },
      },
    });
    expect(result.sandbox.local_services["otel"]?.auth?.type).toBe("basic");
  });

  it("accepts a service entry with bearer auth", () => {
    const result = HarnessConfigSchema.parse({
      sandbox: {
        mode: "srt",
        local_services: {
          gw: { target: "127.0.0.1:4000", auth: { type: "bearer", token_env: "T" } },
        },
      },
    });
    expect(result.sandbox.local_services["gw"]?.auth?.type).toBe("bearer");
  });

  it("rejects unknown sandbox modes", () => {
    expect(HarnessConfigSchema.safeParse({ sandbox: "docker" }).success).toBe(false);
  });

  it("rejects local_services entries whose target isn't host:port", () => {
    const result = HarnessConfigSchema.safeParse({
      sandbox: { mode: "srt", local_services: { otel: { target: "no-port" } } },
    });
    expect(result.success).toBe(false);
  });
});

describe("SandboxModeSchema", () => {
  it("rejects empty string", () => {
    expect(SandboxModeSchema.safeParse("").success).toBe(false);
  });

  it("rejects null and undefined explicitly", () => {
    expect(SandboxModeSchema.safeParse(null).success).toBe(false);
    expect(SandboxModeSchema.safeParse(undefined).success).toBe(false);
  });
});
