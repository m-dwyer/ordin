import { bearerAuth } from "hono/bearer-auth";
import type { MiddlewareHandler } from "hono/types";

/**
 * Bearer-token auth. Token is read from `ORDIN_API_TOKEN` (or supplied
 * explicitly to `createHttpApp`). Hono's `bearerAuth` does the
 * timing-safe comparison; we just decide whether to wire it up.
 *
 * Loopback-only enforcement is policy that lives in the CLI (`ordin
 * serve`) — the app itself doesn't know what address it's bound to.
 */
export interface AuthConfig {
  /** Bearer token required on `Authorization`. If unset, no auth. */
  readonly token?: string;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env["ORDIN_API_TOKEN"]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function bearerAuthMiddleware(token: string): MiddlewareHandler {
  return bearerAuth({ token });
}
