import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Broker, type BrokerEgressEvent } from "./index";

describe("Broker proxy auth", () => {
  const SECRET = "test-secret-token";
  const EXPECTED_HEADER = `Basic ${Buffer.from(`ordin:${SECRET}`).toString("base64")}`;
  let broker: Broker;
  let egressEvents: BrokerEgressEvent[];

  beforeEach(async () => {
    egressEvents = [];
    broker = new Broker(
      {},
      {
        proxyAuth: SECRET,
        onEgress: (e) => egressEvents.push(e),
      },
    );
    await broker.start();
  });

  afterEach(async () => {
    await broker.stop();
  });

  function rawRequest(opts: {
    method: string;
    path: string;
    host: string;
    auth?: string;
  }): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: broker.port,
          method: opts.method,
          path: opts.path,
          headers: {
            Host: opts.host,
            ...(opts.auth ? { "Proxy-Authorization": opts.auth } : {}),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("constructor throws without proxyAuth", () => {
    // @ts-expect-error — proxyAuth is required at the type level
    expect(() => new Broker({}, {})).toThrow(/proxyAuth required/);
  });

  it("rejects requests with no Proxy-Authorization (407)", async () => {
    const res = await rawRequest({ method: "POST", path: "/events", host: "audit" });
    expect(res.status).toBe(407);
  });

  it("rejects requests with wrong Proxy-Authorization (407)", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/events",
      host: "audit",
      auth: "Basic d3Jvbmc6Y3JlZHM=", // base64(wrong:creds)
    });
    expect(res.status).toBe(407);
  });

  it("accepts requests with the correct Proxy-Authorization", async () => {
    // No mapping for "missing", so a passing-auth request still 403s —
    // the point is auth was accepted before mapping was checked.
    const res = await rawRequest({
      method: "POST",
      path: "/events",
      host: "missing",
      auth: EXPECTED_HEADER,
    });
    expect(res.status).toBe(403);
  });

  it("rejects CONNECT without auth (407, no audit emission)", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: broker.port,
        method: "CONNECT",
        path: "example.com:443",
      });
      req.on("connect", (res) => {
        expect(res.statusCode).toBe(407);
        resolve();
      });
      req.on("error", reject);
      req.end();
    });
    // Auth check happens BEFORE the broker.connect emit, so the
    // unauthenticated CONNECT must not appear in the audit stream.
    expect(egressEvents.find((e) => e.kind === "broker.connect")).toBeUndefined();
  });

  it("includes userinfo in proxyUrl()", () => {
    expect(broker.proxyUrl()).toMatch(new RegExp(`^http://ordin:${SECRET}@127\\.0\\.0\\.1:\\d+$`));
  });
});
