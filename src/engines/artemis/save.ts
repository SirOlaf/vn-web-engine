import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisVariables} from './variables.js';

export interface ArtemisSaveEffects {
  /** Native onSave is called only for a nonempty scenario filename, before its snapshot. */
  beforeScenario(file: string): void;
  reportEventError(error: unknown): void;
  writeScenario(file: string, includeTransientState: boolean): void;
  writeGlobal(): void;
  writeSystem(): void;
}

/** 0x14013f390 save gate. Serialization/storage remain required host services. */
export class ArtemisSave {
  constructor(
    private readonly variables: ArtemisVariables,
    private readonly effects: ArtemisSaveEffects,
  ) {}
  request(file: string, includeTransientState = false, forceGlobal = false): boolean {
    if (!file && !forceGlobal && !this.variables.globalDirty) return false;
    if (file) {
      try {
        this.effects.beforeScenario(file);
      } catch (error) {
        this.effects.reportEventError(error);
      }
      this.effects.writeScenario(file, includeTransientState);
    }
    if (forceGlobal || this.variables.globalDirty) {
      this.effects.writeGlobal();
      // Native clears g. dirty immediately after saveg.dat, before writing system.dat.
      this.variables.clearGlobalDirty();
      this.effects.writeSystem();
    }
    return true;
  }
  /** Save tag 0x1400ca5b0: file (absent reads as empty), then the gate with transient state
   * and a forced global save (R8 = R9 = 1). An empty file writes only saveg.dat/system.dat. */
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'save') return false;
    this.request(tag.args.get('file') ?? '', true, true);
    return true;
  }
}
