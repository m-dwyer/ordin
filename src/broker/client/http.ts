import { request } from "node:http";
import { HttpProxyAgent } from "http-proxy-agent";
import type { BrokerClient, ToolIntent, ToolResult } from "./types";

/**
 * HTTP transport for tool dispatch (ADR-018 Phase B). The worker runs
 * in a separate process from the broker (sandboxed runs, future
 * `ordin serve`); this client forwards each `ToolIntent` to the
 * broker's `tools` internal service over localhost HTTP via an
 * explicit HTTP proxy.
 *
 * Two deployment shapes route through the same code path:
 *
 *   - **Tests / non-srt subprocess.** `proxyUrl` is the broker's own
 *     listen URL with userinfo (`http://ordin:<secret>@127.0.0.1:port`).
 *     `HttpProxyAgent` opens TCP to the broker, sends a proxy-form
 *     request (`POST http://tools/dispatch HTTP/1.1`), and the broker's
 *     hostname-map routes it to the `tools` internal service.
 *
 *   - **srt sandbox.** srt's wrapper sets `HTTP_PROXY` to its own
 *     internal filter proxy (`http://localhost:<srt-port>`, no auth).
 *     `HttpProxyAgent` tunnels there; srt allowlist-checks `tools`,
 *     forwards via `parentProxy` (= broker), broker routes the same
 *     proxy-form request to its internal service. The per-run secret
 *     stays in srt's `parentProxy.http` userinfo — never reaches the
 *     worker.
 *
 * Wire shape mirrors `tool-service.ts`:
 *   POST /dispatch
 *   Body: ToolIntent (JSON)
 *
 *   200 OK { ok: true | false, output | error }
 *
 * The contract test (`broker-transport-parity.test.ts`) pins that the
 * `ToolResult` and audit envelope shape are identical between this and
 * `InProcessBrokerClient` for the same intent.
 *
 * Tool-execution errors travel inside `ToolResult` (ok=false). Genuine
 * transport failures (broker unreachable, malformed response) raise as
 * `BrokerTransportError` so callers can distinguish "policy denied" from
 * "transport broke".
 */

export interface HttpBrokerClientOptions {
  /**
   * HTTP proxy URL the worker tunnels through. Userinfo (when present)
   * is the broker's `Proxy-Authorization` secret. In srt mode the URL
   * has no userinfo — srt injects auth from its `parentProxy` config.
   */
  readonly proxyUrl: string;
  /**
   * Hostname the broker's hostname-map matches on. Default `tools` —
   * matches the internal service registered by the harness.
   */
  readonly serviceHost?: string;
  /** Override for tests. Defaults to `node:http.request`. */
  readonly httpRequest?: typeof request;
}

export class BrokerTransportError extends Error {
  override readonly name = "BrokerTransportError";
}

export class HttpBrokerClient implements BrokerClient {
  private readonly agent: HttpProxyAgent<string>;
  private readonly serviceHost: string;
  private readonly httpRequest: typeof request;

  constructor(opts: HttpBrokerClientOptions) {
    this.agent = new HttpProxyAgent(opts.proxyUrl);
    this.serviceHost = opts.serviceHost ?? "tools";
    this.httpRequest = opts.httpRequest ?? request;
  }

  dispatchTool(intent: ToolIntent): Promise<ToolResult> {
    const body = Buffer.from(JSON.stringify(intent), "utf8");
    return new Promise<ToolResult>((resolve, reject) => {
      const req = this.httpRequest(
        {
          agent: this.agent,
          host: this.serviceHost,
          port: 80,
          method: "POST",
          path: "/dispatch",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk as Buffer));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) {
              reject(
                new BrokerTransportError(
                  `Broker returned ${res.statusCode ?? "?"}: ${text || "(empty)"}`,
                ),
              );
              return;
            }
            try {
              const parsed = JSON.parse(text) as ToolResult;
              resolve(parsed);
            } catch (err) {
              reject(
                new BrokerTransportError(
                  `Broker returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            }
          });
          res.on("error", (err) =>
            reject(new BrokerTransportError(`Broker response stream error: ${err.message}`)),
          );
        },
      );
      req.on("error", (err) =>
        reject(new BrokerTransportError(`Broker request failed: ${err.message}`)),
      );
      req.write(body);
      req.end();
    });
  }
}
