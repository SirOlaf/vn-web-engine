import type {NoahState} from './noah-state.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import type {DialogDrawList} from './dialog-draw.js';
import {f, add, sub, mul, trunc} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {drawSceneGlyphs} from './scene-text-draw.js';

/** Shared native nine-piece atlas layout used by 140042a70 and 140043410. */
function windowPieces(
  s: NoahState,
  x: number,
  y: number,
  width: number,
  height: number,
  sy: number,
  alpha: number,
): SpriteDraw[] {
  const xs = [
    mul(f((x - 16) | 0), 1.5),
    0,
    sub(mul(f((x + width + 16) | 0), 1.5), 16),
    mul(f((x + width + 16) | 0), 1.5),
  ];
  xs[1] = add(xs[0]!, 16);
  const ys = [
    mul(f((y - 16) | 0), 1.5),
    0,
    sub(mul(f((y + height + 16) | 0), 1.5), 16),
    mul(f((y + height + 16) | 0), 1.5),
  ];
  ys[1] = add(ys[0]!, 16);
  const out: SpriteDraw[] = [];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++)
      out.push({
        texture: 80,
        source: {x: col * 16, y: sy + row * 16, width: 16, height: 16},
        destination: {
          x: xs[col]!,
          y: ys[row]!,
          width: col !== 1 && row !== 1 ? 16 : sub(xs[col + 1]!, xs[col]!),
          height: col !== 1 && row !== 1 ? 16 : sub(ys[row + 1]!, ys[row]!),
        },
        color: 0xffffff,
        alpha: Math.max(0, Math.min(255, alpha | 0)),
        ...nativeSampler(s),
        blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
      });
  return out;
}
function highlight(
  s: NoahState,
  position: number,
  size: number,
  sy: number,
  alpha: number,
): SpriteDraw {
  const x = s.get(position),
    y = (s.get(position + 4) + 2) | 0,
    dx = mul(f(x), 1.5),
    dy = mul(f(y), 1.5);
  return {
    texture: 80,
    source: {x: 65, y: sy, width: 94, height: 30},
    destination: {
      x: dx,
      y: dy,
      width: sub(mul(f((x + s.get(size)) | 0), 1.5), dx),
      height: sub(mul(f((y + s.get(size + 4)) | 0), 1.5), dy),
    },
    color: 0xffffff,
    alpha: Math.max(0, Math.min(255, alpha | 0)),
    ...nativeSampler(s),
    blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
  };
}
/** 140043410: the two auxiliary text windows have separate geometry and selection arrays. */
export function drawAuxiliaryWindow(s: NoahState, index: number, alpha: number): SpriteDraw[] {
  if (!alpha) return [];
  const out = windowPieces(
      s,
      s.get(0x80c4c8 + index * 4),
      s.get(0x80c3f8 + index * 4),
      s.get(0x66d8d0 + index * 4),
      s.get(0x7fc908 + index * 4),
      48,
      alpha,
    ),
    selected = s.get(0x7fbf98 + index * 4);
  if (selected !== -1) {
    const item = index * 30 + selected;
    out.push(highlight(s, 0x80d680 + item * 8, 0x799bc0 + item * 8, 65, alpha));
  }
  return out;
}
/** 140042a70: style zero contributes hit rectangles only. */
export function drawSelectionWindow(s: NoahState, opacity: number): DialogDrawList {
  const sprites: SpriteDraw[] = [],
    out: DialogDrawList = {sprites, commands: sprites, regions: []},
    alpha = Math.imul(opacity, s.get(0x17adc88)) >>> 8;
  if (!opacity || !alpha) return out;
  const count = s.get(0x660ff0),
    selected = s.get(0x768710),
    style = s.variable(0x2150 / 4);
  if (style === 0) {
    let y = (348 - Math.trunc(Math.imul(count, 90) / 2)) | 0;
    for (let i = 0; i < count; i++) {
      out.regions.push({group: 3, index: i, x: 470, y: f(y), width: 980, height: 84});
      y = (y + 90) | 0;
    }
  } else if (style === 1) {
    const x = s.get(0x7fc938),
      y = s.get(0x7fc904),
      width = s.get(0x7686e0),
      height = s.get(0x660ff4);
    for (let i = 0; i < count; i++)
      out.regions.push({
        group: 3,
        index: i,
        x: f(trunc(mul(f(x), 1.5))),
        y: f(trunc(mul(f(s.get(0x80f254 + i * 8)), 1.5))),
        width: f(trunc(mul(f(width), 1.5))),
        height: 48,
      });
    sprites.push(...windowPieces(s, x, y, width, height, 0, alpha));
    if (selected !== -1)
      sprites.push(highlight(s, 0x80f250 + selected * 8, 0x80eb20 + selected * 8, 33, alpha));
  }
  return out;
}
/** 14003ef60 differs from 14003f2a0 only in the shadow's 1-pixel atlas inset. */
export function drawAuxiliaryGlyphs(
  s: NoahState,
  font: number,
  slot: number,
  alpha: number,
): SpriteDraw[] {
  return drawSceneGlyphs(s, font, slot, alpha, 0, 0, true);
}
