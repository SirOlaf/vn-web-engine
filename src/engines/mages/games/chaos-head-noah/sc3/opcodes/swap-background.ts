import type {OpcodeExecution} from './types.js';
import {backgroundIndex} from './background.js';

/** 10/02, 140059100. Swap the native records in their original write order. */
export function swapBackground(h: OpcodeExecution): void {
  h.skip(2);
  const first = h.expression(),
    second = h.expression();
  // Unlike the loader, this handler uses 140010d60's one-based result directly.
  const a = backgroundIndex(first) + 1,
    b = backgroundIndex(second) + 1,
    s = h.state;
  const flagA = s.flag(a + 0x95f),
    flagB = s.flag(b + 0x95f);
  s.setFlag(b + 0x95f, flagA);
  s.setFlag(a + 0x95f, flagB);
  const swap = (x: number, y: number) => {
    const value = s.variable(x);
    s.setVariable(x, s.variable(y));
    s.setVariable(y, value);
  };
  for (let i = 0; i < 40; i++) swap(a * 40 + 0x116c + i, b * 40 + 0x116c + i);
  swap(a + 0xd47, b + 0xd47);
  swap(a * 2 + 0xbb6, b * 2 + 0xbb6);
  swap(a * 2 + 0xbb7, b * 2 + 0xbb7);
}
