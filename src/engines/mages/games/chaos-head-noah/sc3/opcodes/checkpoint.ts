import type {OpcodeExecution} from './types.js';
import {
  checksumSaveSlot,
  stampSaveSlot,
  encodeThumbnail,
  decodeThumbnail,
  SLOT_SIZE,
} from '../save-codec.js';

/** 1400480b0: the current scene/context snapshot, before time/checksums/thumbnail. */
export function captureCheckpoint(h: OpcodeExecution): void {
  const s = h.state;
  s.flags[0xe3] = s.flags[0xe3]! | 0x20;
  s.zero(0xc491e0, 0x4a2c);
  s.put(0xc491e0, 1, 1);
  s.put(0xc491e6, 0x100, 2);
  s.put(0xc491f0, s.variable(0x4340 / 4));
  s.put(0xc491f4, s.variable(0x4330 / 4));
  if (s.variable(0x4338 / 4) !== 0) {
    s.put(0xc491fc, 2);
    s.put(0xc49200, s.variable(0x4338 / 4));
  }
  for (const [target, start, length] of [
    [0xc49260, 50, 50],
    [0xc49292, 300, 100],
    [0xc492f6, 500, 125],
  ])
    s.bytes(target!, length!).set(s.flags.subarray(start!, start! + length!));
  s.bytes(0xc49374, 0x960).set(s.variableBytes.subarray(4000, 6400));
  s.bytes(0xc49cd4, 0x39d0).set(s.variableBytes.subarray(0x4330, 0x7d00));
  const handle = s.variable(0x33a0 / 4) >>> 0;
  if (handle !== 0) {
    const c = 0x17a2f00 + (handle & 0x7fffffff) * 0x160,
      group = s.get(c + 0x14);
    if ((group - 5) >>> 0 < 3) {
      for (const offset of [0x10, 0x14, 0x18, 0x1c, 0x24, 0x28, 0x2c])
        s.put(0xc4d6a4 + offset - 0x10, s.get(c + offset));
      s.put(0xc4d6b4, s.get(0x20d3cc));
      s.writeSpan(0xc4d6c4, s.readSpan(c + 0x30, 64));
      s.put(0xc4d708, s.get(c + 0x74));
      s.writeSpan(0xc4d70c, s.readSpan(c + 0xbc, 64));
      s.put(0xc4d74c, s.get(c + 0x13c));
    }
  }
  for (const [target, source] of [
    [0xc4d750, 0x54d270],
    [0xc4da78, 0x5494e0],
    [0xc4d8e4, 0x56ce50],
  ])
    s.writeSpan(target!, s.readSpan(source!, 400));
  s.put(0xc4d8e0, s.get(0x545654));
  s.put(0xc4da74, s.get(0x56ce4c));
  s.put(0xc4dc08, s.get(0x545224));
}

/** 140048b30 + 140048d60: timestamp, recency ordering and automatic slot write. */
export function storeCheckpoint(h: OpcodeExecution, kind: number): boolean {
  const s = h.state,
    now = h.localTime();
  for (const [a, v] of [
    [0x17adc94, now.getFullYear()],
    [0x17acb88, now.getMonth() + 1],
    [0x17adc98, now.getDate()],
    [0x17acb98, now.getHours()],
    [0x17acba4, now.getMinutes()],
    [0x17acb9c, now.getSeconds()],
    [0x17acb8c, now.getDay()],
  ])
    s.put(a!, v!);
  const order = 0x179cc20 + s.get(0x17add50) * 48 * 4,
    index = (row: number) => s.get(order + row * 4) >>> 0,
    slot = (row: number) => 0x873290 + index(row) * SLOT_SIZE;
  let row = 0;
  while (row < 48 && s.view(slot(row), 2).getUint16(0, true) !== 0) row++;
  if (row === 48) {
    row = 47;
    while (row >= 0 && s.bytes(slot(row) + 0x1c, 1)[0]! & 1) row--;
    if (row < 0) return false;
  }
  const selected = index(row);
  for (let i = row; i > 0; i--) s.put(order + i * 4, index(i - 1));
  if (row !== 0) s.put(order, selected);
  s.writeSpan(0x873290 + selected * SLOT_SIZE, s.readSpan(0xc491e0, 0x4a2c));
  stampSaveSlot(s, 2, selected);
  checksumSaveSlot(s, 2, selected, kind);
  encodeThumbnail(s, 2, selected);
  h.uploadThumbnail(selected + 0x101, decodeThumbnail(s, 2, selected));
  return true;
}

/** Entire 10/22 (14005aae0), including its unusual selector-10 PC overlap. */
export function checkpoint(h: OpcodeExecution): void {
  const s = h.state,
    selector = h.scriptByte(Number(h.context.getBigUint64(0x158, true)) + 2);
  if (selector === 255) {
    h.yield();
    s.flags[0x96] = s.flags[0x96]! | 0x40;
    h.skip(3);
    return;
  }
  const policy = s.flags[0xa0]! & 4 ? 0 : s.get(0x17add44) >>> 0;
  const unlocked = () => {
    for (let i = 0; i < 48; i++) if (!(s.bytes(0x8732ac + i * SLOT_SIZE, 1)[0]! & 1)) return true;
    return false;
  };
  const save = (kind: number) => {
    if (storeCheckpoint(h, kind)) s.put(0x17ac1c4, 150);
  };
  switch (selector) {
    case 0:
    case 1:
    case 5:
    case 20:
    case 21: {
      if (s.variable(0x4330 / 4) === 65535) break;
      if (selector < 20) captureCheckpoint(h);
      if (selector !== 5) {
        const kind = selector === 0 || selector === 20 ? 1 : 3;
        if (
          s.variable(0x2100 / 4) !== kind &&
          unlocked() &&
          (kind === 1 ? (policy - 1) >>> 0 < 2 : (policy & 0xfffffffd) === 0)
        )
          save(kind);
      }
      if (selector < 20) s.flags[0xa0] = s.flags[0xa0]! | 0x20;
      s.setVariable(0x2100 / 4, 0);
      break;
    }
    case 2:
      if (s.variable(0x4330 / 4) === 65535) h.skip(3);
      break;
    case 3:
      if (unlocked()) {
        const volume =
          Math.trunc(Math.fround(Math.fround(Math.fround(s.get(0x17ac2e8) >>> 0) * 70) / 100)) >>>
          0;
        s.put(0x5a7100, volume);
        h.sound(2, volume);
        save(0);
      }
      s.flags[0xa0] = s.flags[0xa0]! & ~0x20;
      break;
    case 10:
      h.yield();
      s.flags[0x96] = s.flags[0x96]! | 0x40;
      h.skip(3);
      s.put(0x20d3cc, h.word());
      h.skip(-3);
      break;
  }
  h.skip(3);
}
