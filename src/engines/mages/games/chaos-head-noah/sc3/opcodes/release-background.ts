import type {OpcodeExecution} from './types.js';

function oneHotIndex(value: number): number {
  value >>>= 0;
  for (let index = 0; index < 16; index++) if (value === (1 << index) >>> 0) return index;
  return -1;
}

/** 10/10, 140059ed0: release one background surface and clear its guest slot. */
export function releaseBackground(h: OpcodeExecution): void {
  const s = h.state;
  if (s.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  h.skip(2);
  const index = oneHotIndex(h.expression()),
    target = s.variable(0x3520 / 4 + index);
  s.setVariable(0x466c / 4 + index * 40, 65535);
  s.setVariable(3000 + index * 2, 0);
  s.setVariable(3001 + index * 2, 0);
  h.textures.release(target);
}
