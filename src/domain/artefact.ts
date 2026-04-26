/**
 * Artefact = a markdown file on disk in the target repo.
 *
 * The harness does not track artefact state in a custom ledger —
 * git history and file timestamps are the ledger. This class only
 * offers thin helpers for reading artefacts after a phase completes
 * and ensuring parent directories exist when a phase's agent writes.
 */
export interface Artefact {
  readonly path: string;
  readonly content: string;
  readonly modifiedAt: number;
}
