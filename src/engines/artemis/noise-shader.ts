import type {ArtemisShaderSample} from './raster-shader.js';
export interface ArtemisNoiseUniforms {
  readonly alpha: number;
  readonly size: number;
}
const f = Math.fround;
/** Exact source uses background UV2, a fixed zero time, and the same noise offset on both axes. */
export function artemisNoiseShade(
  back: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisNoiseUniforms,
): readonly [number, number, number, number] {
  if (![u, v, p.alpha, p.size].every(Number.isFinite))
    throw Error('Invalid Artemis noise uniforms');
  const seed = f(f(f(u) * f(12.9898)) + f(f(v) * f(78.233)));
  const wave = f(f(Math.sin(seed)) * f(43758.5453));
  const noise = f(wave - Math.floor(wave));
  const offset = f(f(p.size) * noise);
  const color = back(f(f(u) + offset), f(f(v) + offset));
  return [color[0], color[1], color[2], f(f(color[3]) * f(p.alpha))];
}
export const ARTEMIS_NOISE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vBackUv;
uniform sampler2D uBack;
uniform float uAlpha;
uniform float uSize;
out vec4 outColor;
void main(){
 float noise=fract(sin(dot(vBackUv,vec2(12.9898,78.233)))*43758.5453);
 vec2 uv=vBackUv+uSize*noise;
 vec4 c=texture(uBack,uv);c.a*=uAlpha;outColor=c;
}`;
