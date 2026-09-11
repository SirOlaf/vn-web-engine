import type {OpcodeExecution} from './types.js';
import {saveSlotAddress, checksumSaveSlot} from '../save-codec.js';

/** 14003ad90: newest valid slot, preserving the first slot on equal timestamps. */
function newestSlot(h: OpcodeExecution): number {
  const s = h.state,
    bank = s.get(0x5afa84),
    word = (a: number) => s.view(a, 2).getUint16(0, true);
  const index = (row: number) =>
    bank === 2 ? s.get(0x179cc20 + (row + s.get(0x17add50) * 48) * 4) >>> 0 : row;
  const address = (row: number) => saveSlotAddress(bank, index(row));
  let best = 0;
  for (let row = 0; row < 48; row++) {
    const next = address(row);
    if (word(next) !== 1 || index(best) === index(row)) continue;
    const prior = address(best);
    if (word(prior) !== 1) {
      best = row;
      continue;
    }
    for (const [a, b] of [
      [word(prior + 8), word(next + 8)],
      [word(prior + 10), word(next + 10)],
      [s.get(prior + 12) & 0xffffff, s.get(next + 12) & 0xffffff],
    ]) {
      if (a! < b!) {
        best = row;
        break;
      }
      if (a! > b!) break;
    }
  }
  return best;
}

/** 14003afa0 and 14003b030. Native save/load selection, paging and slot locks. */
export function saveMenu(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v);
  if (selector === 0 || selector === 10) {
    const mode = h.byte();
    p(0x5afaac, 0);
    p(0x5afacc, 0);
    p(0x5afa84, mode === 0 ? 2 : 1);
    p(0x5b097c, 48);
    s.flags[0xe6] = s.flags[0xe6]! | 64;
    p(0x5afab0, mode);
    const row = newestSlot(h),
      page = Math.trunc(row / 8);
    p(0x5afad4, page);
    p(0x5b0a44, page);
    p(0x5b0970, row - page * 8);
    return;
  }
  if (selector !== 1) return;
  if (g(0x5afacc) !== 0) {
    p(0x5afacc, g(0x5afacc) - 1);
    if (g(0x5afacc) === 0) p(0x5afad4, g(0x5b0a44));
    p(0x5a70d4, 0);
    return;
  }
  const volume = () =>
    Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8) >>> 0) * 70) / 100)) >>> 0;
  const sound = (id: number) => {
    const v = volume();
    p(0x5a7100, v);
    h.sound(id, v);
  };
  let confirm = g(0x872dd4) & g(0x5a70d4),
    lock = !!(g(0x872e08) & g(0x5a70d4));
  let previous = false,
    next = false;
  if (!s.bytes(0x543836, 1)[0]) {
    previous = !!(g(0x5a6f74) & 256 || g(0x586a58) & 128);
    next = !!(g(0x5a6f74) & 512 || g(0x586a58) & 256);
  }
  for (let row = 0; row < 8; row++)
    if (h.input.hit(20, row, true)) {
      p(0x5b0970, row);
      if (g(0x17add90) & 1) {
        if (h.input.hit(21, row, true)) {
          confirm = 0;
          lock = true;
        } else {
          confirm = 1;
          p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
        }
      }
      break;
    }
  const selected = () => {
    let row = (g(0x5b0970) + Math.imul(g(0x5afad4), 8)) >>> 0;
    if (g(0x5afa84) === 2) row = g(0x179cc20 + row * 4) >>> 0;
    return row;
  };
  const word = (a: number) => s.view(a, 2).getUint16(0, true);
  if (lock && g(0x5b0970) >>> 0 !== 65535) {
    const index = selected(),
      bank = g(0x5afa84),
      a = saveSlotAddress(bank, index);
    if (word(a) === 1) {
      sound(2);
      p(a + 0x1c, g(a + 0x1c) ^ 1);
      checksumSaveSlot(s, bank, index, g(a + 0x24));
      let full = g(0x5b0998) === 0;
      if (full)
        for (let i = 0; i < 48; i++)
          if (!(s.bytes(0x8732ac + i * 0x1474c, 1)[0]! & 1)) {
            full = false;
            break;
          }
      s.flags[0x9b] = (s.flags[0x9b]! & ~64) | (full ? 192 : 128);
      return;
    }
    p(0x5a7100, volume());
  }
  if (confirm) {
    if (g(0x5b0970) >>> 0 !== 255) {
      const bank = g(0x5afa84),
        index = selected();
      // The native confirmation path accepts only manual/automatic slot banks.
      if (bank !== 1 && bank !== 2)
        throw new Error('Native save-menu confirmation dereferences a null slot');
      const a = saveSlotAddress(bank, index),
        status = word(a);
      s.setVariable(0x3a28 / 4, status);
      s.setVariable(0x3a38 / 4, g(a + 20));
      s.setVariable(0x3a2c / 4, index);
      s.setVariable(0x3a30 / 4, bank);
      const locked = status !== 2 && !!(g(a + 0x1c) & 1);
      s.flags[0x9b] = locked ? s.flags[0x9b]! | 32 : s.flags[0x9b]! & ~32;
      return;
    }
    p(0x5a70d4, g(0x5a70d4) & ~g(0x872dd4));
  }
  if (previous) {
    sound(2);
    p(0x5b0a44, g(0x5b0a44) === 0 ? 5 : g(0x5b0a44) - 1);
    p(0x5afacc, 16);
    return;
  }
  if (next) {
    sound(2);
    p(0x5b0a44, g(0x5b0a44) < 5 ? g(0x5b0a44) + 1 : 0);
    p(0x5afacc, 16);
    return;
  }
  if (g(0x58734c) & g(0x872dc0)) {
    sound(1);
    const row = g(0x5b0970) >>> 0;
    p(0x5b0970, row === 255 ? 0 : (row & 0xfffffffb) === 0 ? row + 3 : row - 1);
  }
  if (g(0x58734c) & g(0x872dc4)) {
    sound(1);
    const row = g(0x5b0970) >>> 0;
    p(0x5b0970, row === 255 ? 0 : ((row - 3) & 0xfffffffb) === 0 ? row - 3 : row + 1);
  }
  for (const mask of [0x872dc8, 0x872dcc])
    if (g(0x5a6f74) & g(mask)) {
      sound(1);
      const row = g(0x5b0970);
      p(0x5b0970, row === 255 ? 0 : row < 4 ? row + 4 : row - 4);
    }
}
