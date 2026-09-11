import type {OpcodeExecution} from './types.js';
import type {NoahState} from '../noah-state.js';
import {restoreCheckpoint} from './restore-checkpoint.js';

/** 140044210: visible complete rows; bottom boundary is an unsigned comparison. */
export function backlogRange(s: NoahState): void {
  const g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v),
    count = g(0x810074) >>> 0;
  if (g(0x5b0a5c) < 0) p(0x5b0a5c, 0);
  if (!count) {
    p(0x73798c, 0);
    p(0x810078, 0);
    p(0x7fc900, 0);
    return;
  }
  let row = 0;
  while (row < count && g(0x5b0a5c) > g(0x5b0a60 + row * 4)) row++;
  p(0x73798c, row);
  while (
    row < count &&
    (g(0x5b0a5c) + 506) >>> 0 >= (g(0x810080 + row * 4) + g(0x5b0a60 + row * 4)) >>> 0
  )
    row++;
  p(0x7fc900, row - 1);
}
/** 1400442b0: linearize the 400-entry metadata ring. */
export function initializeBacklog(s: NoahState): void {
  const g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v),
    count = g(0x810074) >>> 0;
  for (const a of [0x5b0a5c, 0x810078, 0x7cb034]) p(a, 0);
  if (!count) return;
  let ring = g(0x73799c) >>> 0,
    total = 0;
  const spacing = s.view(0x7fbf2a, 2).getUint16(0, true);
  p(0x80f348, 0);
  for (let row = 0; row < count; row++) {
    p(0x80fa30 + row * 4, ring);
    p(0x5b0a60 + row * 4, total);
    const height = g(0x7379a0 + ring * 4);
    p(0x80f3f0 + row * 4, g(0x768720 + ring * 4));
    p(0x810080 + row * 4, height);
    total = (total + spacing + height) | 0;
    p(0x80f348, total);
    ring = ring === 399 ? 0 : (ring + 1) >>> 0;
  }
  p(0x80fa30 + count * 4, ring);
  p(0x5b0a5c, total < 507 ? 0 : total - 506);
  // Native compares against 0x1fb (507), then its range helper clamps negatives.
  backlogRange(s);
  p(0x810078, g(0x7fc900));
  p(0x5b0a58, 0);
  p(0x80f34c, -1);
}
/** Complete 140044c00, including drag, wheel, page keys and voice replay. */
export function interactBacklog(h: OpcodeExecution): void {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v),
    byte = (a: number) => s.bytes(a, 1)[0]!,
    f = Math.fround;
  if (!g(0x810074)) return;
  const range = () => backlogRange(s),
    sound = (id: number) => {
      const volume = Math.trunc(f(f(f(g(0x17ac2e8) >>> 0) * 70) / 100)) >>> 0;
      p(0x5a7100, volume);
      h.sound(id, volume);
    };
  if (g(0x5b0a58) !== 0 && g(0x5a74a0) === g(0x5a74cc) && g(0x5a74dc) !== 0) {
    p(0x5b0a58, 0);
    p(0x80f34c, -1);
  }
  if (!byte(0x543836) && (g(0x586a58) & 2 || g(0x5a70d4) & g(0x872dd8) || g(0x17add90) & 2)) {
    p(0x5a70d4, g(0x5a70d4) | 0x2000);
    sound(3);
    return;
  }
  let drag = g(0x7cb034) !== 0;
  if (g(0x17adda8) & 1 || !byte(0x17add76)) {
    p(0x7cb034, 0);
    s.put(0x17add73, 0, 1);
    drag = false;
  }
  if (!drag) {
    if (h.input.hit(21, 0, true) && g(0x17adda0) & 1) {
      p(0x737994, g(0x5b0a5c));
      p(0x7cb034, 1);
      s.put(0x17add73, 1, 1);
      drag = true;
    }
  }
  if (drag) {
    const first = g(0x73798c),
      last = g(0x7fc900),
      total = g(0x80f348);
    const value = f(
      f(f(f(f(total - 506) / 714) * f(g(0x17addf8))) / s.view(0x17adf9c, 4).getFloat32(0, true)) +
        f(g(0x737994)),
    );
    let scroll =
      Number.isFinite(value) && value >= -2147483648 && value < 2147483648
        ? Math.trunc(value)
        : -2147483648;
    if (total - 514 <= scroll) scroll = total - 506;
    if (scroll < 1) scroll = 0;
    p(0x5b0a5c, scroll);
    range();
    if (first !== g(0x73798c) && g(0x810078) < g(0x73798c)) p(0x810078, g(0x73798c));
    if (last !== g(0x7fc900) && g(0x7fc900) < g(0x810078)) p(0x810078, g(0x7fc900));
  }
  for (let row = 0; row < g(0x810074) >>> 0; row++)
    if (h.input.hit(20, row, true)) {
      const ring = g(0x80fa30 + ((g(0x768714) + row) >>> 0) * 4) >>> 0,
        head = g(0x80fa30) >>> 0;
      p(0x810078, (ring - head + (head <= ring ? 0 : 400)) >>> 0);
      if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
      break;
    }
  const total = g(0x80f348),
    wheel = g(0x17addd0);
  if (wheel > 0) {
    p(0x5b0a5c, g(0x5b0a5c) < 33 ? 0 : g(0x5b0a5c) - 32);
    range();
    p(0x810078, g(0x73798c));
  }
  if (wheel < 0) {
    p(0x5b0a5c, g(0x5b0a5c) < total - 538 ? g(0x5b0a5c) + 32 : total - 506);
    range();
    p(0x810078, g(0x7fc900));
  }
  const selected = g(0x810078),
    scroll = g(0x5b0a5c),
    held = g(0x5a70d0),
    pressed = g(0x5a6f74);
  if (!byte(0x543836) && (g(0x586a58) & 1 || g(0x5a70d4) & g(0x872dd4))) {
    if (selected !== -65535) {
      const ring = g(0x80fa30 + (selected >>> 0) * 4) >>> 0,
        voice = g(0x8106c0 + ((ring * 2) >>> 0) * 4);
      if (voice === -1) sound(4);
      else {
        const bank = g(0x8106c0 + ((ring * 2 + 1) >>> 0) * 4),
          setting = s.variable((bank + 0x814) >>> 0) >>> 0;
        if (g(0x17abdc0 + setting * 4) === 1) {
          p(0x5b0a58, 1);
          p(0x5a74a4, 0);
          p(0x5a74a8, 1);
          p(0x5a74ac, 1);
          p(0x5a74a0, voice);
          p(0x80f34c, selected);
          p(0x17abcac, bank);
          p(0x17ac384, bank);
        }
      }
    }
    return;
  }
  let current = g(0x810078);
  if (current === -65535 || g(0x73798c) < current) {
    if (pressed & g(0x872dc0)) current = current === -65535 ? g(0x73798c) : current - 1;
  } else if (held & g(0x872dc0)) {
    p(0x5b0a5c, g(0x5b0a5c) < 9 ? 0 : g(0x5b0a5c) - 8);
    range();
    current = g(0x73798c);
  }
  p(0x810078, current);
  if (current === -65535 || current < g(0x7fc900)) {
    if (pressed & g(0x872dc4)) current = current === -65535 ? g(0x73798c) : current + 1;
  } else if (held & g(0x872dc4)) {
    p(0x5b0a5c, g(0x5b0a5c) < total - 514 ? g(0x5b0a5c) + 8 : total - 506);
    range();
    current = g(0x7fc900);
  }
  p(0x810078, current);
  if (pressed & g(0x872dc8)) {
    p(0x5b0a5c, g(0x5b0a5c) > 510 ? g(0x5b0a5c) - 510 : 0);
    range();
    p(0x810078, g(0x73798c));
  }
  if (pressed & g(0x872dcc)) {
    p(0x5b0a5c, g(0x5b0a5c) < total - 1016 ? g(0x5b0a5c) + 506 : total - 506);
    range();
    p(0x810078, g(0x7fc900));
  }
  if (selected !== g(0x810078)) sound(1);
  const view = s.view(0x5a9aa0, 4);
  view.setFloat32(0, f(view.getFloat32(0, true) + f(f((scroll - g(0x5b0a5c)) | 0) * 0.5)), true);
}
/** 01/10, 14004ee30. */
export function backlog(h: OpcodeExecution): void {
  h.skip(2);
  const mode = h.byte(),
    s = h.state;
  switch (mode) {
    case 0:
    case 10:
      initializeBacklog(s);
      return;
    case 1:
      interactBacklog(h);
      return;
    case 2:
      s.resetText(4);
      return;
    case 3:
      s.setVariable(
        0x3a34 / 4,
        s.get(0x810074) === 0
          ? 65535
          : s.get(0x6e8cc0 + (s.get(0x80fa30 + (s.get(0x810078) >>> 0) * 4) >>> 0) * 4),
      );
      return;
    case 4:
      s.writeSpan(
        0xc491e0,
        s.readSpan(0x1023b60 + (s.variable(0x3a34 / 4) >>> 0) * 0x4a2c, 0x4a2c),
      );
      restoreCheckpoint(h, false);
      return;
    case 5:
      s.put(0x5a74a0, -1);
      s.put(0x5a74ac, 0);
      return;
  }
}
