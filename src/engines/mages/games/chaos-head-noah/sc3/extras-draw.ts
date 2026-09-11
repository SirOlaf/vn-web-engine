import {nativeSampler, nativeBlend} from './render-state.js';
import {tagGlyph, textLocation} from './dom-text-data.js';
import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';

/** Native 140031320 and its decimal atlas helper 140031140. */
export function drawExtras(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []};
  const fade = s.get(0x5af948) >>> 0,
    alpha = Math.imul(fade, 8),
    selected = s.get(0x5b0990) >>> 0,
    unlocked = !!(s.flags[0x65]! & 4);
  const sprite = (
    x: number,
    y: number,
    width: number,
    height: number,
    dx: number,
    dy: number,
    a = alpha,
  ) => {
    const d: SpriteDraw = {
      ...nativeSampler(s),
      texture: 149,
      source: {x, y, width, height},
      destination: {x: dx, y: dy, width, height},
      color: 0xffffff,
      alpha: a,
    };
    out.sprites.push(d);
    out.commands!.push(d);
    return d;
  };
  sprite(0, 0, 1920, 1080, 0, 0);
  let pulse = (s.get(0x5b0a38) + 1) >>> 0;
  if (pulse > 111) pulse = 0;
  s.put(0x5b0a38, pulse);
  const half = pulse >>> 1,
    t = half < 29 ? half : 56 - half,
    q = Math.floor(t / 15);
  sprite(q * 394, (t - q * 15) * 20 + 1086, 394, 20, 270, 647);
  for (let i = 0; i < 4; i++) {
    const enabled = i === 3 || unlocked,
      active = selected === i;
    sprite(enabled ? (active ? 768 : 0) : 384, 1400 + 48 * i, 384, 48, 947, 259 + 61 * i);
    sprite(929, enabled ? 1118 + 32 * i : 1086, 224, 32, 1425, 266 + 61 * i);
    sprite(
      794,
      enabled && active ? 1206 : 1086,
      112,
      60,
      1668,
      252 + 61 * i,
      enabled ? alpha : (fade & 0x1fffffff) << 2,
    );
    if (enabled)
      out.regions.push({group: 12, index: i, x: 1668, y: 252 + 61 * i, width: 112, height: 60});
  }
  const number = (x: number, y: number, value: number, count: number, zero = false) => {
    value >>>= 0;
    const digits: number[] = [];
    for (let i = 3, place = 1000; i > 0; i--, place /= 10) {
      if (value < place) digits[i] = zero ? 0 : 10;
      else {
        zero = true;
        digits[i] = Math.floor(value / place) & 255;
        value = (value - digits[i]! * place) >>> 0;
      }
    }
    digits[0] = value & 255;
    const location = textLocation(s, 'extras-number');
    for (let i = count - 1; i >= 0; i--, x = (x + 26) >>> 0) {
      const digit = digits[i]!,
        d = sprite(794 + digit * 28, 1266, 28, 40, Math.fround(x >>> 0), Math.fround(y >>> 0));
      // 140031140 selects decimal cells 0..9 and blank cell 10. Preserve
      // out-of-range native samples as unknown artwork, not invented digits.
      tagGlyph(
        d,
        location,
        count - 1 - i,
        digit < 10 ? digit + 1 : digit === 10 ? 63 : -1,
        {role: 'body', line: 0},
        d.destination,
        d.color,
        d.alpha,
      );
    }
  };
  const seconds = s.variable(0x1f44 / 4) >>> 0,
    hours = Math.floor(seconds / 3600),
    capped = hours > 999;
  number(1522, 518, capped ? 999 : hours, 3);
  number(1612, 518, capped ? 59 : Math.floor((seconds % 3600) / 60), 2, true);
  number(1676, 518, capped ? 59 : seconds % 60, 2, true);
  number(1619, 558, s.get(0x5afac4), 3);
  number(1619, 598, s.get(0x5a9ac8), 3);
  number(1660, 638, s.get(0x5b09e4), 1);
  number(1702, 638, 9, 1);
  for (let i = 0; i < 9; i++)
    sprite(
      1159,
      1086 + (s.get(0x5b0448 + i * 4) ? (i + 1) * 40 : 0),
      384,
      40,
      961 + 397 * (i % 2),
      681 + 40 * Math.floor(i / 2),
    );
  const marker = s.get(0x5b04b8) >>> 0;
  s.put(0x5b09b8 + marker * 4, 2);
  s.put(0x5b04b8, marker + 1);
  return out;
}
