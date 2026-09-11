import type {OpcodeExecution} from './types.js';

/** 10/04, 140059380: pack script components into one background-composition word. */
export function setBackgroundComposition(h: OpcodeExecution): void {
  h.skip(2);
  let index = h.byte();
  const second = h.expression(),
    first = h.expression();
  let fourth = 0;
  if (index >= 4) {
    index -= 4;
    fourth = h.expression();
  }
  const third = h.expression();
  h.state.setVariable(
    0x4628 / 4 + index,
    ((fourth << 24) + first + (third << 16) + (second << 8)) | 0,
  );
}
