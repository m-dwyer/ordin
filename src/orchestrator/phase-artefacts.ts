import type { ArtefactPointer } from "../domain/composer";
import { resolveArtefacts } from "../domain/phase-preview";
import type { Phase } from "../domain/workflow";
import { ArtefactManager } from "../infrastructure/artefact-manager";

export interface PhaseArtefacts {
  readonly inputs: readonly ArtefactPointer[];
  readonly outputs: readonly ArtefactPointer[];
}

export class PhaseArtefactVerifier {
  private readonly artefacts: ArtefactManager;

  constructor(workspaceRoot: string) {
    this.artefacts = new ArtefactManager(workspaceRoot);
  }

  resolve(phase: Phase, slug: string): PhaseArtefacts {
    return {
      inputs: resolveArtefacts(phase.inputs, slug),
      outputs: resolveArtefacts(phase.outputs, slug),
    };
  }

  findMissing(artefacts: readonly ArtefactPointer[]): Promise<readonly ArtefactPointer[]> {
    return this.artefacts.findMissing(artefacts);
  }
}

export function formatMissing(
  suffix: string,
  phase: Phase,
  missing: readonly ArtefactPointer[],
): string {
  return `Phase "${phase.id}" declared ${suffix}: ${missing.map((m) => m.path).join(", ")}`;
}
