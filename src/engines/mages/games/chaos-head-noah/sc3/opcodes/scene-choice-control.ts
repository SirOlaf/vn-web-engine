import type {OpcodeExecution} from './types.js';
import {advanceMessageGlyphs, markMessageRead} from './message-wait.js';
import {storeCheckpoint} from './checkpoint.js';
import {SLOT_SIZE} from '../save-codec.js';

/** Entire 01/13, 14004f640: choice layout, input, fade and completion. */
export function controlSceneChoice(h: OpcodeExecution): void {
  const s = h.state,
    c = h.context,
    original = c.getBigUint64(0x158, true),
    slot = c.getUint32(0x13c, true),
    b = slot * 0x11984;
  const g = (a: number) => s.get(a),
    p = (a: number, v: number, w = 4) => s.put(a, v, w),
    ptr = (a: number) => Number(s.view(a, 8).getBigUint64(0, true));
  const busy = (value: boolean) => {
    s.flags[0xa0] = value ? s.flags[0xa0]! | 64 : s.flags[0xa0]! & ~64;
  };
  const retry = () => {
    c.setBigUint64(0x158, original, true);
    h.yield();
  };
  const sound = (id: number) => {
    const volume =
      Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8) >>> 0) * 70) / 100)) >>> 0;
    p(0x5a7100, volume);
    h.sound(id, volume);
  };
  h.skip(2);
  const selector = h.byte(),
    policy = s.flags[0xa0]! & 4 ? 0 : g(0x17add44);
  if (selector !== 0 && selector !== 2) {
    for (let row = 0; row < g(0x660ff0); row++)
      if (h.input.hit(3, row, true)) {
        if (g(0x768710) !== row) sound(1);
        p(0x768710, row);
        if (g(0x17add90) & 1) p(0x586a58, g(0x586a58) | 1);
        break;
      }
    if (!(s.flags[0x9b]! & 16) && !s.bytes(0x543836, 1)[0]) {
      if (g(0x586a58) & 32 || g(0x872dc0) & g(0x5a6f74)) {
        sound(1);
        const selected = g(0x768710);
        p(0x768710, (selected === -1 || selected === 0 ? g(0x660ff0) : selected) - 1);
        if (s.bytes(0x543836, 1)[0]) {
          retry();
          return;
        }
      }
      if (g(0x586a58) & 64 || g(0x872dc4) & g(0x5a6f74)) {
        sound(1);
        const selected = g(0x768710);
        p(0x768710, selected === -1 || selected === ((g(0x660ff0) - 1) | 0) ? 0 : selected + 1);
        if (s.bytes(0x543836, 1)[0]) {
          retry();
          return;
        }
      }
      if ((g(0x586a58) & 1 || g(0x5a70d4) & g(0x872dd4)) && g(0x768710) !== -1) {
        busy(true);
        sound(2);
        if (g(0x5b10b0 + b) === 2) {
          p(0x5b10b4 + b, g(0x17ac258 + slot * 4) === 0 ? 2 : 4, 1);
          s.setFlag((slot + 0x4e3) >>> 0, 0);
          const audio = 0x5a7110 + s.bytes(0x5b10b5 + b, 1)[0]! * 0x98;
          p(audio, -1);
          p(audio + 12, 0);
        }
        busy(true);
        h.yield();
        return;
      }
    }
    retry();
    return;
  }
  if (selector === 2) {
    advanceMessageGlyphs(h, slot);
    if (s.variable(0x20f0 / 4) !== 0) {
      s.setVariable(0x20f0 / 4, s.variable(0x20f0 / 4) - 16);
      busy(true);
      retry();
      return;
    }
    busy(false);
    s.setVariable(0x2100 / 4, 0);
    if ((g(0x5b10b0 + b) - 2) >>> 0 <= 1) {
      retry();
      return;
    }
    s.setFlag((slot + 0x771) >>> 0, 1);
    p(0x5b10ac + b, 0);
    p(0x62c348, 0);
    const destination = h.expression();
    s.setVariable(destination, g(0x732a20 + g(0x768710) * 4));
    let current = ptr(0x179e680 + slot * 8);
    if (current)
      markMessageRead(
        h,
        s.variable((slot * 2 + 0x92a) >>> 0),
        s.variable((slot * 2 + 0x929) >>> 0),
      );
    if (s.flags[0x136]! & 8) {
      p(0x179e6d0 + slot * 4, 0);
      p(0x179e680 + slot * 8, 0, 8);
      return;
    }
    // Unlike 140045310, this path ignores per-entry hidden bits and slot properties.
    if (g(0x179e6d0 + slot * 4) !== 0) {
      const hadQueued = g(0x179e6d0 + slot * 4) > 0;
      for (let i = 0; i < g(0x179e6d0 + slot * 4); i++) {
        const q = slot * 80 + i,
          voice = g(0x17a0000 + q * 4);
        h.backlog.append(
          ptr(0x179e700 + q * 8),
          voice,
          voice === -1 ? 0 : g(0x179cd80 + q * 4),
          g(0x20ddc0 + slot * 4),
        );
        p(0x20ddc0 + slot * 4, 65535);
      }
      if (hadQueued) current = ptr(0x179e680 + slot * 8);
      p(0x179e6d0 + slot * 4, 0);
    }
    if (current) {
      const voice = g(0x179cae8 + slot * 4);
      h.backlog.append(
        current,
        voice,
        voice === -1 ? 0 : g(0x179cd58 + slot * 4),
        g(0x20ddc0 + slot * 4),
      );
    }
    p(0x179e680 + slot * 8, 0, 8);
    h.backlog.appendQuoted(ptr(0x80ce80 + g(0x768710) * 8));
    return;
  }
  if (s.variable(0x20f0 / 4) === 0) {
    const rows = g(0x660ff0);
    p(0x660ff4, 0);
    if (rows !== 0) {
      const gap = s.view(0x7fbeca, 2).getUint16(0, true);
      let height = 0,
        left = 1920;
      p(0x7fc938, left);
      for (let row = 0; row < rows; row++) {
        left = Math.min(left, g(0x80f250 + row * 8));
        height = (height + g(0x80eb24 + row * 8) + gap) | 0;
      }
      if (rows > 0) p(0x7fc938, left);
      height = (height - gap) | 0;
      p(0x660ff4, height);
      let y = Math.trunc(((720 - height) | 0) / 2);
      const layout = s.variable(0x2150 / 4);
      if (layout === 0) y = (246 - Math.trunc(Math.imul(rows, 60) / 2)) | 0;
      else if (layout === 1) p(0x7fc904, y);
      if (layout === 0 || layout === 1)
        for (let row = 0; row < rows; row++) {
          p(0x80f254 + row * 8, y);
          for (let i = 0; i < 2400; i++)
            if (s.bytes(0x63a480 + i, 1)[0] === row)
              p(0x636c40 + i * 2, s.view(0x636c40 + i * 2, 2).getUint16(0, true) + y, 2);
          y = (y + (layout === 0 ? 60 : g(0x80eb24 + row * 8) + gap)) | 0;
        }
    }
    sound(5);
  }
  if (s.variable(0x20f0 / 4) >>> 0 < 256) {
    s.setVariable(0x20f0 / 4, s.variable(0x20f0 / 4) + 16);
    busy(true);
    retry();
    return;
  }
  s.setFlag((slot + 0x4bd) >>> 0, 0);
  let saved = false;
  if (s.variable(0x2100 / 4) !== 2) {
    for (let i = 0; i < 48; i++)
      if (!(s.bytes(0x8732ac + i * SLOT_SIZE, 1)[0]! & 1)) {
        if (policy & 1) {
          saved = storeCheckpoint(h, 2);
          if (saved) p(0x17ac1c4, 150);
        }
        break;
      }
    s.setVariable(0x2100 / 4, 0);
    if (!(policy & 1) || s.flags[0xa0]! & 4 || !(s.flags[0xa0]! & 32)) p(0x20d394, 65535);
  }
  if (!saved) h.skip(12);
  busy(false);
  h.yield();
}
