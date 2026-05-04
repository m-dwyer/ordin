import { setDefaultResultOrder } from "node:dns";

/**
 * Run at the very start of every sandboxed worker before any HTTP
 * client fires. Two side effects:
 *
 *   - Bun's `http`/`fetch` polyfill natively honors `NO_PROXY`, which
 *     srt sets to `localhost,127.0.0.1,...`. Under the sandbox, "skip
 *     proxy and go direct" means "kernel-blocked" — we want everything
 *     to flow through srt's proxy so its allowlist gates traffic.
 *   - Mirror the parent's `ipv4first` DNS preference so `HTTP_PROXY`
 *     env actually reaches the IPv4-only proxy listener.
 *
 * No-op when `SANDBOX_RUNTIME` isn't set (i.e., the parent or any
 * unsandboxed process).
 */
export function prepareInnerProcess(env: NodeJS.ProcessEnv = process.env): void {
  if (env["SANDBOX_RUNTIME"] !== "1") return;
  delete env["NO_PROXY"];
  delete env["no_proxy"];
  setDefaultResultOrder("ipv4first");
}
