import type {OpcodeExecution} from './types.js';

/** 140043020: the two native menu-choice row banks and their packed text slots. */
function resetMenuChoice(h: OpcodeExecution, index: number): void {
  const s = h.state;
  for (const base of [0x80bd08, 0x80bd00, 0x66d8d0, 0x7fc908]) s.put(base + index * 4, 0);
  s.put(0x7fbf98 + index * 4, -1);
  for (let row = 0; row < 30; row++) {
    s.put(0x799bc0 + index * 240 + row * 8, 0, 8);
    s.put(0x80d680 + index * 240 + row * 8, 0, 8);
  }
  s.resetText(index + 5);
}

/** Entire 01/14, 140050120. Native menu-choice row construction. */
export function menuChoice(h: OpcodeExecution): void {
  h.skip(2);
  const encoded = h.byte(),
    s = h.state;
  if (encoded < 2) {
    s.setVariable(encoded + 0x83e, 0);
    resetMenuChoice(h, encoded);
    return;
  }
  const slot = h.context.getUint32(0x74, true);
  const address =
    encoded & 128 ? h.messageAddress(slot, h.expression()) : h.stringAddress(slot, h.word());
  const index = ((encoded & 128 ? encoded - 128 : encoded) - 2) >>> 0;
  const {width, height, row} = h.sceneText.prepareMenuChoice(address, index),
    b = (index + 5) * 0x11984,
    n = s.get(0x5b10ac + b) >>> 0;
  for (let i = 0; i < n; i++)
    if (s.bytes(0x5bf1e4 + b + i, 1)[0] === row >>> 0 || row >>> 0 >= 256)
      s.put(0x5c20c4 + b + i, 255, 1);
  const offset = (index * 30 + row) * 8;
  s.put(0x799bc0 + offset, width);
  s.put(0x799bc4 + offset, height);
  s.put(0x80d680 + offset, 0x280 - (width >>> 1));
  if (s.get(0x66d8d0 + index * 4) >>> 0 < width) s.put(0x66d8d0 + index * 4, width);
  s.put(0x80bd08 + index * 4, row + 1);
}
