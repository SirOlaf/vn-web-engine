import type {OpcodeExecution} from './types.js';
import {SLOT_SIZE} from '../save-codec.js';

/** 140048460: restore the scene banks, or the saved context's execution fields. */
export function restoreCheckpoint(h: OpcodeExecution, contextOnly: boolean): void {
  const s = h.state,
    v = s.variables;
  if (contextOnly) {
    const handle = v.getUint32(0x33a0, true);
    if (!handle) return;
    const c = 0x17a2f00 + (handle & 0x7fffffff) * 0x160;
    if ((s.get(c + 0x14) - 5) >>> 0 >= 3) return;
    for (const offset of [0x10, 0x14, 0x18, 0x1c, 0x24, 0x28, 0x2c])
      s.put(c + offset, s.get(0xc4d6a4 + offset - 0x10));
    const slot = s.get(0xc4d708) >>> 0;
    s.put(c + 0x74, slot);
    s.put(c + 0x158, h.labelAddress(slot, s.get(0xc4d6b4) >>> 0, true), 8);
    s.writeSpan(c + 0x30, s.readSpan(0xc4d6c4, 64));
    s.writeSpan(c + 0xbc, s.readSpan(0xc4d70c, 64));
    s.put(c + 0x13c, s.get(0xc4d74c));
    return;
  }
  v.setInt32(0x2100, s.get(0xc49204), true);
  for (const [target, source, length] of [
    [50, 0xc49260, 50],
    [300, 0xc49292, 100],
    [500, 0xc492f6, 125],
  ])
    s.flags.set(s.readSpan(source!, length!), target!);
  s.variableBytes.set(s.readSpan(0xc49374, 0x960), 4000);
  s.variableBytes.set(s.readSpan(0xc49cd4, 0x39d0), 0x4330);
  for (const [target, source] of [
    [0x54d270, 0xc4d750],
    [0x5494e0, 0xc4da78],
    [0x56ce50, 0xc4d8e4],
  ])
    s.writeSpan(target!, s.readSpan(source!, 400));
  s.put(0x545654, s.get(0xc4d8e0));
  s.put(0x545224, s.get(0xc4dc08));
  s.put(0x56ce4c, s.get(0xc4da74));
  for (const [target, source] of [
    [0x3844, 0x435c],
    [0x3848, 0x4360],
    [0x384c, 0x4364],
    [0x3854, 0x4358],
    [0x38c8, 0x43ac],
    [0x3858, 0x43d8],
    [0x385c, 0x43dc],
    [0x3860, 0x43e0],
    [0x3864, 0x43e4],
  ])
    v.setInt32(target!, v.getInt32(source!, true), true);
  for (let i = 0; i < 8; i++) {
    v.setInt32(0x3868 + i * 4, v.getInt32(0x466c + i * 0xa0, true), true);
    v.setInt32(0x3888 + i * 4, v.getInt32(0x4fd4 + i * 0xa0, true), true);
    v.setInt32(0x3b38 + i * 4, v.getInt32(0x6388 + i * 4, true), true);
  }
  v.setInt32(0x38cc, (v.getInt32(0x5d9c, true) << 16) + v.getInt32(0x5d98, true), true);
  v.setInt32(0x38d0, (v.getInt32(0x5db0, true) << 16) + v.getInt32(0x5dac, true), true);
}

/** Entire 10/24, 14005af90. All nonzero selectors restore only the context. */
export function loadCheckpoint(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte();
  if (selector === 0) {
    const bank = h.expression(),
      index = h.expression() >>> 0;
    if (bank === 1 || bank === 2)
      h.state.writeSpan(
        0xc491e0,
        h.state.readSpan((bank === 1 ? 0xc4dc10 : 0x873290) + index * SLOT_SIZE, 0x4a2c),
      );
  }
  restoreCheckpoint(h, selector !== 0);
}
