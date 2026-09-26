import type {BurikoBpPointer} from '../bp/memory.js';

/** 0011E0 initializes DCString 1CC518; EDA00 exposes this shared product identifier. */
export class BurikoProductIdentity {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array = Uint8Array.of(0)) {
    const end = bytes.indexOf(0);
    if (end < 0) throw new Error('Buriko product identity must be NUL-terminated');
    this.bytes = bytes.slice(0, end + 1);
  }

  pointer(): BurikoBpPointer {
    return {bytes: this.bytes, offset: 0};
  }
}
