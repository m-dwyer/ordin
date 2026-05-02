import { z } from "zod";

/**
 * Network policy describing which hostnames the agent may reach via
 * srt's HTTP/SOCKS proxies. Patterns follow srt semantics: literal
 * hostnames or wildcards (`*.github.com`). Default is empty — every
 * external host is denied. Local services declared in the broker's
 * `local_services` map are auto-added so srt's filter approves them
 * before routing to the mitmProxy socket.
 */
export const NetworkPolicySchema = z.object({
  allowedDomains: z.array(z.string().min(1)).default([]),
  deniedDomains: z.array(z.string().min(1)).default([]),
});
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export interface DefaultPolicyInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly localServiceNames?: readonly string[];
}

export function defaultPolicy(input: DefaultPolicyInput = {}): NetworkPolicy {
  const allowed = new Set<string>(input.localServiceNames ?? []);
  return {
    allowedDomains: [...allowed],
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
