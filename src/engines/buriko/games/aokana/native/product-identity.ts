import type {AokanaBpPointer} from '../bp/memory.js';

/** 0011E0 initializes DCString 1CC518; EDA00 exposes this shared product identifier. */
export class AokanaProductIdentity {
  readonly bytes = new TextEncoder().encode('AoNoKanataNoFourRhythmUEDL\0');

  pointer(): AokanaBpPointer {
    return {bytes: this.bytes, offset: 0};
  }
}
