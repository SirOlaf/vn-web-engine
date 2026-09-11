import type {OpcodeExecution} from './types.js';

/** 00/44 -> 14002c580 / 14002e220. Native nine-item in-game menu. */
export function systemMenu(h: OpcodeExecution): void {
  h.skip(2);
  const mode = h.byte();
  if (mode > 1) return;
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v);
  let full = true;
  for (let i = 0; i < 48; i++)
    if (!(s.bytes(0x8732ac + i * 0x1474c, 1)[0]! & 1)) {
      full = false;
      break;
    }
  const flags = s.flags[0xa0]!,
    extra = s.flags[0xe5]!,
    disabled = (index: number) =>
      index === 0
        ? !!(flags & 128 || extra & 32)
        : index === 1
          ? full || !(flags & 32) || !!(flags & 4)
          : index === 3
            ? !!(flags & 4)
            : false;
  let selected = s.variable(0x3428 / 4) >>> 0;
  if (mode === 0) {
    if (disabled(selected))
      do {
        selected = selected > 7 ? 0 : (selected + 1) >>> 0;
      } while (disabled(selected));
    s.setVariable(0x3428 / 4, selected);
    return;
  }
  const volume = () =>
    Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8) >>> 0) * 70) / 100)) >>> 0;
  const sound = (id: number) => {
    const value = volume();
    p(0x5a7100, value);
    h.sound(id, value);
  };
  for (let row = 0; row < 9; row++)
    if (h.input.hit(10, row, true)) {
      if (s.variable(0x3428 / 4) >>> 0 !== row) {
        if (disabled(row)) break;
        sound(1);
        selected = row;
      }
      if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
      break;
    }
  if (g(0x5a70d4) & g(0x872dd4)) {
    if (disabled(selected)) {
      p(0x5a70d4, g(0x5a70d4) & ~g(0x872dd4));
      p(0x5a7100, volume());
    } else sound(2);
    return;
  }
  if (g(0x5a6f74) & g(0x872dc0)) {
    sound(1);
    do {
      selected = selected === 0 ? 8 : (selected - 1) >>> 0;
    } while (disabled(selected));
  }
  if (g(0x5a6f74) & g(0x872dc4)) {
    sound(1);
    do {
      selected = selected > 7 ? 0 : (selected + 1) >>> 0;
    } while (disabled(selected));
  }
  s.setVariable(0x3428 / 4, selected);
}
