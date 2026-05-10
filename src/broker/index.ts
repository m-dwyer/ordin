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
import type { LocalServiceAuthConfig, LocalServicesConfig } from "../domain/capability-policy";

export type {
  LocalServiceAuthConfig,
  LocalServiceConfig,
  LocalServicesConfig,
} from "../domain/capability-policy";
export {
  LocalServiceAuthSchema,
  LocalServiceConfigSchema,
  LocalServicesConfigSchema,
} from "../domain/capability-policy";

/**
 * Trust-critical service in the parent ordin process. Mediates HTTP
 * traffic the sandboxed agent isn't trusted to handle directly.
 *
 * Wired as srt's `parentProxy`: the inner sends requests through srt's
 * HTTP proxy (HTTP_PROXY env), srt enforces its hostname allowlist,
 * then forwards approved requests to this broker on a localhost TCP
 * port. The broker dispatches by `req.url` hostname to one of two
 * service kinds:
 *   - `forward`: proxy to a mapped local service, injecting auth
 *     credentials the inner doesn't possess (Langfuse, LiteLLM).
 *   - `internal`: handle in-broker — no upstream forward. The audit
 *     service is the canonical example; the inner POSTs run events
 *     and the handler appends to the chain.
 *
 * Listens on `127.0.0.1:0` by default (ephemeral port). Bind path was
 * a Unix socket originally; switched to TCP because Bun ≤1.3.13 ignores
 * `http.Agent({ socketPath })` when paired with an absolute-URL `path`,
 * which is exactly the shape srt's mitmProxy hook uses. parentProxy
 * uses standard TCP forwarding — no agent-with-socketPath shape — so
 * the bug is bypassed entirely.
 *
 * Auth injection: forward services may declare `auth` in their config.
 * The broker resolves the referenced env var at construction (parent-
 * side) and stamps `Authorization: <value>` onto each forwarded
 * request. The inner never sees the credential — it sends plain HTTP
 * to a hostname the broker maps; the broker adds the header on the
 * way out.
 *
 * CONNECT (HTTPS, SOCKS-via-CONNECT through srt's SOCKS proxy):
 * the broker is a passthrough TCP tunneler — it trusts that anything
 * arriving as CONNECT has already been allowlisted by srt's filter
 * (which is the case by construction: the inner's HTTP_PROXY points at
 * srt, srt forwards to the broker only after its own allowlist check).
 * Every CONNECT is reported via `onEgress` so the audit chain captures
 * non-HTTP egress visibility — that's the point of routing SOCKS
 * traffic through us. HTTPS auth injection is not possible (broker
 * doesn't terminate TLS), and no current upstream needs it.
 */
export type InternalServiceHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface ForwardService {
  readonly kind: "forward";
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** Pre-computed `Authorization` header value, resolved at construction. */
  readonly authHeader?: string;
}

export interface InternalService {
  readonly kind: "internal";
  readonly name: string;
  readonly handler: InternalServiceHandler;
}

export type BrokerService = ForwardService | InternalService;

/** Egress event the broker observes about its own activity. The harness
 *  wires this to the audit chain so broker.* entries appear alongside
 *  the inner-emitted run events. */
export interface BrokerEgressEvent {
  readonly kind:
    | "broker.forward"
    | "broker.forward.denied"
    | "broker.connect"
    | "broker.connect.denied"
    | "broker.gate.requested"
    | "broker.gate.decided";
  readonly payload: Record<string, unknown>;
}

/** What srt asks the broker about whenever the inner attempts an
 *  egress that doesn't match the static `allowedDomains` policy. */
export interface EgressGateRequest {
  readonly host: string;
  readonly port: number | undefined;
}

