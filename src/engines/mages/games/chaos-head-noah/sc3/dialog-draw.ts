import {fixedTextLocation, type TextRun} from './dom-text-data.js';
import {nativeSampler, nativeBlend} from './render-state.js';
import type {DrawList, SpriteDraw} from '../../../../../graphics/draw-list.js';
import type {HitRegion} from './input.js';
import type {MessageBoxes} from './message-boxes.js';
import {drawMenuText} from './menu-text-draw.js';

// Pinned executable table 1401d8090: atlas x/y, height, destination y/2.
const strips = [
  [0, 0, 252, 6],
  [966, 0, 206, 79],
  [0, 252, 298, 163],
  [966, 206, 302, 163],
  [966, 1220, 34, 134],
  [0, 550, 286, 70],
  [966, 1158, 62, 430],
  [0, 836, 418, 15],
  [966, 820, 338, 5],
  [966, 508, 140, 212],
  [966, 648, 172, 84],
] as const;
export interface DialogDrawList extends DrawList {
  regions: HitRegion[];
}

/** Dialog specialization of the shared native menu text routine. */
export function drawDialogText(
  boxes: MessageBoxes,
  address: number,
  x: number,
  y: number,
  width: number,
  color: number,
  size: number,
  alpha: number,
  run?: TextRun,
): SpriteDraw[] {
  return drawMenuText(boxes.state, boxes.host, address, x, y, width, color, size, alpha, 91, run);
}

/** Complete dialog drawing routine 14003d480. Does not advance the VM fade counter. */
export function drawDialog(boxes: MessageBoxes, channel: number, fade: number): DialogDrawList {
  if (channel !== 0 && channel !== 1) throw new Error('Invalid dialog channel');
  fade >>>= 0;
  const s = boxes.state,
    b = 0x1de15a0 + channel * 0xb8,
    sprites: SpriteDraw[] = [],
    regions: HitRegion[] = [];
  for (let i = 0; i < strips.length; i++) {
    const [x, y, height, sy] = strips[i]!,
      delay = s.get(0x5a97e4 + i * 8) >>> 0;
    if (fade < 32 && fade <= delay) continue;
    const width =
      fade >= 32 || (fade - delay) >>> 0 >= 16 ? 960 : Math.imul((fade - delay) >>> 0, 960) >>> 4;
    const left = fade >= 32 || s.get(0x5a97e0 + i * 8) !== 0;
    sprites.push({
      ...nativeSampler(s),
      texture: 147,
      source: {x: left ? x : x + 960 - width, y, width, height},
      destination: {
        x: left ? 0 : 1920 - width * 2,
        y: sy * 2,
        width: width * 2,
        height: height * 2,
      },
      color: 0xffffff,
      alpha: 256,
    });
  }
  if (fade < 16) return {sprites, regions};
  const alpha = ((fade << 8) - 4096) >>> 4;
  const sprite = (sx: number, sy: number, w: number, h: number, x: number, y: number) =>
    sprites.push({
      ...nativeSampler(s),
      texture: 147,
      source: {x: sx, y: sy, width: w, height: h},
      destination: {x, y, width: w, height: h},
      color: 0xffffff,
      alpha,
    });
  sprite(0, 1260, 1342, 442, 289, 319);
  const count = s.get(b + 4),
    selected = s.get(b + 8),
    mode = s.get(b + 0xb0);
  const button = (index: number, x: number, sy: number, sx: number) => {
    sprite(sx, sy, 274, 64, x, 651);
    regions.push({group: channel + 1, index, x, y: 651, width: 274, height: 64});
  };
  if (count === 1) button(0, 797, selected === 0 ? 1324 : 1260, 1343);
  else if (count === 2) {
    const sx = mode !== 0 ? 1623 : 1343;
    button(0, 524, selected === 0 ? 1324 : 1260, sx);
    button(1, 1071, selected === 1 ? 1452 : 1388, sx);
  }
  let y = 283;
  for (let i = 0; i < s.get(b) >>> 0; i++) {
    const address = Number(s.view(b + 0x10 + i * 8, 8).getBigUint64(0, true)),
      width = s.get(b + 0xa4) >>> 0;
    for (const [dx, dy, color] of [
      [213, -1, 0],
      [215, 1, 0],
      [214, 0, 0xffffff],
    ] as const)
      sprites.push(
        ...drawDialogText(boxes, address, dx, y + dy, width, color, 24, alpha, {
          slot: fixedTextLocation(s, `dialog-${channel}`),
          line: i,
          index: i * 256,
          shadow: dx !== 214,
        }),
      );
    y += s.get(b) < 5 ? 32 : 28;
  }
  return {sprites, regions};
}
