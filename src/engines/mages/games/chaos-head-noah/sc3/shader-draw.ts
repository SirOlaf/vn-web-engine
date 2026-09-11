import type {NoahState} from './noah-state.js';
import type {DrawCommand} from '../../../../../graphics/draw-list.js';
import type {TriangleDraw, AdditionalTexture} from '../../../../../graphics/triangle-draw.js';
import type {Rect} from '../../../../../graphics/surface.js';
import {submitNativeRectangle} from './rectangle-submit.js';
import {nativeBlend, nativeSampler} from './render-state.js';
import {nativePixelShaders} from './native-pixel-shaders.js';
import {f, div, mul} from './render-math.js';
const full = {x: 0, y: 0, width: 1920, height: 1080};
/** Native 1400253a0 threshold block, including signed bounds and default width. */
export function shaderThreshold(position: number, width: number): Float32Array {
  const span = width === 0 ? 16 : width,
    at = Math.min(Math.max(0, position), (span + 256) | 0),
    scale = div(256, f(span));
  return new Float32Array([scale, div(mul(f((255 - at) | 0), scale), 255), 1, 0]);
}
/** Explicit 140069890 multi-texture rectangle submission. */
export function drawShaderRectangle(
  s: NoahState,
  shader: number,
  textures: readonly number[],
  sources: readonly Rect[],
  destination: Rect = full,
  alpha = 1,
  parameters?: Float32Array,
): TriangleDraw {
  const fragment = nativePixelShaders[shader];
  if (fragment === undefined) throw new Error(`Native pixel shader index out of range: ${shader}`);
  const flags = s.get(0x586a54),
    filter = (flags & 0xf0000) === 0x10000 ? 'nearest' : 'linear',
    wrapS = (flags & 0x300) === 0x100 ? 'repeat' : (flags & 0x300) === 0x200 ? 'mirror' : 'clamp',
    wrapT = (flags & 0xc00) === 0x400 ? 'repeat' : (flags & 0xc00) === 0x800 ? 'mirror' : 'clamp';
  const rectangle = (texture: number, source: Rect) =>
    submitNativeRectangle(s, {
      texture,
      source,
      destination,
      color: 0xffffff,
      alpha: 255,
      filter,
      wrapS,
      wrapT,
    });
  const draw = rectangle(textures[0]!, sources[0]!);
  for (let i = 6; i < draw.vertices.length; i += 9) draw.vertices[i] = alpha;
  const additionalTextures: AdditionalTexture[] = textures.slice(1).map((texture, i) => {
    const v = rectangle(texture, sources[i + 1]!).vertices,
      uv = new Float32Array((v.length / 9) * 2);
    for (let i = 0; i < v.length / 9; i++) {
      uv[i * 2] = v[i * 9 + 7]!;
      uv[i * 2 + 1] = v[i * 9 + 8]!;
    }
    return {texture, uv, filter, wrapS, wrapT};
  });
  return {
    ...draw,
    additionalTextures,
    fragment,
    parameters,
    discardTransparent: false,
    ...nativeSampler(s),
    blendState: nativeBlend(s.get(0x587344) & 65535),
  };
}
/** 140024f00 / 1400250c0. Captured scene, effect color source and optional mask. */
export function drawSceneShader(
  s: NoahState,
  shader: number,
  texture: number,
  opacity: number,
  mask?: {texture: number; position: number; width: number},
): DrawCommand[] {
  return [
    {kind: 'capture', texture: 205, width: 1920, height: 1080},
    drawShaderRectangle(
      s,
      shader,
      mask ? [205, texture, mask.texture] : [205, texture],
      mask ? [full, full, {x: 0, y: 0, width: 0, height: 0}] : [full, full],
      full,
      mask ? div(Math.max(0, Math.min(255, opacity)), 255) : div(f(opacity >>> 0), 255),
      mask ? shaderThreshold(mask.position, mask.width) : undefined,
    ),
  ];
}
/** 14002c0f0: all three independent scene filter banks, shader IDs 11 onward. */
export function sceneShadersAtPriority(s: NoahState, priority: number): DrawCommand[] {
  const out: DrawCommand[] = [];
  for (let bank = 0; bank < 3; bank++) {
    const b = (0x5fa0 + bank * 40) / 4,
      v = (i: number) => s.variable(b + i),
      mode = v(1) >>> 0;
    if (v(0) !== priority || v(2) === 0 || mode === 65535) continue;
    const bits = v(3) >>> 0,
      slot = bits !== 0 && (bits & (bits - 1)) === 0 ? 32 - Math.clz32(bits) : 0,
      texture = s.variable(0xd47 + slot),
      mask =
        mode < 19 && ((0x49249 >>> mode) & 1) !== 0
          ? undefined
          : {texture: (v(4) + 100) | 0, position: v(6), width: v(5)};
    out.push(...drawSceneShader(s, (mode + 11) | 0, texture, v(2), mask));
  }
  return out;
}