export interface BrokerOptions {
  /** Per-run shared secret. Required: the broker rejects every request
   *  whose `Proxy-Authorization: Basic <base64(ordin:<secret>)>` doesn't
   *  match. The harness passes the same secret via srt's parentProxy
   *  URL userinfo so srt forwards the header on every proxied request. */
  readonly proxyAuth: string;
  /** Bind address. Defaults to 127.0.0.1 (loopback only). */
  readonly host?: string;
  /** Bind port. Defaults to 0 (OS-assigned). Use a fixed port for tests. */
  readonly port?: number;
  /** Override env for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Internal services to register alongside the forward services
   *  derived from `servicesConfig`. */
  readonly internalServices?: readonly InternalService[];
  /** Called for every egress event the broker observes. */
  readonly onEgress?: (event: BrokerEgressEvent) => void;
  /**
   * Decision hook for hosts that aren't in the static `local_services`
   * map. srt's `sandboxAskCallback` routes through `askApproval`, which
   * caches the answer for the broker's lifetime and consults this hook
   * on cache miss. The harness wires this to the CLI's egress gate
   * prompter; headless callers leave it unset and the broker denies.
   */
  readonly onEgressGate?: (req: EgressGateRequest) => Promise<boolean>;
  /**
   * Hosts the user already approved on previous runs. Pre-populated
   * from the per-project `egress.yaml` so the prompter is asked only
   * for genuinely new hosts. The broker treats these like in-run
   * cache hits — no audit "gate.requested" is emitted.
   */
  readonly preApprovedHosts?: readonly EgressGateRequest[];
}

const PROXY_AUTH_USER = "ordin";

export class Broker {
  readonly services: readonly BrokerService[];
  private readonly map: ReadonlyMap<string, BrokerService>;
  private readonly forwardServer: Server;
  private readonly bindHost: string;
  private bindPort: number;
  private readonly onEgress?: (event: BrokerEgressEvent) => void;
  private readonly onEgressGate?: (req: EgressGateRequest) => Promise<boolean>;
  private readonly proxyAuth: string;
  private readonly expectedAuth: string;
  /**
   * Hosts the user has approved this run. Lookup key is "host:port" so
   * an approval for `example.com:443` doesn't auto-approve port 80
   * (different surface). The user's mental model is closer to "service
   * endpoint" than "hostname"; pairing with port matches that.
   *
   * In-flight gates are tracked by the same key so two concurrent
   * requests for the same endpoint share a single prompt instead of
   * stacking duplicates.
   */
  private readonly approvedHosts = new Set<string>();
  private readonly inFlightGates = new Map<string, Promise<boolean>>();

