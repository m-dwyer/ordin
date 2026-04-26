import { type ServerType, serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Node-specific server adapter. The Hono app itself is runtime-portable
 * (Node, Bun, Deno, Workers); only this file binds to `@hono/node-server`.
 * On Bun we'd ship a sibling `server-bun.ts` calling `Bun.serve()` and
 * select between them in the CLI.
 */
export interface StartHttpOptions {
  readonly port?: number;
  readonly hostname?: string;
}

export interface RunningHttpServer {
  readonly port: number;
  readonly hostname: string;
  close(): Promise<void>;
}

export async function startHttpServer(
  app: OpenAPIHono,
  opts: StartHttpOptions = {},
): Promise<RunningHttpServer> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const requestedPort = opts.port ?? 8787;

  return new Promise<RunningHttpServer>((resolve, reject) => {
    let server: ServerType | undefined;
    server = serve({ fetch: app.fetch, port: requestedPort, hostname }, (info) => {
      if (!server) return;
      resolve({
        port: info.port,
        hostname: info.address,
        close: () => closeServer(server as ServerType),
      });
    });
    server.on("error", reject);
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
