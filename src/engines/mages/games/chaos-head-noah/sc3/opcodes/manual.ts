import type {OpcodeExecution} from './types.js';

/** 10/1a, 14005a7c0 and 14003e090: native manual navigation. */
export function manual(h: OpcodeExecution): void {
  const s = h.state,
    g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v);
  const cancel = () =>
    !s.bytes(0x543836, 1)[0] && (g(0x586a58) & 2 || g(0x5a70d4) & g(0x872dd8) || g(0x17add90) & 2);
  const close = () => {
    const volume =
      Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8) >>> 0) * 70) / 100)) >>> 0;
    p(0x5a7100, volume);
    h.sound(3, volume);
    s.flags[0xe4] = s.flags[0xe4]! | 64;
  };
  h.skip(2);
  const mode = h.byte();
  if (mode === 1) {
    if (cancel()) close();
    return;
  }
  if (mode === 10) {
    for (const a of [0x5afaa4, 0x5af940, 0x5a9ab8, 0x5a9ac4]) p(a, 0);
    s.flags[0xa8] = s.flags[0xa8]! & ~11;
    s.setVariable(0x2410 / 4, g(0x5afa98));
    s.setVariable(0x2414 / 4, 0xa4);
    s.flags[0xa8] = s.flags[0xa8]! | 1;
    return;
  }
  if (mode !== 11 || !(s.flags[0xa8]! & 2)) return;
  if (g(0x5a9ab8) !== 0) {
    p(0x5a9ab8, g(0x5a9ab8) - 1);
    return;
  }
  if (g(0x17add90) & 1) p(0x5a6f74, g(0x5a6f74) | 0x200);
  else if (g(0x17addd0) > 0) p(0x5a6f74, g(0x5a6f74) | 0x100);
  else if (g(0x17addd0) < 0) p(0x5a6f74, g(0x5a6f74) | 0x200);
  if (cancel()) {
    close();
    s.flags[0xa8] = s.flags[0xa8]! | 8;
    return;
  }
  const count = h.manualPageCount() >>> 0;
  if (count <= 1 || s.bytes(0x543836, 1)[0]) return;
  const input = g(0x5a6f74),
    mouse = g(0x586a58);
  if (input & 0x200 || mouse & 0x110 || input & g(0x872dcc)) {
    let page = (g(0x5afa98) + 1) >>> 0;
    if (page >= count) page = 0;
    p(0x5afa98, page);
    p(0x5a9ac4, -48);
  } else if (input & 0x100 || mouse & 0x88 || input & g(0x872dc8)) {
    let page = (g(0x5afa98) - 1) | 0;
    if (page < 0) page = (count - 1) | 0;
    p(0x5afa98, page);
    p(0x5a9ac4, 48);
  } else return;
  p(0x5af940, g(0x5afaa4));
  p(0x5afaa4, (g(0x5afaa4) - 1) & 1);
  p(0x5a9ab8, 16);
  s.setVariable(0x2414 / 4, g(0x5afaa4) + 0xa4);
  s.setVariable(0x2410 / 4, g(0x5afa98));
  s.flags[0xa8] = (s.flags[0xa8]! | 3) ^ 2;
}
