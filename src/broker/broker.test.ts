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

describe("Broker askApproval", () => {
  const SECRET = "test-secret-token";

  it("denies unmatched hosts when no onEgressGate is wired (and emits gate.decided)", async () => {
    const events: BrokerEgressEvent[] = [];
    const broker = new Broker({}, { proxyAuth: SECRET, onEgress: (e) => events.push(e) });
    await broker.start();
    try {
      const ok = await broker.askApproval("example.com", 443);
      expect(ok).toBe(false);
      expect(events.map((e) => e.kind)).toEqual(["broker.gate.decided"]);
    } finally {
      await broker.stop();
    }
  });

  it("auto-approves names already in local_services without prompting", async () => {
    let calls = 0;
    const broker = new Broker(
      { otel: { target: "127.0.0.1:3000" } },
      {
        proxyAuth: SECRET,
        onEgressGate: async () => {
          calls += 1;
          return false;
        },
      },
    );
    await broker.start();
    try {
      expect(await broker.askApproval("otel", 80)).toBe(true);
      expect(calls).toBe(0);
    } finally {
      await broker.stop();
    }
  });

  it("caches approvals: hook fires once per host:port for the run", async () => {
    let calls = 0;
    const broker = new Broker(
      {},
      {
        proxyAuth: SECRET,
        onEgressGate: async () => {
          calls += 1;
          return true;
        },
      },
    );
    await broker.start();
    try {
      expect(await broker.askApproval("example.com", 443)).toBe(true);
      expect(await broker.askApproval("example.com", 443)).toBe(true);
      expect(calls).toBe(1);
      expect(await broker.askApproval("example.com", 80)).toBe(true);
      expect(calls).toBe(2);
    } finally {
      await broker.stop();
    }
  });

  it("does not cache denials (re-asks on retry)", async () => {
    let calls = 0;
    const broker = new Broker(
      {},
      {
        proxyAuth: SECRET,
        onEgressGate: async () => {
          calls += 1;
          return false;
        },
      },
    );
    await broker.start();
    try {
      expect(await broker.askApproval("evil.example", 443)).toBe(false);
      expect(await broker.askApproval("evil.example", 443)).toBe(false);
      expect(calls).toBe(2);
    } finally {
      await broker.stop();
    }
  });

  it("dedupes concurrent requests for the same endpoint into one prompt", async () => {
    let calls = 0;
    let resolveHook: ((v: boolean) => void) | undefined;
    const broker = new Broker(
      {},
      {
        proxyAuth: SECRET,
        onEgressGate: () => {
          calls += 1;
          return new Promise<boolean>((r) => {
            resolveHook = r;
          });
        },
      },
    );
    await broker.start();
    try {
      const a = broker.askApproval("example.com", 443);
      const b = broker.askApproval("example.com", 443);
      expect(calls).toBe(1);
      resolveHook?.(true);
      expect(await a).toBe(true);
      expect(await b).toBe(true);
    } finally {
      await broker.stop();
    }
  });
});

describe("Broker passthrough forward", () => {
  const SECRET = "test-secret-token";
  const EXPECTED_HEADER = `Basic ${Buffer.from(`ordin:${SECRET}`).toString("base64")}`;

  it("forwards approved unmapped hosts and 403s unapproved ones", async () => {
    const { createServer } = await import("node:http");
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`upstream-saw:${req.headers.host}:${req.url}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const fakeHost = "127.0.0.1";

    const events: BrokerEgressEvent[] = [];
    const broker = new Broker(
      {},
      {
        proxyAuth: SECRET,
        onEgress: (e) => events.push(e),
        onEgressGate: async (req) => req.host === fakeHost,
      },
    );
    await broker.start();

    const send = (
      host: string,
      port: number,
      path: string,
    ): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: broker.port,
            method: "GET",
            path: `http://${host}:${port}${path}`,
            headers: { Host: `${host}:${port}`, "Proxy-Authorization": EXPECTED_HEADER },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });

    try {
      // Drive the gate to approve fakeHost:upstreamPort.
      expect(await broker.askApproval(fakeHost, upstreamPort)).toBe(true);
      const ok = await send(fakeHost, upstreamPort, "/hello");
      expect(ok.status).toBe(200);
      expect(ok.body).toContain(`upstream-saw:${fakeHost}:${upstreamPort}:/hello`);
      // An unrelated unapproved host is still 403'd.
      const denied = await send("unmapped.invalid", 80, "/x");
      expect(denied.status).toBe(403);
      // Audit chain shows the passthrough forward.
      expect(events.find((e) => e.kind === "broker.forward")?.payload).toMatchObject({
        service: "passthrough",
        host: fakeHost,
        port: upstreamPort,
      });
    } finally {
      await broker.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
