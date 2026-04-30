import { unlinkSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";

/**
 * Trust-critical service in the parent ordin process. Mediates things
 * the sandboxed agent isn't trusted to do directly. Today: forward a
 * fixed allowlist of hostnames to mapped local services via srt's
 * `mitmProxy` Unix-socket hook (per-host + per-port granularity, no
 * /etc/hosts, no DNS server, `allowLocalBinding: false`). Future
 * listeners (capability decisions ADR-013, audit ADR-005) plug in as
 * additional members on the same lifecycle.
 *
 * HTTPS is end-to-end encrypted between the inner client and the
 * destination — CONNECT opens a raw TCP tunnel; the broker never sees
 * plaintext.
 */
export const LocalServicesConfigSchema = z.record(
  z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "service name must be a single dotless label"),
  z.string().regex(/^[^:\s]+:\d+$/, "expected host:port"),
);
export type LocalServicesConfig = z.infer<typeof LocalServicesConfigSchema>;

export interface LocalService {
  readonly name: string;
  readonly host: string;
  readonly port: number;
}

export class Broker {
  readonly socketPath: string;
  readonly services: readonly LocalService[];
  private readonly map: ReadonlyMap<string, LocalService>;
  private readonly forwardServer: Server;

  constructor(servicesConfig: LocalServicesConfig, socketPath?: string) {
    this.services = parseServices(servicesConfig);
    this.map = new Map(this.services.map((s) => [s.name, s]));
    this.socketPath = socketPath ?? join(tmpdir(), `ordin-broker-${process.pid}.sock`);
    this.forwardServer = createServer();
    this.forwardServer.on("request", (req, res) => this.onRequest(req, res));
    this.forwardServer.on("connect", (req, sock, head) => this.onConnect(req, sock, head));
    this.forwardServer.on("error", () => {});
  }

  /** Hostnames srt should route through this broker (mitmProxy.domains). */
  domains(): readonly string[] {
    return this.services.map((s) => s.name);
  }

  async start(): Promise<void> {
    try {
      unlinkSync(this.socketPath);
    } catch {}
    return new Promise((resolve, reject) => {
      this.forwardServer.once("error", reject);
      this.forwardServer.listen(this.socketPath, () => {
        this.forwardServer.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.forwardServer.close(() => resolve()));
    try {
      unlinkSync(this.socketPath);
    } catch {}
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const target = req.url ? this.map.get(new URL(req.url).hostname) : undefined;
    if (!target) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("ordin-broker: no mapping");
      return;
    }
    const url = new URL(req.url ?? "");
    const upstream = request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...req.headers, host: `${target.host}:${target.port}` },
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

function parseServices(raw: LocalServicesConfig): readonly LocalService[] {
  return Object.entries(raw).map(([name, target]) => {
    const [host = "", portStr = ""] = target.split(":");
    return { name, host, port: Number.parseInt(portStr, 10) };
  });
}
