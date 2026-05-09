/**
 * Run slug rule. Lowercase kebab-case identifier used to resolve
 * per-run artefact paths (e.g. `docs/rfcs/{slug}-rfc.md`). Domain
 * concern: the same shape constrains filesystem paths, audit chain
 * keys, and human-readable run names across every adapter layer.
 */
export function requireSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}": use lowercase kebab-case (e.g. "add-user-search")`);
  }
  return slug;
}
