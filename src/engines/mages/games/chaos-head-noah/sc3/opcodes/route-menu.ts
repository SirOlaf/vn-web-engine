import type {OpcodeExecution} from './types.js';

/** Entire 10/25 -> 140033640 / 1400337a0, including the two-column wrap rules. */
export function routeMenu(h: OpcodeExecution): void {
  h.skip(2);
  const mode = h.byte(),
    s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v);
  if (mode === 0) {
    for (let i = 0; i < 9; i++) p(0x5b09f0 + i * 4, i);
    let count = 9;
    p(0x5afa28, count);
    for (const [byte, mask, id] of [
      [0x6d, 4, 9],
      [0x6d, 8, 10],
      [0x6d, 16, 11],
      [0x6e, 2, 12],
      [0x6d, 64, 13],
      [0x6e, 2, 14],
      [0x6d, 128, 15],
      [0x6d, 32, 16],
      [0x6e, 4, 17],
    ])
      if (s.flags[byte!]! & mask!) {
        p(0x5b09f0 + count * 4, id!);
        p(0x5afa28, ++count);
      }
    return;
  }
  if (mode !== 1) return;
  const sound = (id: number) => {
    const volume =
      Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8) >>> 0) * 70) / 100)) >>> 0;
    p(0x5a7100, volume);
    h.sound(id, volume);
  };
  for (let row = 0; row < 18; row++)
    if (h.input.hit(13, row, true)) {
      sound(1);
      p(0x5af92c, row);
      if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
      break;
    }
  if (
    !s.bytes(0x543836, 1)[0] &&
    (g(0x586a58) & 2 || g(0x5a70d4) & g(0x872dd8) || g(0x17add90) & 2)
  ) {
    sound(3);
    s.setVariable(0x36cc / 4, 255);
    return;
  }
  if (g(0x5a70d4) & g(0x872dd4)) {
    sound(2);
    s.setVariable(0x36cc / 4, g(0x5b09f0 + (g(0x5af92c) >>> 0) * 4));
    return;
  }
  if (g(0x5a6f74) & g(0x872dc0)) {
    sound(1);
    let row = g(0x5af92c) >>> 0;
    if (row < 2) {
      while ((row + 2) >>> 0 < g(0x5afa28) >>> 0) {
        row = (row + 2) >>> 0;
        p(0x5af92c, row);
      }
    } else p(0x5af92c, row - 2);
  }
  let row = g(0x5af92c) >>> 0;
  if (g(0x5a6f74) & g(0x872dc4)) {
    sound(1);
    const next = (row + 2) >>> 0;
    if (g(0x5afa28) >>> 0 <= next) {
      if (row > 1) {
        row &= 1;
        p(0x5af92c, row);
      }
    } else row = next;
  }
  p(0x5af92c, row);
  const other = (row ^ 1) >>> 0;
  if (g(0x5a6f74) & (g(0x872dcc) | g(0x872dc8)) && other < g(0x5afa28) >>> 0) {
    p(0x5af92c, other);
    sound(1);
  }
  h.retry();
}
