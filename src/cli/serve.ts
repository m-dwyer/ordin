import type { Command } from "commander";
import { createHttpApp, isLoopbackHost, startHttpServer, tokenFromEnv } from "../http";
import { RunService } from "../run-service/run-service";
import { printBlank, printHint, printKeyValue, printSectionDivider, styled } from "./tui/print";
import { PALETTE } from "./tui/theme";

/**
 * `ordin serve` — boots the HTTP transport over `RunService`. Runs in the
 * foreground until SIGINT/SIGTERM, then closes the server cleanly.
 *
 * Auth policy: a bearer token (`ORDIN_API_TOKEN` env var) enables
 * `Authorization: Bearer <token>` enforcement. Without a token the
 * server refuses to bind to non-loopback hosts — exposing an
 * unauthenticated server externally is the obvious footgun.
 */
export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("Run the HTTP server (POST /runs, SSE /runs/:id/events, /openapi.json)")
    .option("-p, --port <port>", "TCP port", parsePort, 8787)
    .option("-h, --host <host>", "Bind host", "127.0.0.1")
    .action(async (opts: { port: number; host: string }) => {
      const token = tokenFromEnv();
      if (!token && !isLoopbackHost(opts.host)) {
        process.stderr.write(
          `${styled("✗", PALETTE.failed)} serve refused to bind to non-loopback host ${opts.host} without ORDIN_API_TOKEN.\n` +
            `  ${styled("Set ORDIN_API_TOKEN to enable bearer-token auth, or bind to 127.0.0.1.", PALETTE.hint)}\n`,
        );
        process.exit(2);
      }

      const service = new RunService();
      const app = createHttpApp(service, token ? { auth: { token } } : {});
      const server = await startHttpServer(app, { port: opts.port, hostname: opts.host });

      const url = `http://${server.hostname}:${server.port}`;
      const authMode = token ? "bearer-token (ORDIN_API_TOKEN)" : "none (loopback only)";
      printSectionDivider(`serve ─ ${url}`);
      printBlank();
      printKeyValue("auth:", authMode);
      printKeyValue("docs:", `${url}/docs`);
      printKeyValue("openapi:", `${url}/openapi.json`);
      printKeyValue("runs:", `POST ${url}/runs`);
      printKeyValue("events:", `GET ${url}/runs/:runId/events`);
      printBlank();

      const stop = async (signal: NodeJS.Signals) => {
        printBlank();
        printHint(`serve · received ${signal}, closing`);
        await server.close();
        process.exit(0);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}
