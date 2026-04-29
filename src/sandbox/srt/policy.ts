import { z } from "zod";

/**
 * Network policy describing which hostnames the agent process tree may
 * reach. Translated into srt's `network.allowedDomains` /
 * `network.deniedDomains` at run time. Patterns follow srt semantics:
 * literal hostnames (`api.anthropic.com`) or wildcard (`*.github.com`).
 *
 * Default is LiteLLM-only — every other host is denied. LiteLLM at
 * `localhost:4000` is reachable without an allowlist entry because srt
 * sets `NO_PROXY=localhost,127.0.0.1,::1,...` for the wrapped process,
 * and the kernel profile permits localhost. `api.anthropic.com` is
 * allowlisted so `ClaudeCliRuntime` (Max-plan auth, ADR-006) keeps
 * working.
 */
export const NetworkPolicySchema = z.object({
  allowedDomains: z.array(z.string().min(1)).default([]),
  deniedDomains: z.array(z.string().min(1)).default([]),
});
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export function defaultLiteLlmOnlyPolicy(): NetworkPolicy {
  return {
    allowedDomains: ["api.anthropic.com"],
    deniedDomains: [],
  };
}

/**
 * Merge user-supplied additional allowlist entries (e.g. from a
 * repeatable `--allow-domain` CLI flag) into a base policy. Duplicates
 * are de-duplicated; user entries lose to the base on the deny side
 * (i.e. you cannot un-deny a host via `--allow-domain`).
 */
export function mergePolicy(
  base: NetworkPolicy,
  extra: { readonly allowedDomains?: readonly string[] },
): NetworkPolicy {
  const allowed = new Set([...base.allowedDomains, ...(extra.allowedDomains ?? [])]);
  return {
    allowedDomains: [...allowed],
    deniedDomains: [...base.deniedDomains],
  };
}
