import type {ArtemisShaderSample} from './raster-shader.js';
export interface ArtemisDiagonalBlurUniforms {
  readonly alpha: number;
  readonly offset: number;
  readonly size: number;
}

/**
 * Offset-sample blurs. `blur_diag`, `blur_pair_h` and `blur_pair_v` keep the center sample's
 * alpha; the dx11 kawase passes `blur_k`, `blur_kx` and `blur_ky` clear `fore` first and so
 * average alpha too. The `_premultiplied` kawase sources scale every sample, colour included,
 * by `alpha` as it is accumulated instead of scaling only the summed alpha.
 */
export const ARTEMIS_OFFSET_BLUR_KINDS = [
  'blur_diag',
  'blur_pair_h',
  'blur_pair_v',
  'blur_k',
  'blur_kx',
  'blur_ky',
  'blur_k_premultiplied',
  'blur_kx_premultiplied',
  'blur_ky_premultiplied',
] as const;
export type ArtemisOffsetBlurKind = (typeof ARTEMIS_OFFSET_BLUR_KINDS)[number];
export function isArtemisOffsetBlurKind(kind: string): kind is ArtemisOffsetBlurKind {
  return (ARTEMIS_OFFSET_BLUR_KINDS as readonly string[]).includes(kind);
}
const premultiplied = (kind: ArtemisOffsetBlurKind): boolean => kind.endsWith('_premultiplied');
const offsetBlurAxis = (kind: ArtemisOffsetBlurKind): 'diag' | 'h' | 'v' => {
  const base = kind.replace('_premultiplied', '');
  return base === 'blur_diag' || base === 'blur_k'
    ? 'diag'
    : base === 'blur_pair_h' || base === 'blur_kx'
      ? 'h'
      : 'v';
};
const kawase = (kind: ArtemisOffsetBlurKind): boolean => kind.startsWith('blur_k');
export function artemisDiagonalBlurShade(
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisDiagonalBlurUniforms,
  kind: ArtemisOffsetBlurKind = 'blur_diag',
): readonly [number, number, number, number] {
  if (![u, v, p.alpha, p.offset, p.size].every(Number.isFinite))
    throw Error('Invalid Artemis diagonal blur uniforms');
  const distance = Math.fround(Math.fround(p.offset) * Math.fround(p.size));
  const center = sample(Math.fround(u), Math.fround(v));
  const color = [0, 0, 0, kawase(kind) ? 0 : Math.fround(center[3])];
  const axis = offsetBlurAxis(kind);
  const offsets: readonly (readonly [number, number])[] =
    axis === 'diag'
      ? [
          [1, 1],
          [-1, 1],
          [-1, -1],
          [1, -1],
        ]
      : axis === 'h'
        ? [
            [1, 0],
            [-1, 0],
          ]
        : [
            [0, 1],
            [0, -1],
          ];
  const weight = axis === 'diag' ? 0.25 : 0.5;
  const scaled = premultiplied(kind);
  for (const [sx, sy] of offsets) {
    const pixel = sample(
      Math.fround(Math.fround(u) + Math.fround(sx * distance)),
      Math.fround(Math.fround(v) + Math.fround(sy * distance)),
    );
    for (let i = 0; i < 4; i++) {
      // sample * weight * mask_a * alpha with mask_a = 1.0.
      const term = Math.fround(Math.fround(pixel[i]!) * weight);
      color[i] = Math.fround(
        color[i]! + (scaled ? Math.fround(term * Math.fround(p.alpha)) : term),
      );
    }
  }
  if (!scaled) color[3] = Math.fround(color[3]! * Math.fround(p.alpha));
  return color as [number, number, number, number];
}
export function artemisOffsetBlurFragmentSource(kind: ArtemisOffsetBlurKind): string {
  const axis = offsetBlurAxis(kind);
  const samples =
    axis === 'diag'
      ? ['d,d', '-d,d', '-d,-d', 'd,-d']
      : axis === 'h'
        ? ['d,0.0', '-d,0.0']
        : ['0.0,d', '0.0,-d'];
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uOffset;
uniform float uSize;
out vec4 outColor;
void main(){
 vec4 c=${kawase(kind) ? 'vec4(0.0)' : 'texture(uFore,vUv);c.rgb=vec3(0.0)'};
 float d=uOffset*uSize;
 ${samples.map((uv) => `c+=texture(uFore,vUv+vec2(${uv}))*${axis === 'diag' ? '0.25' : '0.5'}${premultiplied(kind) ? '*uAlpha' : ''};`).join('\n ')}
 ${premultiplied(kind) ? '' : 'c.a*=uAlpha;'}outColor=c;
}`;
}
export const ARTEMIS_DIAGONAL_BLUR_FRAGMENT_SOURCE = artemisOffsetBlurFragmentSource('blur_diag');
export type ArtemisBlurKind = 'blur_h' | 'blur_v';
export interface ArtemisBlurUniforms {
  readonly alpha: number;
  readonly weights: readonly number[];
  readonly step: number;
}
const f = Math.fround;
/** Fifteen taps in native accumulation order; step is a UV offset, not pixel size. */
export function artemisBlurShade(
  kind: ArtemisBlurKind,
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisBlurUniforms,
): readonly [number, number, number, number] {
  if (p.weights.length !== 8 || ![u, v, p.alpha, p.step, ...p.weights].every(Number.isFinite))
    throw Error('Invalid Artemis blur uniforms');
  const c = sample(u, v).map((x) => f(f(x) * f(p.weights[0]!))) as [number, number, number, number];
  for (let i = 1; i < 8; i++)
    for (const sign of [1, -1]) {
      const d = f(f(p.step) * f(i * sign)),
        pixel = sample(kind === 'blur_h' ? f(f(u) + d) : u, kind === 'blur_v' ? f(f(v) + d) : v);
      for (let ch = 0; ch < 4; ch++) c[ch] = f(c[ch]! + f(f(pixel[ch]!) * f(p.weights[i]!)));
    }
  c[3] = f(c[3] * f(p.alpha));
  return c;
}
export function artemisBlurFragmentSource(kind: ArtemisBlurKind): string {
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uWeights[8];
uniform float uStep;
out vec4 outColor;
void main() {
 vec4 c = texture(uFore,vUv)*uWeights[0];
 for(int i=1;i<8;i++) {
   vec2 d = ${kind === 'blur_h' ? 'vec2(uStep * float(i),0.0)' : 'vec2(0.0,uStep * float(i))'};
   c += texture(uFore,vUv+d)*uWeights[i];
   c += texture(uFore,vUv-d)*uWeights[i];
 }
 c.a *= uAlpha; outColor=c;
}`;
}