  constructor(servicesConfig: LocalServicesConfig, options: BrokerOptions) {
    if (!options.proxyAuth) throw new Error("Broker: proxyAuth required");
    const forwards: ForwardService[] = parseForwards(servicesConfig, options.env ?? process.env);
    const internals: InternalService[] = [...(options.internalServices ?? [])];
    assertUniqueNames(forwards, internals);
    this.services = [...forwards, ...internals];
    this.map = new Map(this.services.map((s) => [s.name, s]));
    this.bindHost = options.host ?? "127.0.0.1";
    this.bindPort = options.port ?? 0;
    this.onEgress = options.onEgress;
    this.onEgressGate = options.onEgressGate;
    this.proxyAuth = options.proxyAuth;
    this.expectedAuth = `Basic ${Buffer.from(`${PROXY_AUTH_USER}:${options.proxyAuth}`).toString(
      "base64",
    )}`;
    for (const pre of options.preApprovedHosts ?? []) {
      this.approvedHosts.add(approvalKey(pre.host, pre.port));
    }
    this.forwardServer = createServer();
    this.forwardServer.on("request", (req, res) => this.onRequest(req, res));
    this.forwardServer.on("connect", (req, sock, head) => {
      this.onConnect(req, sock, head).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[broker] CONNECT handler threw: ${msg}`);
        if (!sock.destroyed) sock.destroy();
      });
    });
    this.forwardServer.on("error", (err) => {
      // Server-level errors (bind failures, accept errors). Bind
      // failures surface via `start()`'s `once("error")`; accept
      // errors are runtime anomalies worth a log but not fatal.
      console.warn(`[broker] server error: ${err.message}`);
    });
  }

  /** Address the broker is bound to. Valid only after `start()` resolves. */
  get host(): string {
    return this.bindHost;
  }
  get port(): number {
    return this.bindPort;
  }
  /** URL for srt's `parentProxy.http` field. Includes userinfo so srt
   *  forwards `Proxy-Authorization: Basic <…>` on every proxied request. */
  proxyUrl(): string {
    return `http://${PROXY_AUTH_USER}:${encodeURIComponent(this.proxyAuth)}@${this.bindHost}:${this.bindPort}`;
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

  /**
   * srt's `sandboxAskCallback` entry point. Returns true iff the
   * request should be allowed through srt's filter (and therefore
   * forwarded to us via parentProxy). Cache hit → answer immediately;
   * cache miss → emit gate.requested, ask the harness's hook, cache,
   * emit gate.decided. Local-service names (in `this.map`) are
   * auto-approved without prompting — they're explicit policy in
   * `local_services` config.
   */
  async askApproval(host: string, port: number | undefined): Promise<boolean> {
    if (this.map.has(host)) return true;
    const key = approvalKey(host, port);
    if (this.approvedHosts.has(key)) return true;
    const inFlight = this.inFlightGates.get(key);
    if (inFlight) return inFlight;
    if (!this.onEgressGate) {
      this.emit({ kind: "broker.gate.decided", payload: { host, port, approved: false } });
      return false;
    }
    this.emit({ kind: "broker.gate.requested", payload: { host, port } });
    const decision = (async () => {
      try {
        const approved = await this.onEgressGate?.({ host, port });
        if (approved) this.approvedHosts.add(key);
        this.emit({
          kind: "broker.gate.decided",
          payload: { host, port, approved: !!approved },
        });
        return !!approved;
      } finally {
        this.inFlightGates.delete(key);
      }
    })();
    this.inFlightGates.set(key, decision);
    return decision;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.headers["proxy-authorization"] !== this.expectedAuth) {
      res.writeHead(407, {
        "Content-Type": "text/plain",
        "Proxy-Authenticate": 'Basic realm="ordin-broker"',
      });
      res.end("ordin-broker: proxy auth required");
      return;
    }
    // Two shapes arrive here:
    //   1. Proxy form (srt → broker): req.url is absolute,
    //      `http://otel/api/...`.
    //   2. Direct form (test client / inner-direct): req.url is
    //      path-only and the hostname lives in the Host header.
    // We accept both by deriving hostname from the Host header when
    // req.url is path-only.
    const url = req.url ? resolveRequestUrl(req.url, req.headers.host) : undefined;
    const hostname = url?.hostname;
    if (!url || !hostname) {
      this.emit({
        kind: "broker.forward.denied",
        payload: { hostname: hostname ?? null, reason: "malformed" },
      });
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("ordin-broker: malformed request");
      return;
    }
    const target = this.map.get(hostname);
    if (!target) {
      // No static mapping. The host may still be approved this run via
      // the egress gate (srt's askCallback → broker.askApproval). When
      // so, passthrough-forward to the original host on the URL's port
      // (defaulting to 80 for plain HTTP). External hosts don't get
      // auth injection — that's reserved for explicit local_services.
      const port = url.port ? Number.parseInt(url.port, 10) : 80;
      if (this.approvedHosts.has(approvalKey(hostname, port))) {
        this.passthroughForward(req, res, hostname, port, url);
        return;
      }
      this.emit({
        kind: "broker.forward.denied",
        payload: { hostname, reason: "no mapping" },
      });
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("ordin-broker: no mapping");
      return;
    }
    if (target.kind === "internal") {
      Promise.resolve(target.handler(req, res)).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`ordin-broker: internal handler error: ${errMessage(err)}`);
        }
      });
      return;
    }
    this.emit({
      kind: "broker.forward",
      payload: {
        service: target.name,
        method: req.method ?? "",
        path: `${url.pathname}${url.search}`,
      },
    });
    // Spread order matters: req.headers first, then host override (so
    // the upstream sees the destination, not the broker), then authHeader
    // last (overrides anything the inner may have set). Strip
    // proxy-authorization (hop-by-hop, RFC 7230 §6.1) so our auth
    // secret never reaches upstream.
    const headers: NodeJS.Dict<string | string[]> = {
      ...req.headers,
      host: `${target.host}:${target.port}`,
      ...(target.authHeader ? { authorization: target.authHeader } : {}),
    };
    delete headers["proxy-authorization"];
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
    upstream.on("error", (err) => {
      console.warn(
        `[broker] upstream error forwarding to ${target.name} (${target.host}:${target.port}): ${err.message}`,
      );
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("ordin-broker: upstream error");
    });
  }

  private async onConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (req.headers["proxy-authorization"] !== this.expectedAuth) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="ordin-broker"\r\n\r\n',
      );
      return;
    }
    const hostport = req.url ?? "";
    const [host = "", portStr = ""] = hostport.split(":");
    const port = Number.parseInt(portStr, 10);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      this.emit({
        kind: "broker.connect.denied",
        payload: { hostport, reason: "malformed" },
      });
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    // Non-mapped destinations gate via `askApproval` so the broker
    // remains the trust boundary for *both* transports: under srt the
    // outer proxy already asked and cached the answer, so this is a
    // fast cache hit. Under `broker` mode (no srt) this is the only
    // place the egress prompt fires for HTTPS CONNECTs.
    if (!this.map.has(host)) {
      const approved = await this.askApproval(host, port);
      if (!approved) {
        this.emit({
          kind: "broker.connect.denied",
          payload: { host, port, reason: "egress-deny" },
        });
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
    }
    this.emit({ kind: "broker.connect", payload: { host, port } });
    const upstream = netConnect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (err) => {
      console.warn(`[broker] CONNECT upstream error ${host}:${port}: ${err.message}`);
      client.destroy();
    });
    client.on("error", (err) => {
      // Client (inner-side) socket errors during a tunnel are routine
      // (client disconnect, timeout). Log at warn; tear down upstream.
      console.warn(`[broker] CONNECT client error ${host}:${port}: ${err.message}`);
      upstream.destroy();
    });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  }

  /**
   * Forward a request to the original (host, port) without auth
   * injection or Host rewrite. Used for hosts approved via the egress
   * gate that have no static `local_services` mapping (external sites
   * like github.com). Auth is the inner's responsibility; the broker
   * exists here only for visibility (audit) and as the post-srt fan-in
   * point.
   */
  private passthroughForward(
    req: IncomingMessage,
    res: ServerResponse,
    host: string,
    port: number,
    url: URL,
  ): void {
    this.emit({
      kind: "broker.forward",
      payload: {
        service: "passthrough",
        host,
        port,
        method: req.method ?? "",
        path: `${url.pathname}${url.search}`,
      },
    });
    const headers: NodeJS.Dict<string | string[]> = {
      ...req.headers,
      host: url.port ? `${host}:${port}` : host,
    };
    delete headers["proxy-authorization"];
    const upstream = request({
      host,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
    });
    req.pipe(upstream);
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (err) => {
      console.warn(`[broker] passthrough upstream error ${host}:${port}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("ordin-broker: upstream error");
      }
    });
  }

  private emit(event: BrokerEgressEvent): void {
    if (!this.onEgress) return;
    try {
      this.onEgress(event);
    } catch (err) {
      // Audit observation must never destabilize the proxy: log and
      // continue rather than throwing into the HTTP request loop. The
      // log lets us notice if the audit sink starts failing.
      console.warn(`[broker] onEgress threw for ${event.kind}: ${errMessage(err)}`);
    }
  }
}

function parseForwards(raw: LocalServicesConfig, env: NodeJS.ProcessEnv): ForwardService[] {
  return Object.entries(raw).map(([name, cfg]) => {
    const [host = "", portStr = ""] = cfg.target.split(":");
    const authHeader = cfg.auth ? buildAuthHeader(name, cfg.auth, env) : undefined;
    return {
      kind: "forward",
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

function assertUniqueNames(
  forwards: readonly ForwardService[],
  internals: readonly InternalService[],
): void {
  const seen = new Set<string>();
  for (const s of [...forwards, ...internals]) {
    if (seen.has(s.name)) {
      throw new Error(
        `Broker service name collision: "${s.name}" is registered as both a forward service (local_services) and an internal service. Internal service names must not appear in local_services config.`,
      );
    }
    seen.add(s.name);
  }
}

/**
 * Resolve the destination URL from an incoming request. Two shapes
 * accepted:
 *   - Proxy form (srt → broker): `req.url` is absolute.
 *   - Direct form (test client / inner-direct): `req.url` is path-only,
 *     hostname comes from the `Host` header.
 * Returns undefined only when neither form parses — a structurally
 * malformed request that the caller should reject with 4xx.
 */
function resolveRequestUrl(reqUrl: string, hostHeader?: string): URL | undefined {
  if (URL.canParse(reqUrl)) return new URL(reqUrl);
  if (hostHeader && URL.canParse(reqUrl, `http://${hostHeader}`)) {
    return new URL(reqUrl, `http://${hostHeader}`);
  }
  return undefined;
}

function approvalKey(host: string, port: number | undefined): string {
  return `${host}:${port ?? ""}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
