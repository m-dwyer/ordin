import type { z } from "@hono/zod-openapi";
import type {
  GateDecisionSchema,
  PendingGateSchema,
  PhasePreviewSchema,
  RunMetaSchema,
  StartRunRequestSchema,
} from "../http/schemas";
import type { RunEvent } from "../runtime/harness";

/**
 * Hand-written HTTP client over the routes in `src/http/`. Same wire
 * format as the server's zod schemas — types come from `z.infer<typeof
 * Schema>` so server and client never drift on response shape.
 *
 * SSE parsing is inline (one consumer for now). When we generate an
 * SDK from `/openapi.json` later, this file becomes the place we wrap
 * the generated client; the public surface of `OrdinHttpClient` stays
 * unchanged so callers (CLI, future tests) don't need to update.
 */
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
export type RunMeta = z.infer<typeof RunMetaSchema>;
export type PendingGate = z.infer<typeof PendingGateSchema>;
export type PhasePreview = z.infer<typeof PhasePreviewSchema>;
export type GateDecision = z.infer<typeof GateDecisionSchema>;

export interface OrdinHttpClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  /** Override fetch (tests). Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export class OrdinHttpClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OrdinHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    if (opts.token) this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async startRun(input: StartRunRequest): Promise<{ runId: string }> {
    return this.json("POST", "/runs", input);
  }

  async previewRun(input: StartRunRequest): Promise<PhasePreview[]> {
    return this.json("POST", "/preview", input);
  }

  async listRuns(): Promise<RunMeta[]> {
    return this.json("GET", "/runs");
  }

  async getRun(runId: string): Promise<RunMeta> {
    return this.json("GET", `/runs/${encodeURIComponent(runId)}`);
  }

  async pendingGates(runId: string): Promise<PendingGate[]> {
    return this.json("GET", `/runs/${encodeURIComponent(runId)}/gates`);
  }

  async resolveGate(
    runId: string,
    phaseId: string,
    decision: GateDecision,
  ): Promise<{ resolved: boolean }> {
    return this.json(
      "POST",
      `/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(phaseId)}/decide`,
      decision,
    );
  }

  async *subscribe(runId: string, signal?: AbortSignal): AsyncIterable<RunEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      headers: { ...this.authHeaders(), Accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw await this.toError(res);
    if (!res.body) throw new Error("SSE response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        yield JSON.parse(dataLine.slice(6)) as RunEvent;
      }
    }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.authHeaders(),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as T;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async toError(res: Response): Promise<Error> {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? "";
    } catch {
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
    }
    return new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
}
