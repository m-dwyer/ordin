/**
 * Read-side artefact lookup the orchestrator needs to enforce the
 * Artefact Contract (CONTEXT.md): given a list of declared inputs or
 * outputs, report which paths are missing from disk. The concrete
 * implementation (`ArtefactManager` in `src/infrastructure/`) is
 * injected by the composition root via `EngineServices.artefactStore`
 * so orchestrator code stays free of disk-loader imports.
 */
export interface ArtefactStore {
  findMissing<T extends { readonly path: string }>(artefacts: readonly T[]): Promise<readonly T[]>;
}
