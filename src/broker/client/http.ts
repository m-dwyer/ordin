import { request } from "node:http";
import { HttpProxyAgent } from "http-proxy-agent";
import type { ApprovalResult, BrokerClient, RecordedResult, ToolIntent } from "./types";

/**
 * HTTP transport for tool dispatch (ADR-018 Phase B / ADR-016
 * correction). The worker tunnels each tool call's two legs —
 * approval request + result record — through an HTTP proxy to the
 * broker's `tools` internal service.
 *
 * Two deployment shapes route through the same code path:
 *
 *   - **Tests / non-srt subprocess.** `proxyUrl` is the broker's own
 *     listen URL with userinfo (`http://ordin:<secret>@127.0.0.1:port`).
 *     `HttpProxyAgent` opens TCP to the broker, sends a proxy-form
 *     request (`POST http://tools/dispatch/request HTTP/1.1`), and
 *     the broker's hostname-map routes it to the `tools` internal
 *     service.
 *
 *   - **srt sandbox.** srt's wrapper sets `HTTP_PROXY` to its own
 *     internal filter proxy (`http://localhost:<srt-port>`, no auth).
 *     `HttpProxyAgent` tunnels there; srt allowlist-checks `tools`,
 *     forwards via `parentProxy` (= broker), broker routes the
 *     request. The per-run secret stays in srt's `parentProxy.http`
 *     userinfo — never reaches the worker.
 *
 * Wire shape mirrors `tool-service.ts`:
 *   POST /dispatch/request   Body: ToolIntent              → ApprovalResult
 *   POST /dispatch/result    Body: { intent, recorded }    → 204 No Content
 *
 * The contract test (`broker-transport-parity.test.ts`) pins that the
 * audit envelopes are identical between this and `InProcessBrokerClient`
 * for the same intents.
 *
 * Genuine transport failures (broker unreachable, malformed response)
 * raise as `BrokerTransportError` so callers can distinguish "policy
 * denied" from "transport broke".
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

  async requestApproval(intent: ToolIntent): Promise<ApprovalResult> {
    const text = await this.post("/dispatch/request", intent, {
      expectStatus: 200,
      expectBody: true,
    });
    try {
      return JSON.parse(text ?? "") as ApprovalResult;
    } catch (err) {
      throw new BrokerTransportError(
        `Broker returned malformed approval JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async recordResult(intent: ToolIntent, recorded: RecordedResult): Promise<void> {
    await this.post("/dispatch/result", { intent, recorded }, { expectStatus: 204 });
  }

  private post(
    path: string,
    body: unknown,
    options: { expectStatus: number; expectBody?: boolean },
  ): Promise<string | undefined> {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    return new Promise<string | undefined>((resolve, reject) => {
      const req = this.httpRequest(
        {
          agent: this.agent,
          host: this.serviceHost,
          port: 80,
          method: "POST",
          path,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": payload.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk as Buffer));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== options.expectStatus) {
              reject(
                new BrokerTransportError(
                  `Broker ${path} returned ${res.statusCode ?? "?"}: ${text || "(empty)"}`,
                ),
              );
              return;
            }
            resolve(options.expectBody ? text : undefined);
          });
          res.on("error", (err) =>
            reject(new BrokerTransportError(`Broker response stream error: ${err.message}`)),
          );
        },
      );
      req.on("error", (err) =>
        reject(new BrokerTransportError(`Broker request failed: ${err.message}`)),
      );
      req.write(payload);
      req.end();
    });
  }
}
