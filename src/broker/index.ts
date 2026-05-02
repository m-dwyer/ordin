import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";

/**
 * Trust-critical service in the parent ordin process. Mediates HTTP
 * traffic the sandboxed agent isn't trusted to handle directly.
 *
 * Wired as srt's `parentProxy`: the inner sends requests through srt's
 * HTTP proxy (HTTP_PROXY env), srt enforces its hostname allowlist,
 * then forwards approved requests to this broker on a localhost TCP
 * port. The broker dispatches by `req.url` hostname to mapped local
 * services, injecting an `Authorization` header from credentials it
 * holds parent-side. Hostnames not in `local_services` get 403 — the
 * broker is the inner's only egress endpoint, and we don't yet act as
 * a generic forward proxy.
 *
 * Listens on `127.0.0.1:0` by default (ephemeral port). Bind path was
 * a Unix socket originally; switched to TCP because Bun ≤1.3.13 ignores
 * `http.Agent({ socketPath })` when paired with an absolute-URL `path`,
 * which is exactly the shape srt's mitmProxy hook uses. parentProxy
 * uses standard TCP forwarding — no agent-with-socketPath shape — so
 * the bug is bypassed entirely.
 *
 * Auth injection: services may declare `auth` in their config. The
 * broker resolves the referenced env var at construction (parent-side)
 * and stamps `Authorization: <value>` onto each forwarded request. The
 * inner never sees the credential — it sends plain HTTP to a hostname
 * the broker maps; the broker adds the header on the way out.
 *
 * HTTPS is end-to-end encrypted between the inner client and the
 * destination — CONNECT opens a raw TCP tunnel; the broker never sees
 * plaintext (and therefore cannot inject auth on a CONNECT path).
 * Today the only services that need auth (Langfuse, LiteLLM) run as
 * plaintext localhost services, so this restriction is academic.
 */
export const LocalServiceAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("basic"),
    username_env: z.string().min(1),
    password_env: z.string().min(1),
  }),
  z.object({
    type: z.literal("bearer"),
    token_env: z.string().min(1),
  }),
]);
export type LocalServiceAuthConfig = z.infer<typeof LocalServiceAuthSchema>;

export const LocalServiceConfigSchema = z.object({
  target: z.string().regex(/^[^:\s]+:\d+$/, "expected host:port"),
  auth: LocalServiceAuthSchema.optional(),
});
export type LocalServiceConfig = z.infer<typeof LocalServiceConfigSchema>;

export const LocalServicesConfigSchema = z.record(
  z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "service name must be a single dotless label"),
  LocalServiceConfigSchema,
);
export type LocalServicesConfig = z.infer<typeof LocalServicesConfigSchema>;

export interface LocalService {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** Pre-computed `Authorization` header value, resolved at construction. */
  readonly authHeader?: string;
}

export interface BrokerOptions {
  /** Bind address. Defaults to 127.0.0.1 (loopback only). */
  readonly host?: string;
  /** Bind port. Defaults to 0 (OS-assigned). Use a fixed port for tests. */
  readonly port?: number;
  /** Override env for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

export class Broker {
  readonly services: readonly LocalService[];
  private readonly map: ReadonlyMap<string, LocalService>;
  private readonly forwardServer: Server;
  private readonly bindHost: string;
  private bindPort: number;

  constructor(servicesConfig: LocalServicesConfig, options: BrokerOptions = {}) {
    this.services = parseServices(servicesConfig, options.env ?? process.env);
    this.map = new Map(this.services.map((s) => [s.name, s]));
    this.bindHost = options.host ?? "127.0.0.1";
    this.bindPort = options.port ?? 0;
    this.forwardServer = createServer();
    this.forwardServer.on("request", (req, res) => this.onRequest(req, res));
    this.forwardServer.on("connect", (req, sock, head) => this.onConnect(req, sock, head));
    this.forwardServer.on("error", () => {});
  }

  /** Address the broker is bound to. Valid only after `start()` resolves. */
  get host(): string {
    return this.bindHost;
  }
  get port(): number {
    return this.bindPort;
  }
  /** Convenience for srt's `parentProxy.http` field. */
  proxyUrl(): string {
    return `http://${this.bindHost}:${this.bindPort}`;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      this.forwardServer.once("error", onErr);
      this.forwardServer.listen(this.bindPort, this.bindHost, () => {
        this.forwardServer.off("error", onErr);
        const addr = this.forwardServer.address() as AddressInfo | null;
        if (addr && typeof addr === "object") this.bindPort = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.forwardServer.close(() => resolve()));
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    // Acting as srt's parentProxy: req.url is an absolute URL
    // (`POST http://otel/api/...`) because srt forwards in proxy form.
    const target = req.url ? this.map.get(new URL(req.url).hostname) : undefined;
    if (!target) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("ordin-broker: no mapping");
      return;
    }
    const url = new URL(req.url ?? "");
    // Spread order matters: req.headers first, then host override (so
    // the upstream sees the destination, not the broker), then authHeader
    // last (overrides anything the inner may have set).
    const headers: NodeJS.Dict<string | string[]> = {
      ...req.headers,
      host: `${target.host}:${target.port}`,
      ...(target.authHeader ? { authorization: target.authHeader } : {}),
    };
    const upstream = request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
    });
    req.pipe(upstream);
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("ordin-broker: upstream error");
    });
  }

  private onConnect(req: IncomingMessage, client: Duplex, head: Buffer): void {
    // CONNECT format is `host:port`. We only tunnel for hostnames that
    // map to a local_service — anything else is denied. (HTTPS auth
    // injection isn't possible since the broker doesn't terminate TLS.)
    const [hostname = ""] = (req.url ?? "").split(":");
    const target = this.map.get(hostname);
    if (!target) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = netConnect(target.port, target.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  }
}

function parseServices(raw: LocalServicesConfig, env: NodeJS.ProcessEnv): readonly LocalService[] {
  return Object.entries(raw).map(([name, cfg]) => {
    const [host = "", portStr = ""] = cfg.target.split(":");
    const authHeader = cfg.auth ? buildAuthHeader(name, cfg.auth, env) : undefined;
    return {
      name,
      host,
      port: Number.parseInt(portStr, 10),
      ...(authHeader ? { authHeader } : {}),
    };
  });
}

function buildAuthHeader(
  serviceName: string,
  auth: LocalServiceAuthConfig,
  env: NodeJS.ProcessEnv,
): string {
  if (auth.type === "basic") {
    const username = env[auth.username_env];
    const password = env[auth.password_env];
    if (!username || !password) {
      throw new Error(
        `Broker service "${serviceName}" declares basic auth but ${auth.username_env} / ${auth.password_env} is not set in the parent env.`,
      );
    }
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    return `Basic ${encoded}`;
  }
  const token = env[auth.token_env];
  if (!token) {
    throw new Error(
      `Broker service "${serviceName}" declares bearer auth but ${auth.token_env} is not set in the parent env.`,
    );
  }
  return `Bearer ${token}`;
}
