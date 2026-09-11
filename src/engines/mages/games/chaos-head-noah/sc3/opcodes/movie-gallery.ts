import type {OpcodeExecution} from './types.js';

// Game.exe 1401d6d60; verified against the 13-entry native movie selection table.
const movies = [32, 63, 33, 65, 64, 39, 40, 41, 42, 43, 44, 45, 46];

/** 14005aa40 -> 140010180/140010260. Movie playback is requested through
 * script variable 23f4; the script owns the actual movie-device commands. */
export function movieGallery(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    s = h.state;
  const g = (a: number) => s.get(a) >>> 0,
    p = (a: number, n: number) => s.put(a, n);
  if (selector === 0) {
    for (let i = 0; i < 5; i++) s.put(0x543838 + i, (s.flags[0x6b]! >>> (i + 2)) & 1, 1);
    for (let i = 0; i < 8; i++) s.put(0x54383d + i, (s.flags[0x6c]! >>> i) & 1, 1);
    s.setVariable(0x23f4 / 4, 255);
    if (g(0x17acb78)) p(0x5451d4, 255);
    return;
  }
  if (selector !== 1) return;
  const sound = (id: number) => {
    const volume = Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8)) * 70) / 100)) >>> 0;
    p(0x5a7100, volume);
    h.sound(id, volume);
  };
  // Native computes the movie/unlock index BEFORE hover changes the cursor.
  const selected = (g(0x5451d4) + g(0x543034)) >>> 0;
  for (let i = 0; i < 20; i++)
    if (h.input.hit(21, i, true)) {
      p(0x5451d4, i);
      if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
      break;
    }
  if (g(0x5451d4) < 255 && g(0x872dd4) & g(0x5a70d4) && s.bytes(0x543838 + selected, 1)[0]) {
    sound(2);
    const movie = movies[selected];
    if (movie === undefined)
      throw new Error('Native movie-gallery table index outside its 13 entries');
    s.setVariable(0x23f4 / 4, movie);
    return;
  }
  if (
    !s.bytes(0x543836, 1)[0] &&
    (g(0x586a58) & 2 || g(0x872dd8) & g(0x5a70d4) || g(0x17add90) & 2)
  ) {
    sound(3);
    p(0x5a70d4, g(0x5a70d4) | g(0x872dd8));
    return;
  }
  if (g(0x5a6f74) & g(0x872dc8)) {
    sound(1);
    const n = g(0x5451d4);
    p(0x5451d4, n === 255 ? 0 : n < 11 && (0x421 >>> n) & 1 ? Math.min(n + 4, 12) : n - 1);
  }
  if (g(0x5a6f74) & g(0x872dcc)) {
    sound(1);
    const n = g(0x5451d4);
    p(0x5451d4, n === 255 ? 0 : n === 12 ? 10 : n === 4 || n === 9 ? n - 4 : n + 1);
  }
  if (g(0x5a6f74) & g(0x872dc0)) {
    sound(1);
    let n = g(0x5451d4);
    if (n === 255) n = 0;
    else if (n < 5) {
      while (n + 5 < 13) n += 5;
    } else n -= 5;
    p(0x5451d4, n);
  }
  if (g(0x5a6f74) & g(0x872dc4)) {
    sound(1);
    const n = g(0x5451d4);
    p(0x5451d4, n === 255 ? 0 : n + 5 > 12 ? n % 5 : n + 5);
  }
}
