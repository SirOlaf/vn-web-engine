import type {OpcodeExecution} from './types.js';
import type {NoahState} from '../noah-state.js';

// Native byte table 1401d6d30. Playback-mode bytes at 140543800 are mutable state.
export const musicRoomTracks = [
  1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 33, 35, 37, 39, 41, 43, 45, 47, 49, 50, 53,
  55, 57, 59, 64, 76, 77, 78, 79, 66, 70, 71, 72, 73, 74, 75, 68, 69, 82, 84, 85, 86,
];

/** 14000e890 performs 47 complete passes, consuming exactly 2209 rand calls. */
function shuffle(s: NoahState): void {
  const order = s.bytes(0x543850, 47);
  for (let i = 0; i < 47; i++) order[i] = i;
  for (let pass = 0; pass < 47; pass++)
    for (let i = 0; i < 47; i++) {
      const j = ((s.random15() & 32767) * 47) >>> 15,
        t = order[i]!;
      order[i] = order[j]!;
      order[j] = t;
    }
}

/** 14000e600 merges paired tracks and ending-unlocked songs. */
function unlockTracks(s: NoahState): void {
  const b = s.bytes(0x17acbd0, 200);
  for (let i = 0; i <= 56; i += 2) if (i !== 30) b[i + 1] = b[i + 1]! | b[i]!;
  for (const [track, byte, bit] of [
    [64, 0x6f, 7],
    [66, 0x70, 0],
    [68, 0x70, 1],
    [69, 0x70, 2],
    [70, 0x70, 3],
    [71, 0x70, 4],
    [72, 0x70, 5],
    [73, 0x70, 6],
    [74, 0x70, 7],
    [75, 0x71, 0],
    [76, 0x71, 1],
    [77, 0x71, 2],
    [78, 0x71, 3],
    [79, 0x71, 4],
    [82, 0x71, 5],
    [85, 0x71, 7],
    [86, 0x72, 0],
  ])
    b[track!] = b[track!]! | ((s.flags[byte!]! >>> bit!) & 1);
  b[84] = b[84]! | 1;
  b[59] = b[59]! | b[58]! | ((s.flags[0x72]! >>> 1) & 1);
}

