import type {ArtemisShaderSample} from './raster-shader.js';
export interface ArtemisMosaicUniforms {
  readonly alpha: number;
  readonly size: number;
  readonly ratio: number;
}
const f = Math.fround;
export function artemisMosaicShade(
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisMosaicUniforms,
): readonly [number, number, number, number] {
  if (![u, v, p.alpha, p.size, p.ratio].every(Number.isFinite))
    throw Error('Invalid Artemis mosaic uniforms');
  const w = f(f(p.size) * f(p.ratio)),
    h = f(p.size),
    x = f(Math.floor(f(f(u) * w)) / w),
    y = f(Math.floor(f(f(v) * h)) / h),
    c = sample(x, y);
  return [c[0], c[1], c[2], f(f(c[3]) * f(p.alpha))];
}
export const ARTEMIS_MOSAIC_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uSize;
uniform float uRatio;
out vec4 outColor;
void main(){
 float w=uSize*uRatio,h=uSize;
 vec2 uv=vec2(floor(vUv.x*w)/w,floor(vUv.y*h)/h);
 vec4 c=texture(uFore,uv);c.a*=uAlpha;outColor=c;
}`;
