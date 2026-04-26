import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { streamSSE } from "hono/streaming";
import type { RunService } from "../run-service/run-service";
import { type AuthConfig, bearerAuthMiddleware } from "./auth";
import {
  ErrorSchema,
  GateDecisionSchema,
  PendingGateSchema,
  PhasePreviewSchema,
  ResolveGateResponseSchema,
  RunIdResponseSchema,
  RunMetaSchema,
  StartRunRequestSchema,
} from "./schemas";
import { toPendingGateWire, toPhasePreviewWire } from "./wire";

/**
 * HTTP transport over `RunService`. Routes are defined with
 * `@hono/zod-openapi` so a typed SDK can be generated from
 * `/openapi.json`. The SSE stream at `/runs/:runId/events` is registered
 * on the underlying Hono instance — it isn't a JSON response, so it
 * stays out of the OpenAPI surface.
 *
 * Server start lives in `./server.ts` (Node-specific via
 * `@hono/node-server`); on Bun the same `OpenAPIHono` app is fed to
 * `Bun.serve()` and routes are unchanged.
 */
export interface CreateHttpAppOptions {
  readonly auth?: AuthConfig;
}

/**
 * `/docs` (Scalar UI) and `/openapi.json` are intentionally public — they
 * advertise the API surface, never data, and a browser can't paste a
 * bearer token before navigating. Scalar's auth panel collects the token
 * client-side and includes it on protected try-it-out calls.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/docs", "/openapi.json"]);

export function createHttpApp(service: RunService, opts: CreateHttpAppOptions = {}): OpenAPIHono {
  const app = new OpenAPIHono();

  if (opts.auth?.token) {
    const middleware = bearerAuthMiddleware(opts.auth.token);
    app.use("*", async (c, next) => {
      if (PUBLIC_PATHS.has(c.req.path)) return next();
      return middleware(c, next);
    });
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/runs",
      tags: ["runs"],
      request: {
        body: {
          content: { "application/json": { schema: StartRunRequestSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: RunIdResponseSchema } },
          description: "Run started",
        },
        400: {
          content: { "application/json": { schema: ErrorSchema } },
          description: "Invalid request",
        },
      },
    }),
    async (c) => {
      try {
        const input = c.req.valid("json");
        const runId = await service.startRun(input);
        return c.json({ runId }, 200);
      } catch (err) {
        return c.json({ error: errorMessage(err) }, 400);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/runs",
      tags: ["runs"],
      responses: {
        200: {
          content: { "application/json": { schema: z.array(RunMetaSchema) } },
          description: "Run list",
        },
      },
    }),
    async (c) => c.json(await service.listRuns(), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/runs/{runId}",
      tags: ["runs"],
      request: { params: z.object({ runId: z.string() }) },
      responses: {
        200: {
          content: { "application/json": { schema: RunMetaSchema } },
          description: "Run metadata",
        },
        404: {
          content: { "application/json": { schema: ErrorSchema } },
          description: "Not found",
        },
      },
    }),
    async (c) => {
      try {
        const { runId } = c.req.valid("param");
        return c.json(await service.getRun(runId), 200);
      } catch (err) {
        return c.json({ error: errorMessage(err) }, 404);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/runs/{runId}/gates",
      tags: ["gates"],
      request: { params: z.object({ runId: z.string() }) },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.array(PendingGateSchema) },
          },
          description: "Pending gates for this run",
        },
      },
    }),
    async (c) => {
      const { runId } = c.req.valid("param");
      return c.json(service.pendingGatesFor(runId).map(toPendingGateWire), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/runs/{runId}/gates/{phaseId}/decide",
      tags: ["gates"],
      request: {
        params: z.object({ runId: z.string(), phaseId: z.string() }),
        body: {
          content: { "application/json": { schema: GateDecisionSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: ResolveGateResponseSchema } },
          description: "Gate resolution result",
        },
      },
    }),
    async (c) => {
      const { runId, phaseId } = c.req.valid("param");
      const decision = c.req.valid("json");
      const resolved = service.resolveGate(runId, phaseId, decision);
      return c.json({ resolved }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/preview",
      tags: ["runs"],
      request: {
        body: {
          content: { "application/json": { schema: StartRunRequestSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: z.array(PhasePreviewSchema) } },
          description: "Composed phase previews",
        },
        400: {
          content: { "application/json": { schema: ErrorSchema } },
          description: "Invalid request",
        },
      },
    }),
    async (c) => {
      try {
        const input = c.req.valid("json");
        const previews = await service.previewRun(input);
        return c.json(previews.map(toPhasePreviewWire), 200);
      } catch (err) {
        return c.json({ error: errorMessage(err) }, 400);
      }
    },
  );

  app.get("/runs/:runId/events", (c) => {
    const runId = c.req.param("runId");
    let iterable: AsyncIterable<unknown>;
    try {
      iterable = service.subscribe(runId);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 404);
    }
    return streamSSE(c, async (stream) => {
      for await (const event of iterable) {
        await stream.writeSSE({
          event: (event as { type: string }).type,
          data: JSON.stringify(event),
        });
      }
    });
  });

  if (opts.auth?.token) {
    app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
      type: "http",
      scheme: "bearer",
    });
  }

  app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: { title: "ordin", version: "0.1.0" },
    ...(opts.auth?.token ? { security: [{ bearerAuth: [] }] } : {}),
  });

  app.get(
    "/docs",
    Scalar({
      url: "/openapi.json",
      pageTitle: "ordin API",
      persistAuth: true,
    }),
  );

  return app;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
