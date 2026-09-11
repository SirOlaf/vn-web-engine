import type {OpcodeExecution} from './types.js';
import {advanceMessageGlyphs, markMessageRead} from './message-wait.js';

/** Entire 01/0a, 14004cdf0. Selectors have distinct clear/reset/history paths. */
export function clearText(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context,
    pc = c.getBigUint64(0x158, true);
  h.skip(2);
  const mode = h.byte();
  // 4/5 have no expression; other even selectors evaluate it even on default.
  const slot = mode === 4 || mode === 5 ? -1 : mode & 1 ? -1 : h.expression() >>> 0;
  const flag = (slot: number, id: number, value: number) => s.setFlag((slot + id) >>> 0, value);
  const retry = () => {
    c.setBigUint64(0x158, pc, true);
    h.yield();
  };
  const fade = (slot: number) => {
    if (s.get(0x5b10b0 + slot * 0x11984) === 2) {
      if (s.get(0x17ac258 + slot * 4) === 0) s.put(0x5b10b4 + slot * 0x11984, 2, 1);
      else {
        s.put(0x5b10b4 + slot * 0x11984, 4, 1);
        s.put(0x80c4d0 + slot * 4, 0);
        s.put(0x80cff0 + slot * 4, 0);
      }
    }
    advanceMessageGlyphs(h, slot);
  };
  switch (mode) {
    case 0:
    case 8: {
      const status = s.get(0x5b10b0 + slot * 0x11984);
      if (status !== 0 && status !== 4) {
        fade(slot);
        retry();
        return;
      }
      if (mode === 0) {
        flag(slot, 0x771, 1);
        flag(slot, 0x4e3, 0);
        s.put(0x80cff0 + (slot | 0) * 4, 0);
        s.put(0x5b10ac + slot * 0x11984, 0);
        return;
      }
      flag(slot, 0x4e3, 0);
      s.put(0x5b10ac + slot * 0x11984, 0);
      flag(slot, 0x771, 1);
      s.put(0x62c348, 0);
      const signed = slot | 0,
        ptr = (a: number) => Number(s.view(a, 8).getBigUint64(0, true));
      if (ptr(0x179e680 + signed * 8))
        markMessageRead(
          h,
          s.variable((Math.imul(slot, 2) + 0x92a) | 0),
          s.variable((Math.imul(slot, 2) | 0) + 0x929),
        );
      // This is inlined native history logic, NOT 140045310: no text-property
      // suppression, a signed queue count, and no tag reset when suppressed.
      if (!(s.flags[0x136]! & 8)) {
        for (let i = 0; i < s.get(0x179e6d0 + signed * 4); i++) {
          const q = signed * 80 + i;
          if (s.get(0x179da00 + q * 4) !== 0) continue;
          const voice = s.get(0x17a0000 + q * 4);
          h.backlog.append(
            ptr(0x179e700 + q * 8),
            voice,
            voice === -1 ? 0 : s.get(0x179cd80 + q * 4),
            s.get(0x20ddc0 + signed * 4),
          );
          s.put(0x20ddc0 + signed * 4, 65535);
        }
        s.put(0x179e6d0 + signed * 4, 0);
        const address = ptr(0x179e680 + signed * 8);
        if (address) {
          const voice = s.get(0x179cae8 + signed * 4);
          h.backlog.append(
            address,
            voice,
            voice === -1 ? 0 : s.get(0x179cd58 + signed * 4),
            s.get(0x20ddc0 + signed * 4),
          );
        }
      } else s.put(0x179e6d0 + signed * 4, 0);
      s.put(0x179e680 + signed * 8, 0, 8);
      return;
    }
    case 1: {
      let pending = false;
      for (let i = 0; i < 3; i++) {
        const status = s.get(0x5b10b0 + i * 0x11984);
        if (status !== 0 && status !== 4) pending = true;
        // Even already-complete slots run the reveal helper in this selector.
        fade(i);
        flag(i, 0x771, 1);
      }
      if (pending) {
        retry();
        return;
      }
      for (let i = 0; i < 3; i++) {
        s.put(0x80cff0 + i * 4, 0);
        s.put(0x5b10ac + i * 0x11984, 0);
        flag(i, 0x4e3, 0);
      }
      return;
    }
    case 2:
      flag(slot, 0x9c6, 0);
      c.setUint32(0x13c, slot, true);
      flag(slot, 0x771, 1);
      flag(slot, 0x4e3, 0);
      s.put(0x80cff0 + (slot | 0) * 4, 0);
      return;
    case 3:
      for (let i = 0; i < 3; i++) {
        s.put(0x80cff0 + i * 4, 0);
        flag(i, 0x9c6, 0);
        flag(i, 0x4e3, 0);
        flag(i, 0x771, 1);
      }
      return;
    case 4: {
      const selected = c.getUint32(0x13c, true);
      if (s.variable((selected + 0x839) | 0) !== 0) retry();
      else s.resetText(selected);
      return;
    }
    case 5:
      if ([0, 1, 2].some((i) => s.variable(0x839 + i) !== 0)) retry();
      else for (let i = 0; i < 3; i++) s.resetText(i);
      return;
    case 6:
      flag(slot, 0x9c6, 0);
      s.setVariable((slot + 0x839) | 0, 0);
      s.resetText(slot);
      return;
    case 7:
      for (let i = 0; i < 3; i++) {
        flag(i, 0x9c6, 0);
        s.setVariable(0x839 + i, 0);
        s.resetText(i);
      }
      return;
  }
}
