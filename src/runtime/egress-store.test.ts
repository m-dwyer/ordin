import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EgressApprovalStore } from "./egress-store";

describe("EgressApprovalStore", () => {
  let ordinDir: string;

  beforeEach(async () => {
    ordinDir = await mkdtemp(join(tmpdir(), "ordin-egress-"));
  });

  afterEach(async () => {
    await rm(ordinDir, { recursive: true, force: true });
  });

  it("loads, persists new hosts, dedupes, survives a fresh instance", async () => {
    const store = new EgressApprovalStore({ ordinDir, projectKey: "demo" });
    expect(await store.load()).toEqual([]);

    await store.add("api.anthropic.com", 443);
    await store.add("registry.npmjs.org", 443);
    // duplicate is a no-op
    await store.add("api.anthropic.com", 443);

    const reopened = new EgressApprovalStore({ ordinDir, projectKey: "demo" });
    expect(await reopened.load()).toEqual([
      { host: "api.anthropic.com", port: 443 },
      { host: "registry.npmjs.org", port: 443 },
    ]);
  });

  it("treats malformed YAML as a hard error pointing at the file", async () => {
    const store = new EgressApprovalStore({ ordinDir, projectKey: "broken" });
    const path = join(ordinDir, "projects", "broken", "egress.yaml");
    await writeFile(path.replace("egress.yaml", ".keep"), "", "utf8").catch(() => {});
    // Write malformed (host is a number, not a string).
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(ordinDir, "projects", "broken"), { recursive: true });
    await writeFile(path, "hosts: [42]\n", "utf8");
    await expect(store.load()).rejects.toThrow(/Invalid/);
  });

  it("derives the project key from the workspace basename", () => {
    expect(EgressApprovalStore.projectKeyForWorkspace("/Users/em/src/foo")).toBe("foo");
    expect(EgressApprovalStore.projectKeyForWorkspace("/Users/em/src/foo", "explicit")).toBe(
      "explicit",
    );
  });

  it("writes a hand-editable yaml the user can inspect", async () => {
    const store = new EgressApprovalStore({ ordinDir, projectKey: "readable" });
    await store.add("api.anthropic.com", 443);
    const path = join(ordinDir, "projects", "readable", "egress.yaml");
    expect(await readFile(path, "utf8")).toContain("api.anthropic.com:443");
  });
});
