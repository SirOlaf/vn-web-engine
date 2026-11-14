import type {ArtemisShaderSample} from './raster-shader.js';
export type ArtemisCompositeKind =
  'add' | 'mul' | 'mul_lerp' | 'compbr' | 'compbrc' | 'compdk' | 'compdkc';
export interface ArtemisCompositeUniforms {
  readonly alpha: number;
  readonly param: number;
}
const f = Math.fround;
/** Direct source arithmetic: zero combined alpha is not regularized. */
export function artemisCompositeShade(
  kind: ArtemisCompositeKind,
  fore: ArtemisShaderSample,
  user: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisCompositeUniforms,
): readonly [number, number, number, number] {
  if (![u, v, p.alpha, p.param].every(Number.isFinite))
    throw Error('Invalid Artemis composite uniforms');
  const a = fore(f(u), f(v)),
    b = user(f(u), f(v)),
    inverse = f(1 - f(b[3])),
    combined = f(f(f(a[3]) * inverse) + f(b[3]));
  const channel = (i: 0 | 1 | 2) => {
    if (kind === 'mul_lerp') {
      const strength = f(f(b[3]) * f(p.param));
      return f(f(a[i]) * f(f(1 - strength) + f(f(f(b[i]) * f(b[3])) * f(p.param))));
    }
    if (kind === 'add') return f(f(a[i]) + f(f(f(b[3]) * f(b[i])) * f(p.param)));
    const selected =
      kind === 'mul'
        ? f(b[i])
        : kind === 'compbr' || kind === 'compbrc'
          ? Math.max(f(a[i]), f(b[i]))
          : Math.min(f(a[i]), f(b[i]));
    const blend = f(f(f(f(f(a[i]) * f(a[3])) * inverse) + f(selected * f(b[3]))) / combined);
    return kind === 'mul' ? f(f(a[i]) * f(blend + f(1 - f(p.param)))) : f(blend * f(p.param));
  };
  return [channel(0), channel(1), channel(2), f(f(a[3]) * f(p.alpha))];
}
export function artemisCompositeFragmentSource(kind: ArtemisCompositeKind): string {
  const calculation =
    kind === 'add'
      ? 'fore.rgb += user.a * user.rgb * uParam;'
      : kind === 'mul_lerp'
        ? 'fore.rgb *= (1.0-user.a*uParam) + user.rgb*user.a*uParam;'
        : kind === 'mul'
          ? 'fore.rgb *= (fore.rgb * fore.a * (1.0-user.a) + user.rgb * user.a) / combined + (1.0-uParam);'
          : `user.rgb = ${kind === 'compbr' || kind === 'compbrc' ? 'max' : 'min'}(fore.rgb,user.rgb); fore.rgb = (fore.rgb * fore.a * (1.0-user.a) + user.rgb * user.a) / combined * uParam;`;
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform sampler2D uUser;
uniform float uAlpha;
uniform float uParam;
out vec4 outColor;
void main(){
 vec4 fore=texture(uFore,vUv),user=texture(uUser,vUv);
 float combined=fore.a*(1.0-user.a)+user.a;
 ${calculation}
 fore.a*=uAlpha;outColor=fore;
}`;
}
