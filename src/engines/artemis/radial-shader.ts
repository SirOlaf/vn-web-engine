import type {ArtemisShaderSample} from './raster-shader.js';
export interface ArtemisRadialUniforms {
  readonly alpha: number;
  readonly ax: number;
  readonly ay: number;
  readonly size: number;
  readonly fade: number;
}
const f = Math.fround;
export function artemisRadialShade(
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisRadialUniforms,
): readonly [number, number, number, number] {
  if (![u, v, p.alpha, p.ax, p.ay, p.size, p.fade].every(Number.isFinite))
    throw Error('Invalid Artemis radial uniforms');
  const x = f(f(u) - f(p.ax)),
    y = f(f(v) - f(p.ay)),
    dist = f(Math.sqrt(f(f(x * x) + f(y * y)))),
    factor = f(f(f(p.size) / 8) * dist),
    sum = [0, 0, 0, 0];
  for (let i = 1; i < 8; i++) {
    const scale = f(1 - f(factor * i)),
      c = sample(f(f(x * scale) + f(p.ax)), f(f(y * scale) + f(p.ay)));
    for (let ch = 0; ch < 4; ch++) sum[ch] = f(sum[ch]! + f(f(c[ch]!) * 0.125));
  }
  const fore = sample(u, v),
    weight = f(0.125 + f(0.875 * f(1 - f(p.fade))));
  const out = fore.map((c, i) => f(f(f(c) * weight) + f(sum[i]! * f(p.fade)))) as [
    number,
    number,
    number,
    number,
  ];
  out[3] = f(out[3] * f(p.alpha));
  return out;
}
export const ARTEMIS_RADIAL_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uAx;
uniform float uAy;
uniform float uSize;
uniform float uFade;
out vec4 outColor;
void main() {
 vec2 cent=vec2(uAx,uAy),poss=vUv-cent;
 float factor=uSize/8.0*length(poss);
 vec4 sum=vec4(0.0);
 for(int i=1;i<8;i++) sum+=texture(uFore,poss*(1.0-factor*float(i))+cent)*.125;
 vec4 fore=texture(uFore,vUv)*(.125+.875*(1.0-uFade));
 fore+=sum*uFade; fore.a*=uAlpha;outColor=fore;
}`;
