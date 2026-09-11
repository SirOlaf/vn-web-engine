import {releaseCompositionResource} from '../composition-resources.js';
import type {OpcodeExecution} from './types.js';

function oneHotIndex(value: number): number {
  value >>>= 0;
  for (let index = 0; index < 16; index++) if (value === (1 << index) >>> 0) return index;
  return -1;
}

/** 10/11, 140059f90: release one character surface and its compositor resource. */
export function releaseCharacter(h: OpcodeExecution): void {
  const s = h.state;
  if (s.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  h.skip(2);
  const index = oneHotIndex(h.expression()),
    target = s.variable(0x35e8 / 4 + index);
  s.setVariable(0x4fd4 / 4 + index * 40, 65535);
  h.textures.release(target);
  releaseCompositionResource(s, target);
}
