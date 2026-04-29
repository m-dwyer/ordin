import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, SandboxModeSchema } from "./config";

describe("HarnessConfigSchema — sandbox field", () => {
  it("defaults to 'passthrough' when omitted", () => {
    const result = HarnessConfigSchema.parse({});
    expect(result.sandbox).toBe("passthrough");
  });

  it("accepts 'passthrough' explicitly", () => {
    const result = HarnessConfigSchema.parse({ sandbox: "passthrough" });
    expect(result.sandbox).toBe("passthrough");
  });

  it("accepts 'seatbelt'", () => {
    const result = HarnessConfigSchema.parse({ sandbox: "seatbelt" });
    expect(result.sandbox).toBe("seatbelt");
  });

  it("rejects unknown sandbox modes with a useful error path", () => {
    const result = HarnessConfigSchema.safeParse({ sandbox: "docker" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "sandbox");
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/passthrough|seatbelt/);
    }
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
