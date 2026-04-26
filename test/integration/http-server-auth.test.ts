import { describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app";
import { isLoopbackHost, tokenFromEnv } from "../../src/http/auth";
import { RunService } from "../../src/run-service/run-service";
import { FakeRuntime, makeHarnessRoot } from "../fixtures/harness-root";

describe("HTTP auth", () => {
  it("rejects API requests without a bearer token when token is configured", async () => {
    const app = await makeApp({ token: "secret-1" });
    const res = await app.fetch(new Request("http://localhost/runs"));
    expect(res.status).toBe(401);
  });

  it("accepts API requests with a valid bearer token", async () => {
    const app = await makeApp({ token: "secret-2" });
    const res = await app.fetch(
      new Request("http://localhost/runs", {
        headers: { Authorization: "Bearer secret-2" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects API requests with the wrong bearer token", async () => {
    const app = await makeApp({ token: "secret-3" });
    const res = await app.fetch(
      new Request("http://localhost/runs", {
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("requires no auth when no token is configured", async () => {
    const app = await makeApp();
    const res = await app.fetch(new Request("http://localhost/runs"));
    expect(res.status).toBe(200);
  });

  it("leaves /openapi.json and /docs public even when token is configured", async () => {
    const app = await makeApp({ token: "secret-public" });

    const spec = await app.fetch(new Request("http://localhost/openapi.json"));
    expect(spec.status).toBe(200);

    const docs = await app.fetch(new Request("http://localhost/docs"));
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    const html = await docs.text();
    expect(html).toContain("/openapi.json");
  });

  it("advertises a bearer security scheme in the OpenAPI doc when auth is on", async () => {
    const app = await makeApp({ token: "secret-scheme" });
    const spec = (await (await app.fetch(new Request("http://localhost/openapi.json"))).json()) as {
      components?: { securitySchemes?: Record<string, { type: string; scheme: string }> };
      security?: Array<Record<string, string[]>>;
    };
    expect(spec.components?.securitySchemes?.["bearerAuth"]).toEqual({
      type: "http",
      scheme: "bearer",
    });
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
  });

  it("omits the security scheme when auth is off", async () => {
    const app = await makeApp();
    const spec = (await (await app.fetch(new Request("http://localhost/openapi.json"))).json()) as {
      components?: { securitySchemes?: Record<string, unknown> };
      security?: unknown;
    };
    expect(spec.components?.securitySchemes).toBeUndefined();
    expect(spec.security).toBeUndefined();
  });
});

describe("auth helpers", () => {
  it("identifies loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("reads token from env, returning undefined for unset / empty / whitespace", () => {
    expect(tokenFromEnv({})).toBeUndefined();
    expect(tokenFromEnv({ ORDIN_API_TOKEN: "" })).toBeUndefined();
    expect(tokenFromEnv({ ORDIN_API_TOKEN: "   " })).toBeUndefined();
    expect(tokenFromEnv({ ORDIN_API_TOKEN: "abc" })).toBe("abc");
    expect(tokenFromEnv({ ORDIN_API_TOKEN: "  abc  " })).toBe("abc");
  });
});

async function makeApp(opts: { token?: string } = {}): Promise<ReturnType<typeof createHttpApp>> {
  const root = await makeHarnessRoot();
  const service = new RunService({
    root,
    runtimes: new Map([["ai-sdk", new FakeRuntime()]]),
  });
  return createHttpApp(service, opts.token ? { auth: { token: opts.token } } : {});
}
