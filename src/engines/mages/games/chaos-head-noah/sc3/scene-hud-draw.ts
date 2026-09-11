import {nativeSampler, nativeBlend} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
/** Complete 14005e3f0: auto, skip and checkpoint indicators. Advances on drawing. */
export function drawSceneHud(s: NoahState): SpriteDraw[] {
  const out: SpriteDraw[] = [];
  if (s.flags[0x136]! & 128 || s.flags[0x9b]! & 16) return out;
  const g = (a: number) => s.get(a),
    p = (a: number, v: number) => s.put(a, v),
    sprite = (sx: number, sy: number, w: number, h: number, x: number, y: number, a: number) =>
      out.push({
        ...nativeSampler(s),
        texture: 80,
        source: {x: sx, y: sy, width: w, height: h},
        destination: {x, y, width: w, height: h},
        color: 0xffffff,
        alpha: Math.max(0, Math.min(255, a | 0)),
      });
  for (const [mask, fade, timer, frame, period, x, row] of [
    [4, 0x17abda0, 0x17abcc8, 0x17abdb0, 8, 1703, 3],
    [3, 0x17ac1b8, 0x17abd9c, 0x17abd98, 4, 1755, 5],
  ]) {
    if (g(0x17ac2ec) & mask!) {
      if (g(fade!) < 256) p(fade!, g(fade!) + 16);
    } else if (g(fade!) !== 0) p(fade!, g(fade!) - 16);
    if (g(fade!) !== 0) {
      p(timer!, g(timer!) + 1);
      if (g(timer!) >= period!) {
        p(frame!, g(frame!) + 1);
        p(timer!, 0);
        if (g(frame!) > 7) p(frame!, 0);
      }
      sprite(
        (g(frame!) & 3) * 42 + 200,
        ((g(frame!) >>> 2) + row!) * 42,
        42,
        42,
        x!,
        988,
        Math.imul(s.variable(0x20e4 / 4), g(fade!)) >> 8,
      );
    }
  }
  if (g(0x17ac1c4) === 0) {
    if (g(0x17ac31c) > 0) {
      p(0x17ac31c, g(0x17ac31c) - 16);
      if (g(0x17ac31c) < 1) {
        p(0x17abc98, 0);
        p(0x17abdb4, 0);
        p(0x17ac31c, 0);
        return out;
      }
    }
  } else {
    p(0x17ac1c4, g(0x17ac1c4) - 1);
    if (g(0x17ac31c) >>> 0 < 256) p(0x17ac31c, g(0x17ac31c) + 16);
  }
  if (g(0x17ac31c) === 0) {
    p(0x17ac31c, 0);
    p(0x17abdb4, 0);
    p(0x17abc98, 0);
    return out;
  }
  let tick = 0;
  if (g(0x17abc98) < 8) tick = g(0x17abc98) + 1;
  else {
    p(0x17abdb4, g(0x17abdb4) + 1);
    if (g(0x17abdb4) > 3) p(0x17abdb4, 0);
  }
  p(0x17abc98, tick);
  sprite(536, g(0x17abdb4) * 48, 180, 48, 1651, 812, g(0x17ac31c));
  return out;
}
