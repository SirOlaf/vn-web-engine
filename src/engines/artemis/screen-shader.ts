import type {ArtemisShaderSample} from './raster-shader.js';
const f = Math.fround;
export interface ArtemisScreenUniforms {
  readonly alpha: number;
}

/** Recognized screen program: foreground screened by user.rgb*user.a; only
 * foreground alpha is scaled. Back, mask, colorMultiply and param are unused.
 */
export function artemisScreenShade(
  fore: ArtemisShaderSample,
  user: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisScreenUniforms,
): readonly [number, number, number, number] {
  if (![u, v, p.alpha].every(Number.isFinite))
    throw Error('Unsupported nonfinite Artemis screen uniform');
  const a = fore(f(u), f(v)),
    b = user(f(u), f(v));
  const channel = (index: 0 | 1 | 2) =>
    f(1 - f(f(1 - f(a[index])) * f(1 - f(f(b[index]) * f(b[3])))));
  return [channel(0), channel(1), channel(2), f(f(a[3]) * f(p.alpha))];
}
export const ARTEMIS_SCREEN_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform sampler2D uUser;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec4 fore = texture(uFore, vUv);
  vec4 user = texture(uUser, vUv);
  fore.rgb = 1.0 - ((1.0 - fore.rgb) * (1.0 - user.rgb * user.a));
  fore.a *= uAlpha;
  outColor = fore;
}`;
