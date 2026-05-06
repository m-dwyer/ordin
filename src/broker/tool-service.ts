import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecordedResult, ToolIntent } from "./client/types";
import type { BrokerDispatch } from "./dispatch";

/**
 * Adapter from Broker's internal-service HTTP surface to
 * `BrokerDispatch`. Worker-side `HttpBrokerClient` POSTs each leg of
 * a tool dispatch to the broker; the broker routes by hostname (`tools`)
 * and invokes this handler.
 *
 * Wire shape:
 *
 *   POST /dispatch/request
 *   Body: ToolIntent
 *   → 200 OK { ok: true } | { ok: false, error: ToolError }
 *
 *   POST /dispatch/result
 *   Body: { intent: ToolIntent, recorded: RecordedResult }
 *   → 204 No Content
 *
 * Tool execution itself happens worker-side (ADR-016 corrected) — the
 * broker never invokes an executor. Errors that aren't policy
 * decisions (bad method, malformed JSON) surface as 4xx; policy
 * decisions ride inside the body.
 */

const REQUEST_PATH = "/dispatch/request";
const RESULT_PATH = "/dispatch/result";

export function makeToolServiceHandler(
  dispatch: BrokerDispatch,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: { kind: "method_not_allowed", message: "POST required" } });
      return;
    }
    const path = parsePath(req.url);
    const body = await readBody(req).catch((err) => err as Error);
    if (body instanceof Error) {
      writeJson(res, 400, { error: { kind: "body_read_failed", message: body.message } });
      return;
    }
    if (path === REQUEST_PATH) {
      const intent = parseJson<ToolIntent>(body);
      if (intent instanceof Error) {
        writeJson(res, 400, {
          error: { kind: "json_parse_failed", message: intent.message },
        });
        return;
      }
      const approval = await dispatch.requestApproval(intent);
      writeJson(res, 200, approval);
      return;
    }
    if (path === RESULT_PATH) {
      const parsed = parseJson<{ intent: ToolIntent; recorded: RecordedResult }>(body);
      if (parsed instanceof Error) {
        writeJson(res, 400, {
          error: { kind: "json_parse_failed", message: parsed.message },
        });
        return;
      }
      await dispatch.recordResult(parsed.intent, parsed.recorded);
      res.writeHead(204);
      res.end();
      return;
    }
    writeJson(res, 404, {
      error: { kind: "not_found", message: `Unknown path: ${path ?? "(none)"}` },
    });
  };
}

function parsePath(reqUrl: string | undefined): string | undefined {
  if (!reqUrl) return undefined;
  if (reqUrl.startsWith("http")) {
    try {
      return new URL(reqUrl).pathname;
    } catch {
      return undefined;
    }
  }
  return reqUrl.split("?")[0];
}

function parseJson<T>(text: string): T | Error {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
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
