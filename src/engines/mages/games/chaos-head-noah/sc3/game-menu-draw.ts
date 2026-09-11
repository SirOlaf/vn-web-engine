import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import {gameMenuRegions} from './game-menu-regions.js';
import {nativeBlend, nativeSampler} from './render-state.js';
/** Native menu painters append a navigation-strip selector for 140028eb0. */
export function appendMenuMarker(s: NoahState, id: number): void {
  const count = s.get(0x5b04b8) >>> 0;
  s.put(0x5b09b8 + count * 4, id);
  s.put(0x5b04b8, count + 1);
}
/** 14002c6b0: in-game menu reveal, disabled atlas variants and stepped hit silhouettes. */
export function drawGameMenu(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    progress = s.variable(0x2178 / 4) >>> 0,
    selected = s.variable(0x3428 / 4),
    a0 = s.flags[0xa0]!,
    e5 = s.flags[0xe5]!;
  let allSlots = true;
  for (let i = 0; i < 48; i++)
    if (!(s.bytes(0x8732ac + i * 0x1474c, 1)[0]! & 1)) {
      allSlots = false;
      break;
    }
  const emit = (
    sx: number,
    sy: number,
    width: number,
    height: number,
    x: number,
    y: number,
    alpha: number,
  ) => {
    const d = {
      texture: 96,
      source: {x: sx, y: sy, width, height},
      destination: {x, y, width, height},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha | 0)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    };
    out.sprites.push(d);
    out.commands!.push(d);
  };
  const offset = progress < 12 ? 500 - Math.floor((progress * 500) / 12) : 0,
    alpha = progress < 12 ? Math.floor((progress << 8) / 12) : 256;
  emit(1386, 1992, 738, 312, -offset | 0, offset + 768, alpha);
  emit(0, 1344, 570, 174, offset + 1350, -offset | 0, alpha);
  const fade = (start: number) =>
    progress > start ? Math.min(256, (progress * 32 - start * 32) >>> 0) : 0;
  const rows = [
    [selected === 0 ? 678 : e5 & 32 || a0 & 128 ? 1356 : 0, 2352, 672, 258, 1248, 0, fade(12)],
    [
      636,
      selected === 1 ? 1680 : allSlots || !(a0 & 32) || a0 & 4 ? 2016 : 1344,
      744,
      330,
      1176,
      0,
      fade(14),
    ],
    [1386, selected === 2 ? 1572 : 1152, 828, 414, 1092, 0, fade(16)],
    [2220, selected === 3 ? 1500 : a0 & 4 ? 2016 : 984, 894, 510, 1026, 0, fade(18)],
    [3120, selected === 4 ? 1602 : 984, 972, 612, 948, 0, fade(20)],
    [0, selected === 5 ? 672 : 0, 1128, 666, 0, 414, fade(18)],
    [1134, selected === 6 ? 576 : 0, 1044, 570, 0, 510, fade(16)],
    [2184, selected === 7 ? 492 : 0, 960, 486, 0, 594, fade(14)],
    [3150, selected === 8 ? 414 : 0, 846, 408, 0, 672, fade(12)],
  ];
  for (const [index, row] of rows.entries()) {
    const [sx, sy, w, h, x, y, a] = row as [number, number, number, number, number, number, number];
    if (!a) continue;
    emit(sx, sy, w, h, x, y, a);
    for (const [x, y, width, height] of gameMenuRegions[index]!)
      out.regions.push({group: 10, index, x: x!, y: y!, width: width!, height: height!});
  }
  appendMenuMarker(s, 2);
  return out;
}
/** 140033cd0: ending selection, row-major 2 by 9 native atlas entries. */
export function drawEndingMenu(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    alpha = Math.max(0, Math.min(255, s.variable(0x218c / 4) << 3));
  const emit = (sx: number, sy: number, width: number, height: number, x: number, y: number) => {
    const d = {
      ...nativeSampler(s),
      texture: 166,
      source: {x: sx, y: sy, width, height},
      destination: {x, y, width, height},
      color: 0xffffff,
      alpha,
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    };
    out.sprites.push(d);
    out.commands!.push(d);
  };
  emit(0, 0, 1920, 1080, 0, 0);
  for (let i = 0; i < 18 && i < s.get(0x5afa28) >>> 0; i++) {
    const id = s.get(0x5b09f0 + i * 4),
      x = 487 + (i % 2) * 600,
      y = 172 + Math.floor(i / 2) * 90,
      selected = s.get(0x5af92c) === i;
    let sx = Math.imul(Math.trunc(id / 9), 690);
    if (selected) {
      sx = (sx + 345) | 0;
      emit(0, 1086, 540, 84, x - 97, y - 2);
    }
    emit(sx, (Math.imul(id % 9, 81) + 1176) | 0, 345, 81, x, y);
    out.regions.push({group: 13, index: i, x, y, width: 345, height: 81});
  }
  appendMenuMarker(s, 2);
  return out;
}
