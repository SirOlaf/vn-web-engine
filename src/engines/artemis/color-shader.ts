import type {ArtemisShaderSample} from './raster-shader.js';
export type ArtemisColorKind =
  'sepia' | 'sepia2' | 'gray' | 'nega' | 'rgb' | 'cadd' | 'cmul' | 'reset';
export interface ArtemisColorUniforms {
  readonly alpha: number;
  readonly red?: number;
  readonly green?: number;
  readonly blue?: number;
}
const f = Math.fround;
/** Reconstructed source semantics; GPU dot/FMA rounding may differ. */
export function artemisColorShade(
  kind: ArtemisColorKind,
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisColorUniforms,
): readonly [number, number, number, number] {
  if (
    ![
      u,
      v,
      p.alpha,
      ...(kind === 'gray' || kind === 'nega' || kind === 'reset' ? [] : [p.red, p.green, p.blue]),
    ].every((x) => typeof x === 'number' && Number.isFinite(x))
  )
    throw Error('Invalid Artemis color uniforms');
  const c = sample(u, v),
    g = f(f(f(f(c[0]) * f(0.298912)) + f(f(c[1]) * f(0.586611))) + f(f(c[2]) * f(0.114478)));
  if (kind === 'reset') return [c[0], c[1], c[2], f(f(c[3]) * f(p.alpha))];
  if (kind === 'cadd' || kind === 'cmul') {
    const apply = (x: number, k: number) => (kind === 'cadd' ? f(f(x) + f(k)) : f(f(x) * f(k)));
    return [
      apply(c[0], p.red!),
      apply(c[1], p.green!),
      apply(c[2], p.blue!),
      f(f(c[3]) * f(p.alpha)),
    ];
  }
  if (kind === 'nega')
    return [f(1 - f(c[0])), f(1 - f(c[1])), f(1 - f(c[2])), f(f(c[3]) * f(p.alpha))];
  if (kind === 'rgb')
    return [
      p.red! < 0 ? 0 : f(f(c[0]) + f(p.red!)),
      p.green! < 0 ? 0 : f(f(c[1]) + f(p.green!)),
      p.blue! < 0 ? 0 : f(f(c[2]) + f(p.blue!)),
      f(f(c[3]) * f(p.alpha)),
    ];
  return kind === 'gray'
    ? [g, g, g, f(f(c[3]) * f(p.alpha))]
    : [
        kind === 'sepia2' ? f(g + f(p.red!)) : f(g * f(p.red!)),
        f(g * f(p.green!)),
        f(g * f(p.blue!)),
        f(f(c[3]) * f(p.alpha)),
      ];
}
export function artemisColorFragmentSource(kind: ArtemisColorKind): string {
  const rgb =
    kind === 'reset'
      ? 'c.rgb'
      : kind === 'cadd'
        ? 'c.rgb+vec3(uRed,uGreen,uBlue)'
        : kind === 'cmul'
          ? 'c.rgb*vec3(uRed,uGreen,uBlue)'
          : kind === 'nega'
            ? 'vec3(1.0)-c.rgb'
            : kind === 'rgb'
              ? 'uRed < 0.0 ? 0.0 : c.r+uRed, uGreen < 0.0 ? 0.0 : c.g+uGreen, uBlue < 0.0 ? 0.0 : c.b+uBlue'
              : kind === 'gray'
                ? 'vec3(g)'
                : `g ${kind === 'sepia2' ? '+' : '*'} uRed, g * uGreen, g * uBlue`;
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uRed;
uniform float uGreen;
uniform float uBlue;
out vec4 outColor;
void main() {
  vec4 c = texture(uFore, vUv);
  float g = dot(c.rgb, vec3(.298912, .586611, .114478));
  outColor = vec4(${rgb}, c.a * uAlpha);
}`;
}
