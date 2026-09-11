import type {NoahState} from './noah-state.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {DrawCommand, SpriteDraw} from '../../../../../graphics/draw-list.js';
import {galleryTiles} from './gallery-render-data.js';
import {nativeSine, f, add, sub, mul, div} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {appendMenuMarker} from './game-menu-draw.js';
/** 14000d1e0: native five-column grid, cosine page motion and per-image unlock dots. */
export function drawGalleryGrid(
  s: NoahState,
  page: number,
  opacity: number,
  progress: number,
): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []},
    product = Math.imul(opacity, progress) >>> 0,
    alpha = product >>> 4,
    offset = Math.trunc(
      Math.imul(nativeSine((((progress & 0x3ffff) << 10) + 0x4000) | 0), 50) / 65536,
    );
  const emit = (
    texture: number,
    sx: number,
    sy: number,
    width: number,
    height: number,
    x: number,
    y: number,
    a = alpha,
  ) => {
    const d: SpriteDraw = {
      texture,
      source: {x: sx, y: sy, width, height},
      destination: {x, y, width, height},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, a | 0)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    };
    out.sprites.push(d);
    out.commands!.push(d);
  };
  for (let i = 0; i < 20; i++) {
    const tile = galleryTiles[(Math.imul(page, 20) >>> 0) + i];
    if (!tile) throw new Error('Native gallery page outside mapped table');
    if (!tile[0]) break;
    const x = 150 + (i % 5) * 333 + offset,
      y = 105 + Math.floor(i / 5) * 192,
      index = (Math.imul(page, 20) + i) >>> 0,
      unlocked = s.get(0x543570 + index * 4) >>> 0,
      locked = s.get(0x5432e0 + index * 4) >>> 0,
      selected = s.get(0x543568) === i,
      a = selected ? alpha : product >>> 5;
    emit(150, 294, 1106, 316, 188, x - 1, y - 1);
    out.regions.push({group: 21, index: i, x: x - 1, y: y - 1, width: 292, height: 164});
    if (!unlocked) emit(150, 0, 1254, 288, 162, x, y, a);
    else {
      const thumb = tile[1]! >>> 0;
      emit(151, (thumb % 10) * 290, Math.floor(thumb / 10) * 164, 288, 162, x, y, a);
      let dot = 267;
      for (let j = 0; j < unlocked; j++, dot -= 20) emit(150, 294, 1086, 20, 20, dot + x, y + 142);
      for (let j = 0; j < locked; j++, dot -= 20) emit(150, 320, 1086, 20, 20, dot + x, y + 142);
    }
    if (selected && progress === 16) emit(150, 0, 1086, 288, 162, x, y);
  }
  emit(150, 616, f((Math.imul(page, 35) + 1086) | 0), 245, 35, offset + 1527, 924);
  return out;
}
/** 14000d710: crop around the retained center, write viewport bounds and letterbox. */
export function drawGalleryImage(s: NoahState, index: number): DrawCommand[] {
  const r = (a: number) => s.view(a + index * 4, 4).getFloat32(0, true),
    w = (a: number, v: number) => s.view(a + index * 4, 4).setFloat32(0, v, true),
    scale = r(0x543018);
  const fit = (screen: number, extent: number, center: number) => {
    const span = div(screen, scale);
    let start = 0,
      size = extent,
      left: number,
      right: number;
    if (span < extent) {
      const half = mul(span, 0.5);
      start = sub(center, half);
      let end = add(center, half);
      if (start < 0) {
        end = sub(end, start);
        start = 0;
      }
      if (extent < end) {
        start = sub(start, sub(end, extent));
        end = extent;
      }
      size = sub(end, start);
      left = 0;
      right = screen;
    } else {
      left = mul(sub(screen, mul(extent, scale)), 0.5);
      right = sub(screen, left);
    }
    return {start, size, left, right};
  };
  const x = fit(1920, r(0x5451b0), r(0x5432d8)),
    y = fit(1080, r(0x5451e0), r(0x543010));
  for (const [a, v] of [
    [0x5451a8, x.start],
    [0x543020, y.start],
    [0x5451d8, x.size],
    [0x543048, y.size],
    [0x543848, x.left],
    [0x5437f8, y.left],
    [0x5425a8, x.right],
    [0x543898, y.right],
  ])
    w(a!, v!);
  const texture = s.variable((s.get(0x5451c8 + index * 4) + 0xd48) >>> 0),
    alpha = Math.max(0, Math.min(255, s.get(0x543880 + index * 4) << 4)),
    out: DrawCommand[] = [
      {
        texture,
        source: {x: x.start, y: y.start, width: x.size, height: y.size},
        destination: {
          x: x.left,
          y: y.left,
          width: sub(x.right, x.left),
          height: sub(y.right, y.left),
        },
        color: 0xffffff,
        alpha,
        ...nativeSampler(s),
        blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
      },
    ];
  const solid = (left: number, top: number, width: number, height: number) => {
    if (width !== 0 && height !== 0)
      out.push({
        kind: 'solid',
        destination: {x: left, y: top, width, height},
        color: 0,
        alpha,
        blendState: nativeBlend(0),
      });
  };
  if (x.left > 0) solid(0, 0, x.left, 1080);
  if (x.right < 1920) solid(x.right, 0, sub(1920, x.right), 1080);
  if (y.left > 0) solid(0, 0, 1920, y.left);
  if (y.right > 0) solid(0, y.right, 1920, sub(1080, y.right));
  return out;
}
export function drawGallery(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: [], regions: []};
  if (s.get(0x5451b8) !== 16) {
    const d = {
      texture: 150,
      source: {x: 0, y: 0, width: 1920, height: 1080},
      destination: {x: 0, y: 0, width: 1920, height: 1080},
      color: 0xffffff,
      alpha: s.variable(0x218c / 4) << 3,
    };
    out.sprites.push(d);
    out.commands!.push(d);
    for (const [page, progress] of [
      [s.get(0x543888), 16 - s.get(0x543890)],
      ...(s.get(0x543890) ? [[s.get(0x543004), s.get(0x543890)]] : []),
    ]) {
      const layer = drawGalleryGrid(s, page!, s.variable(0x218c / 4) << 3, progress!);
      out.sprites.push(...layer.sprites);
      out.commands!.push(...layer.commands!);
      out.regions.push(...layer.regions);
    }
    appendMenuMarker(s, 8);
  }
  if (s.get(0x5451b8) !== 0) {
    for (let i = 0; i < 2; i++)
      if (s.get(0x543880 + i * 4)) out.commands!.push(...drawGalleryImage(s, i));
    appendMenuMarker(s, s.get(0x543038) ? 9 : 255);
  }
  return out;
}
