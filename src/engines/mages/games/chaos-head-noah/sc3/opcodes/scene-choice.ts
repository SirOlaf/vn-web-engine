import type {OpcodeExecution} from './types.js';
import {captureCheckpoint} from './checkpoint.js';

const ROWS = 30;
/** 1400428a0: reset the scene-choice row table and its packed text slot. */
function resetChoice(h: OpcodeExecution): void {
  const s = h.state;
  s.put(0x768710, -1);
  for (let i = 0; i < ROWS; i++) {
    s.put(0x80eb20 + i * 8, 0);
    s.put(0x80f250 + i * 8, 0);
  }
  for (const address of [0x719a08, 0x660ff0, 0x7686e0, 0x660ff4]) s.put(address, 0);
  s.resetText(7);
}

/** Entire 01/12 (14004f2c0): initialize or append one native scene-choice row. */
export function sceneChoice(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context,
    original = c.getBigUint64(0x158, true),
    slot = c.getUint32(0x13c, true);
  h.skip(2);
  const encoded = h.byte(),
    raw = Number(c.getBigUint64(0x158, true)),
    tag = h.scriptByte(raw) | (h.scriptByte(raw + 1) << 8);
  if (encoded === 0) {
    const label = h.word(),
      next = c.getBigUint64(0x158, true);
    if (s.get(0x5b10b0 + slot * 0x11984) !== 2) {
      c.setBigUint64(0x158, original, true);
      if (!s.flag((slot + 0x508) >>> 0)) {
        if (s.variable(0x4330 / 4) !== 65535) {
          s.put(0x20d3cc, label);
          captureCheckpoint(h);
          h.yield();
          s.flags[0x96] = s.flags[0x96]! | 0x40;
          s.flags[0xa0] = s.flags[0xa0]! | 0x20;
        }
      } else s.setFlag((slot + 0x508) >>> 0, 0);
      c.setBigUint64(0x158, next, true);
    }
    s.setVariable(0x2150 / 4, h.expression());
    s.setVariable(0x20f0 / 4, 0);
    resetChoice(h);
    return;
  }
  const scriptSlot = c.getUint32(0x74, true);
  let address: number,
    selector = encoded;
  if (encoded & 128) {
    address = h.messageAddress(scriptSlot, h.expression());
    selector = (encoded - 128) >>> 0;
  } else address = h.stringAddress(scriptSlot, h.word());
  let include: number;
  if (selector === 1) include = 1;
  else if (selector === 2) include = h.expression();
  else
    throw new Error(
      `01/12 reads an uninitialized native stack value for selector 0x${encoded.toString(16)}`,
    );
  if (include !== 0) {
    const {width, height, row} = h.sceneText.prepareChoice(address),
      unsignedRow = row >>> 0,
      n = s.get(0x62c348) >>> 0;
    for (let i = 0; i < n; i++)
      if (s.bytes(0x63a480 + i, 1)[0] === (row & 255) || unsignedRow >= 256)
        s.put(0x63d360 + i, 255, 1);
    s.put(0x80eb20 + row * 8, width);
    s.put(0x80eb24 + row * 8, height);
    s.put(0x80cf70 + row * 4, s.get(0x20ddf0 + scriptSlot * 4));
    s.put(0x80f250 + row * 8, (0x280 - (width >>> 1)) >>> 0);
    if (s.get(0x7686e0) >>> 0 < width) s.put(0x7686e0, width);
    s.put(0x737910 + row * 4, tag);
    s.put(0x732a20 + row * 4, s.get(0x719a08));
    s.put(0x80ce80 + row * 8, address, 8);
    s.put(0x660ff0, (row + 1) >>> 0);
  }
  s.put(0x719a08, (s.get(0x719a08) + 1) >>> 0);
}
