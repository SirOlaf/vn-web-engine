import type {OpcodeExecution} from './types.js';

function oneHotIndex(value: number): number {
  value >>>= 0;
  for (let index = 0; index < 16; index++) if (value === (1 << index) >>> 0) return index + 1;
  return 0;
}

/** 10/2a, 14005b310: encode one of four compositor descriptors. */
export function setCompositionDescriptor(h: OpcodeExecution): void {
  h.skip(2);
  const index = h.byte(),
    enabled = h.expression(),
    middleMask = h.expression(),
    lowMask = h.expression();
  let value = 0;
  if (enabled !== 0) {
    const low = (oneHotIndex(lowMask) - 1) | 0,
      middle = (oneHotIndex(middleMask) - 1) | 0;
    value = ((enabled << 16) + low + (middle << 8)) | 0;
  }
  if (index < 4) h.state.setVariable((0x5aa0 + index * 0x50) / 4, value);
}