/** 14005a960 -> 14000e920/14000eca0, including all four native playback modes. */
export function musicRoom(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    s = h.state,
    g = (a: number) => s.get(a) >>> 0,
    p = (a: number, n: number) => s.put(a, n);
  const b = (a: number) => s.bytes(a, 1)[0]!;
  if (selector === 0) {
    unlockTracks(s);
    for (let i = 0; i < 47; i++) {
      const unlocked = b(0x17acbd0 + musicRoomTracks[i]!);
      s.put(0x5451f0 + i, unlocked, 1);
      if (g(0x20b5d8) === 65535 && unlocked) p(0x20b5d8, i);
    }
    for (const [a, n] of [
      [0x54388c, 0],
      [0x20bb90, 255],
      [0x20b5dc, 255],
      [0x543044, 0],
      [0x5425a4, 2],
      [0x543030, 0],
      [0x54356c, 0],
    ])
      p(a!, n!);
    shuffle(s);
    p(0x5451d0, 0);
    if (g(0x17acb78)) p(0x543040, 255);
    for (const [a, n] of [
      [0x5451e8, 0],
      [0x5451c0, 0],
      [0x20a694, 65535],
      [0x5425b0, 0],
    ])
      p(a!, n!);
    return;
  }
  if (selector !== 1) return;
  const sound = (id: number) => {
    const volume = Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8)) * 70) / 100)) >>> 0;
    p(0x5a7100, volume);
    h.sound(id, volume);
  };
  const audio = (channel: number) => 0x5a7110 + channel * 0x98;
  const initial = audio(g(0x20dde8)),
    idle = !g(initial + 12),
    loading = !!g(initial + 0x20);
  if (g(0x20bb90) === 255) {
    if (g(0x54388c)) p(0x54388c, g(0x54388c) - 8);
  } else if (g(0x54388c) < 256) p(0x54388c, g(0x54388c) + 8);
  if (b(0x17adda8) & 1 || !b(0x17add76)) {
    p(0x5451bc, 0);
    s.put(0x17add73, 0, 1);
  }
  if (!g(0x5451bc) && h.input.hit(22, 1, true) && b(0x17adda0) & 1) {
    p(0x54303c, g(0x545220));
    p(0x5451bc, 1);
    s.put(0x17add73, 1, 1);
  }
  if (g(0x5451bc)) {
    const f = Math.fround,
      scale = s.view(0x17adf9c, 4).getFloat32(0, true);
    const n = Math.trunc(f(f(f(f(s.get(0x17addf8)) * f(0.07625272)) / scale) + f(s.get(0x54303c))));
    p(0x545220, Math.min(35, Math.max(0, n)));
  }
  if (h.input.hit(22, 2, true) && b(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872e08));
  if (h.input.hit(22, 0, true) && b(0x17add90) & 1) {
    const x = Math.max(0, Math.min(191, s.get(0x17adddc) - 1245));
    p(0x17acb7c, Math.trunc((x * 128) / 191));
  }
  for (let i = 0; i < 12; i++)
    if (h.input.hit(21, i, true)) {
      p(0x543040, i);
      if (b(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
      break;
    }
  const oldRow = s.get(0x543040);
  if (s.get(0x17addd0) > 0 && s.get(0x545220) > 0) p(0x545220, g(0x545220) - 1);
  if (s.get(0x17addd0) < 0 && s.get(0x545220) < 35) p(0x545220, g(0x545220) + 1);
  const oldScroll = s.get(0x545220),
    repeat = (mask: number) => !!(g(0x5a6f74) & g(mask));
  if (repeat(0x872dc0)) {
    if (s.get(0x545220) < 1 || s.get(0x543040) > 1) {
      if (g(0x543040)) p(0x543040, g(0x543040) - 1);
    } else p(0x545220, g(0x545220) - 1);
  }
  if (repeat(0x872dc4)) {
    if (s.get(0x545220) < 35 && s.get(0x543040) > 9) p(0x545220, g(0x545220) + 1);
    else if (s.get(0x543040) < 11) p(0x543040, g(0x543040) + 1);
  }
  if (repeat(0x872dc8)) {
    if (!g(0x545220)) p(0x543040, 0);
    else p(0x545220, s.get(0x545220) > 11 ? s.get(0x545220) - 12 : 0);
  }
  if (repeat(0x872dcc)) {
    if (g(0x545220) === 35) p(0x543040, 11);
    else p(0x545220, Math.min(s.get(0x545220) + 12, 35));
  }
  if (oldRow !== s.get(0x543040) || oldScroll !== s.get(0x545220)) sound(1);
  const request = (index: number, channel = g(0x20dde8)) => {
    const track = musicRoomTracks[index];
    if (track === undefined)
      throw new Error('Native music-room track index outside its 47 entries');
    const a = audio(channel);
    p(a, track);
    p(a + 4, b(0x543800 + index));
    p(a + 8, 1);
    p(a + 12, 1);
    p(a + 0x3c, 0);
  };
  if (!b(0x543836)) {
    if (g(0x586a58) & 2 || g(0x872dd8) & g(0x5a70d4) || b(0x17add90) & 2) {
      sound(3);
      p(0x20b5d8, 255);
      p(0x20b5dc, 255);
      p(0x20bb90, 255);
      return;
    }
    if (g(0x586a58) & 1 || g(0x872dd4) & g(0x5a70d4)) {
      const index = (g(0x543040) + g(0x545220)) >>> 0;
      if (b(0x5451f0 + (index | 0)) && g(0x20b5dc) !== index) {
        p(0x20b5d8, index);
        p(0x20b5dc, index);
        request(index);
      }
    }
  }
  if (g(0x872e04) & g(0x5a70d4)) {
    p(0x20bb90, 255);
    p(0x20b5dc, 255);
    p(0x20b5d8, 255);
    const a = audio(g(0x20dde8));
    p(a, -1);
    p(a + 12, 0);
    p(a + 0x50, 1);
    p(a + 0x54, (g(a + 0x68) & 65535) << 11);
  }
  if (g(0x872e08) & g(0x5a70d4)) {
    sound(2);
    p(0x5425a4, g(0x5425a4) + 1);
    if (g(0x5425a4) === 4) p(0x5425a4, 1);
    if (g(0x5425a4) === 3) {
      p(0x54356c, 0);
      shuffle(s);
    }
  }
  // 140001320 constructs the native mode vector [0,1,2,3]. Its only other
  // reference is its destructor. An out-of-range index throws natively.
  const mode = g(0x5425a4);
  if (mode >= 4) throw new RangeError('Native music-room mode vector subscript');
  const a = audio(g(0x20dde8)),
    ended = g(a + 0x3c);
  let playing = false;
  if (!ended && g(a + 0x38) === 1) {
    p(0x543030, g(a + 0x64));
    playing = true;
    p(0x543044, g(a + 0x58));
  }
  if (!g(a + 0x38) || loading || !idle) {
    p(0x543044, 0);
    p(0x543030, 0);
  }
  if (mode === 1) {
    if (ended) {
      const channel = g(0x20dde8);
      h.stopAudioDevice(channel);
      p(0x5a70d8 + channel * 4, 0);
      request(g(0x20bb90));
    }
  } else if (ended === 1 && !loading && idle) {
    if (mode === 0 || mode === 2) {
      let index = g(0x20b5dc);
      do {
        index = (index + 1) >>> 0;
        p(0x20b5dc, index);
        if (index >= 47) {
          if (mode === 0) {
            p(0x20b5d8, 255);
            p(a, -1);
            p(0x20b5dc, 255);
            p(0x20bb90, 255);
            p(a + 12, 0);
            break;
          }
          index = 0;
          p(0x20b5dc, 0);
        }
      } while (!b(0x5451f0 + index));
      if (mode === 2 || index < 47) {
        p(0x20b5d8, index);
        request(index);
      }
    } else {
      let index: number;
      do {
        p(0x54356c, g(0x54356c) + 1);
        if (g(0x54356c) >= 47) {
          p(0x54356c, 0);
          shuffle(s);
        }
        index = b(0x543850 + g(0x54356c));
      } while (index === g(0x20b5dc) || b(0x5451f0 + index) !== 1);
      p(0x20b5d8, index);
      p(0x20b5dc, index);
      request(index);
    }
  }
  if (playing) {
    if (!loading && idle) p(0x20bb90, g(0x20b5dc));
    if (g(0x20bb90) === 255) p(0x20bb90, g(0x20b5dc));
  } else if (!loading && idle) p(0x20bb90, 255);
}
