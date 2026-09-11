import type {Sc3Runtime} from './runtime.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {appendMenuMarker} from './game-menu-draw.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {drawDirectMovie} from './movie-draw.js';
/** 140010850: thirteen movie thumbnails and the direct channel-zero preview. */
export function drawMovieGallery(vm: Sc3Runtime): DialogDrawList {
  const s = vm.state,
    out: DialogDrawList = {sprites: [], commands: [], regions: []},
    alpha = s.variable(0x218c / 4) << 3;
  const emit = (
    sx: number,
    sy: number,
    width: number,
    height: number,
    x: number,
    y: number,
    a = alpha,
  ) => {
    const d: SpriteDraw = {
      texture: 161,
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
  emit(0, 0, 1920, 1080, 0, 0);
  for (let i = 0; i < 13; i++) {
    const x = 150 + (i % 5) * 333,
      y = 105 + Math.floor(i / 5) * 192,
      selected = s.get(0x5451d4) === i,
      unlocked = s.bytes(0x543838 + i, 1)[0] !== 0;
    emit(294, 1106, 316, 188, x - 1, y - 1);
    out.regions.push({group: 21, index: i, x: x - 1, y: y - 1, width: 292, height: 164});
    emit(
      unlocked ? 616 + (i % 4) * 294 : 0,
      unlocked ? 1086 + Math.floor(i / 4) * 168 : 1254,
      288,
      162,
      x,
      y,
      selected ? alpha : alpha >>> 1,
    );
    if (selected) emit(0, 1086, 288, 162, x, y);
  }
  if (s.variable(0x62e8 / 4) === 3000) {
    for (const [at, v] of [
      [0x1d8be68, 0x631c],
      [0x1d8be70, 0x6324],
    ] as const)
      s.setVariable(
        v / 4,
        Math.trunc(
          Math.fround(
            Math.fround(Math.fround(Number(s.view(at, 8).getBigInt64(0, true))) * 30) / 1000,
          ),
        ) | 0,
      );
    if (s.variable(0x6320 / 4) === 0) {
      const movie = drawDirectMovie(vm, 0, 256);
      if (movie) {
        out.sprites.push(movie);
        out.commands!.push(movie);
      }
    }
    appendMenuMarker(s, 255);
  } else appendMenuMarker(s, 11);
  return out;
}
