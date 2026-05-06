import type { IncomingMessage, ServerResponse } from "node:http";
import type { ToolIntent, ToolResult } from "./client/types";
import type { BrokerDispatch } from "./dispatch";

/**
 * Adapter from Broker's internal-service HTTP surface to
 * `BrokerDispatch.dispatchTool`. Worker-side `HttpBrokerClient` POSTs
 * `ToolIntent` JSON to `http://tools/dispatch`; the broker routes by
 * hostname and invokes this handler.
 *
 * Wire shape:
 *   POST /dispatch
 *   Content-Type: application/json
 *   Body: ToolIntent (JSON)
 *
 *   200 OK
 *   Content-Type: application/json
 *   Body: ToolResult (JSON)
 *
 * Errors that aren't tool-execution errors (bad method, malformed JSON)
 * surface as 4xx/5xx; tool-execution errors travel inside the
 * `ToolResult` body so the contract test can pin them across both
 * transports without distinguishing transport vs policy failures.
 */

const DISPATCH_PATH = "/dispatch";

export function makeToolServiceHandler(
  dispatch: BrokerDispatch,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: { kind: "method_not_allowed", message: "POST required" } });
      return;
    }
    const url = req.url ?? "";
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
    if (path !== DISPATCH_PATH) {
      writeJson(res, 404, {
        error: { kind: "not_found", message: `Unknown path: ${path ?? "(none)"}` },
      });
      return;
    }
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      writeJson(res, 400, {
        error: { kind: "body_read_failed", message: errMessage(err) },
      });
      return;
    }
    let intent: ToolIntent;
    try {
      intent = JSON.parse(body) as ToolIntent;
    } catch (err) {
      writeJson(res, 400, {
        error: { kind: "json_parse_failed", message: errMessage(err) },
      });
      return;
    }
    const result: ToolResult = await dispatch.dispatchTool(intent);
    writeJson(res, 200, result);
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
