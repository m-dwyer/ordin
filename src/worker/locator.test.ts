import { describe, expect, it } from "vitest";
import { workerArgv } from "./locator";

describe("workerArgv", () => {
  it("uses ORDIN_WORKER_ARGV as a JSON argv override", () => {
    expect(
      workerArgv({
        harnessRoot: "/harness",
        env: { ORDIN_WORKER_ARGV: JSON.stringify(["/bin/bun", "/harness/src/worker/entry.ts"]) },
        hasFile: () => false,
      }),
    ).toEqual(["/bin/bun", "/harness/src/worker/entry.ts"]);
  });

  it("rejects malformed ORDIN_WORKER_ARGV", () => {
    expect(() =>
      workerArgv({
        harnessRoot: "/harness",
        env: { ORDIN_WORKER_ARGV: "{}" },
        hasFile: () => false,
      }),
    ).toThrow(/non-empty JSON string array/);
  });
});
