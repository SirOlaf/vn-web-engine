import {nativeSampler, nativeBlend} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {
  configWidthsJapanese,
  configWidthsEnglish,
  configVoiceTable,
  configPadBindings,
  configPadIcons,
  configPadGlyphs,
} from './config-data.js';

/** 14003aa50 and its five tab renderers. Settings previews and committed markers
 * are distinct native layers; hit geometry is independent of their opacity. */
export function drawConfig(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    g = (a: number) => s.get(a) >>> 0;
  const alpha = Math.imul(s.variable(0x218c / 4), 8),
    tab = g(0x5b09b4),
    row = g(0x5b09a0 + tab * 4),
    editing = g(0x5af928) === 2;
  const pointer = Number(s.view(0x5b0440, 8).getBigUint64(0, true));
  const widths =
    pointer === 0x14020bbb8
      ? configWidthsEnglish
      : pointer === 0x14020d398
        ? configWidthsJapanese
        : undefined;
  const sprite = (
    x: number,
    y: number,
    width: number,
    height: number,
    dx: number,
    dy: number,
    a = alpha,
    texture = 152,
    color = 0xffffff,
  ) => {
    const d: SpriteDraw = {
      ...nativeSampler(s),
      texture,
      source: {x, y, width, height},
      destination: {x: dx, y: dy, width, height},
      color,
      alpha: a,
    };
    out.sprites.push(d);
    out.commands!.push(d);
  };
  const hit = (group: number, index: number, x: number, y: number, width: number, height: number) =>
    out.regions.push({group, index, x, y, width, height});
  const edit = (i: number) => editing && row === i;
  const label = (i: number, sy: number, sx = 0, width = 640, offset = 432, a = alpha) => {
    sprite(sx, sy + (edit(i) ? offset : 0), width, 36, 242, 425 + 59 * i, a);
    sprite(0, 1346, 1443, 6, 238, 466 + 59 * i, a);
  };
  const rowHit = (i: number) => hit(20, i, 238, 413 + 59 * i, 1443, 54);
  const options = (
    i: number,
    start: number,
    sy: number,
    values: readonly number[],
    live: number,
    saved: number,
    a = alpha,
    dx = 2,
  ) => {
    if (!widths) throw new Error(`Unknown Config option-width table 0x${pointer.toString(16)}`);
    const ws = values.map((_, n) => widths[start + n]!);
    let x = 1667 - ws.reduce((a, b) => a + b, 0);
    const xs: number[] = [];
    values.forEach((_, n) => {
      xs.push(x);
      sprite(1449, sy + n * 40, ws[n]!, 40, x, 424 + 59 * i, a);
      x += ws[n]!;
    });
    // The three-choice resolution row treats values outside 1/2 as choice zero;
    // binary choices distinguish zero from every nonzero value.
    const choice = (value: number) =>
      values.length === 3
        ? value === 1
          ? 1
          : value === 2
            ? 2
            : 0
        : values.indexOf(value === 0 ? 0 : 1);
    if (edit(i)) {
      values.forEach((value, n) => hit(22, value, xs[n]!, 424 + 59 * i, 42, 42));
      sprite(1517, 1408, 42, 42, xs[choice(g(live))]! + dx, 419 + 59 * i, a);
    }
    sprite(1565, 1408, 42, 42, xs[choice(g(saved))]! + dx, 419 + 59 * i, a);
  };
  const slider = (
    i: number,
    sy: number,
    live: number,
    saved: number,
    position: (value: number) => number,
  ) => {
    label(i, sy);
    sprite(1359, 1366, 539, 38, 1130, 424 + 59 * i);
    rowHit(i);
    if (edit(i)) {
      sprite(1449, 1408, 28, 28, position(g(live)), 419 + 59 * i);
      hit(23, 0, 1205, 423 + 59 * i, 382, 46);
    }
    sprite(1483, 1408, 28, 28, position(g(saved)), 419 + 59 * i);
  };
  sprite(0, 0, 1920, 1080, 0, 0);
  sprite(0, 1086 + (tab === 4 ? 1440 : Math.imul(tab, 65)), 1443, 59, 238, 323);
  for (let i = 0; i < 5; i++) hit(21, i, 270 + 256 * i, 323, 224, 59);
  if (tab <= 2 && alpha >>> 0 > 254) sprite(0, 2256, 1438, 60, 240, Math.imul(row + 7, 59));
  switch (tab) {
    case 0:
      label(0, 1390);
      rowHit(0);
      options(0, 0, 1086, [1, 0], 0x17adca0, 0x5b0980, alpha, 4);
      label(1, 1426);
      rowHit(1);
      options(1, 0, 1086, [1, 0], 0x17acba0, 0x5afadc);
      label(2, 2380, 0, 320, 36);
      rowHit(2);
      options(2, 6, 1466, [0, 1], 0x17abc08, 0x5af938);
      label(3, 2452, 0, 640, 36);
      rowHit(3);
      options(3, 8, 1546, [0, 1, 2], 0x17abdac, 0x5af93c);
      {
        const a = s.variable(0x2104 / 4) !== 0 ? alpha >>> 1 : alpha;
        label(4, 2380, 360, 320, 36, a);
        rowHit(4);
        options(4, 11, 1666, [0, 1], 0x17ac318, 0x5a9acc, a);
      }
      if (g(0x17abe94) !== 0) {
        label(5, 1462);
        rowHit(5);
        options(5, 0, 1086, [1, 0], 0x17a0cdc, 0x5a7104);
      }
      break;
    case 1:
      slider(
        0,
        1498,
        0x17a0cd8,
        0x5a97d4,
        (n) => Math.floor((Math.imul(n - 256, 350) >>> 0) / 3840) + 1205,
      );
      slider(
        1,
        1534,
        0x17adca8,
        0x5a9ab4,
        (n) => (1555 - Math.floor((Math.imul(n - 256, 350) >>> 0) / 1792)) | 0,
      );
      label(2, 1570);
      rowHit(2);
      options(2, 4, 1246, [0, 1], 0x17abc00, 0x5afa90);
      break;
    case 2:
      [
        [0x17abdbc, 0x5af924],
        [0x17acb7c, 0x5afa94],
        [0x17abe88, 0x5a9a9c],
        [0x17abdb8, 0x5afa88],
      ].forEach(([live, saved], i) =>
        slider(i, 1606 + 36 * i, live!, saved!, (n) => (Math.imul(n, 350) >>> 7) + 1205),
      );
      label(4, 1750);
      rowHit(4);
      options(4, 2, 1166, [1, 0], 0x17add34, 0x5af944);
      label(5, 1786);
      rowHit(5);
      options(5, 2, 1166, [1, 0], 0x17abc04, 0x5afac8);
      break;
    case 3:
      if (alpha >>> 0 > 254)
        sprite(0, 2316, 706, 60, 239 + (row & 1) * 736, 410 + (row >>> 1) * 59);
      for (let i = 0; i < Math.min(g(0x5a9ab0), 18); i++) {
        const id = g(0x5b0470 + i * 4),
          voice = configVoiceTable[id * 4],
          atlas = configVoiceTable[id * 4 + 2];
        if (voice === undefined || atlas === undefined)
          throw new Error(`Unknown Config voice entry ${id}`);
        const x = 239 + (i & 1) * 736,
          y = 410 + (i >>> 1) * 59,
          sy = edit(i) ? (g(0x1badfbc) === 0 ? 324 : 432) : 0;
        sprite(
          (Math.floor(atlas / 9) + 2) * 320,
          1390 + (atlas % 9) * 36 + sy,
          320,
          36,
          x + 3,
          y + 16,
          g(0x17abdc0 + voice * 4) ? alpha : Math.trunc(alpha / 2),
        );
        sprite(0, 1352, 712, 6, x - 2, y + 58);
        hit(20, i, x - 2, y, 712, 54);
        sprite(1449, 1326, 449, 38, x + 244, y + 14);
        if (edit(i)) {
          sprite(
            1449,
            1408,
            28,
            28,
            ((Math.imul(g(0x17abcd0 + voice * 4), 270) >>> 7) + 316 + x) | 0,
            y + 6,
          );
          hit(23, 0, x + 316, y + 10, 302, 46);
        }
        sprite(
          1483,
          1408,
          28,
          28,
          ((Math.imul(g(0x5a9ad0 + voice * 4), 270) >>> 7) + 316 + x) | 0,
          y + 6,
        );
      }
      break;
    case 4:
      if (alpha >>> 0 > 254) {
        const col = Math.floor(row / 5);
        sprite(0, 2316, 706, 60, 239 + col * 720, 410 + row * 59 - col * 295);
      }
      for (let i = 0, sy = g(0x1badfbc) === 0 ? 2632 : 2635; i < 10; i++) {
        const x = i < 5 ? 239 : 959,
          y = 410 + (i % 5) * 59,
          button = s.view(configPadBindings[i]!, 2).getInt16(0, true);
        sprite(edit(i) ? 576 : 0, sy, 558, 34, x + 2, y + 12);
        sprite(0, 1346, 706, 6, x - 2, y + 53);
        if (button !== -1) {
          const icon = configPadIcons[button],
            glyph = icon === undefined ? undefined : configPadGlyphs.slice(icon * 4, icon * 4 + 4);
          if (!glyph || glyph.length !== 4)
            throw new Error(`Unknown native controller icon ${button}`);
          sprite(
            glyph[0]!,
            glyph[1]! + 288,
            glyph[2]!,
            glyph[3]!,
            x + 640,
            y + 12,
            alpha,
            148,
            0x808080,
          );
        }
        if (i !== 5) sy += 36;
      }
      break;
    default:
      return out;
  }
  const i = g(0x5b04b8);
  s.put(0x5b09b8 + i * 4, tab === 3 ? 4 : 5);
  s.put(0x5b04b8, i + 1);
  return out;
}
