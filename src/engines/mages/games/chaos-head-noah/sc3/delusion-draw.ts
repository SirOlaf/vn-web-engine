import type {NoahState} from './noah-state.js';
import type {DrawCommand, SpriteDraw} from '../../../../../graphics/draw-list.js';
import type {DialogDrawList} from './dialog-draw.js';
import {f, add, sub, mul, div} from './render-math.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {shaderThreshold} from './shader-draw.js';
import {submitNativeRectangle} from './rectangle-submit.js';
/** 140008480: looping static, the two independently clocked overlays and their masks. */
export function drawDelusionBackground(s: NoahState): DrawCommand[] {
  const out: DrawCommand[] = [],
    alpha = s.get(0x535854) >>> 0;
  if (alpha === 0) return out;
  let frame = (s.get(0x5358b8) + 1) >>> 0;
  if (frame >= 9) frame = 0;
  s.put(0x5358b8, frame);
  const cell = Math.trunc(frame / 3);
  const rect = (
    texture: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): SpriteDraw => ({
    texture,
    source: {x, y, width, height},
    destination: {x: 0, y: 0, width: 1920, height: 1080},
    color: 0xffffff,
    alpha: Math.min(255, alpha >>> 1),
    ...nativeSampler(s),
    blendState: nativeBlend(s.get(0x587344) & 65535),
  });
  out.push(rect(178, (cell & 1) * 640, (cell >>> 1) * 360, 640, 360));
  const progress = s.get(0x531fb4) >>> 0,
    type = s.get(0x5358d0);
  if (progress === 0 || (type !== 1 && type !== 2)) return out;
  const clock = type === 1 ? 0x5358bc : 0x5358c0;
  frame = (s.get(clock) + 1) >>> 0;
  if (frame >= 160) frame = 0;
  s.put(clock, frame);
  s.put(0x587344, 2);
  if (type === 2)
    out.push({
      kind: 'solid',
      destination: {x: 0, y: 0, width: 1920, height: 1080},
      color: 0xff0000,
      alpha: Math.min(255, progress >>> 2),
      blendState: nativeBlend(0),
    });
  const d = rect(type === 1 ? 177 : 176, ((frame >>> 1) & 7) * 256, (frame >>> 4) * 256, 256, 256);
  if (progress !== 272) {
    const p = shaderThreshold(progress | 0, 16);
    d.mask = {
      texture: 178,
      source: {x: 640, y: 360, width: 640, height: 360},
      scale: p[0]!,
      bias: p[1]!,
    };
  }
  out.push(d);
  s.put(0x587344, 0);
  return out;
}
/** 140008860: the native unsigned scale and ordered float operations matter at large scales. */
export function delusionQuadPoints(s: NoahState, center: number): Float32Array {
  const angle = mul(mul(f(s.get(0x53589c)), f(Math.PI)), 1 / 32768),
    c = f(Math.cos(angle)),
    sn = f(Math.sin(angle)),
    m = new Float32Array([c, -sn, 0, 0, sn, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  s.bytes(0x1d7d190, 64).set(new Uint8Array(m.buffer));
  const cn = mul(c, -4000),
    cp = mul(c, 4000),
    sn0 = mul(sn, -4000),
    sp = mul(sn, 4000),
    nn = mul(-sn, -4000),
    np = mul(-sn, 4000),
    scale = f(s.get(0x20a690) >>> 0),
    project = (a: number, b: number, offset: number) =>
      add(mul(mul(mul(mul(add(add(add(a, b), 0), 0), scale), 3), 1 / 65536), 0.5), f(offset));
  return new Float32Array([
    project(nn, cn, center),
    project(cn, sn0, 540),
    project(nn, cp, center),
    project(cn, sp, 540),
    project(cn, np, center),
    project(cp, sn0, 540),
    project(cp, np, center),
    project(cp, sp, 540),
  ]);
}
export function drawDelusion(s: NoahState): DialogDrawList {
  const out: DialogDrawList = {sprites: [], commands: drawDelusionBackground(s), regions: []};
  s.put(0x586a54, 0);
  const points = delusionQuadPoints(s, (s.get(0x53587c) + 960) | 0),
    quad = submitNativeRectangle(s, {
      texture: 175,
      source: {x: -4000, y: -4000, width: 9024, height: 9024},
      destination: {x: 0, y: 0, width: 1920, height: 1080},
      color: 0xffffff,
      alpha: 255,
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    });
  for (const [i, corner] of [0, 2, 1, 1, 2, 3].entries()) {
    const x = div(add(0, points[corner * 2]!), 1920),
      y = div(add(0, points[corner * 2 + 1]!), 1080);
    quad.vertices[i * 9] = sub(add(x, x), 1);
    quad.vertices[i * 9 + 1] = -sub(add(y, y), 1);
  }
  out.commands!.push(quad);
  for (let i = 0; i < 2; i++) {
    const d: SpriteDraw = {
      texture: 80,
      source: {
        x: add(f(Math.imul(s.get(0x5358c8 + i * 4), 56) >>> 0), i ? 1048 : 880),
        y: 1272,
        width: 40,
        height: 224,
      },
      destination: {x: i ? 1882 : 0, y: 431, width: 40, height: 224},
      color: 0xffffff,
      alpha: 255,
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    };
    out.sprites.push(d);
    out.commands!.push(d);
    out.regions.push({group: 30, index: i, x: i ? 1882 : 0, y: 431, width: 40, height: 218});
  }
  s.put(0x586a54, 0);
  return out;
}
