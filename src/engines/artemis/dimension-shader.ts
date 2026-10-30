import type {ArtemisShaderSample} from './raster-shader.js';

export type ArtemisDimensionKind = 'dimhole' | 'dimring';
export interface ArtemisDimensionUniforms {
  readonly alpha: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly ratio: number;
  readonly thick?: number;
}
const f = Math.fround;
/** HLSL smoothstep uses saturate even with reversed edges. GLSL's intrinsic leaves
 * that case undefined. DXBC saturate maps NaN to zero, including equal-edge 0/0. */
function smooth(a: number, b: number, x: number): number {
  const q = f(f(x - a) / f(b - a));
  const t = f(Number.isNaN(q) ? 0 : Math.max(0, Math.min(1, q)));
  return f(f(t * t) * f(3 - f(2 * t)));
}
/** Exact DX11 programs use Fore at TEXCOORD1. Back and Mask samples are unused;
 * neither the sampled mask nor colorMultiply changes their output. */
export function artemisDimensionShade(
  kind: ArtemisDimensionKind,
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisDimensionUniforms,
): readonly [number, number, number, number] {
  if (![u, v, p.alpha, p.centerX, p.centerY, p.radius, p.ratio].every(Number.isFinite))
    throw Error('Invalid Artemis dimension uniforms');
  const x = f(u),
    y = f(v),
    cx = f(p.centerX),
    cy = f(p.centerY),
    correctedY = f(f(f(y - 0.5) * f(p.ratio)) + 0.5),
    dx = f(cx - x),
    dy = f(cy - correctedY),
    r = f(Math.sqrt(f(f(dx * dx) + f(dy * dy)))),
    radius = f(p.radius),
    r1 = f(r - radius);
  if (kind === 'dimhole') {
    const r2 = f(r1 - f(radius * 1.5)),
      range = f(1 - smooth(r, r2, 0)),
      dist = range <= 0 ? 1 : f(1 - range),
      color = sample(f(cx + f(f(x - cx) * dist)), f(cy + f(f(y - cy) * dist))),
      alpha = f(f(color[3]) * f(1 - smooth(r1, f(r1 + f(0.001)), 0)));
    return [color[0], color[1], color[2], f(alpha * f(p.alpha))];
  }
  if (!Number.isFinite(p.thick)) throw Error('Invalid Artemis dimension ring thickness');
  const r2 = f(r1 - f(p.thick!)),
    a1 = smooth(r1, f(r1 - f(0.001)), 0),
    a2 = smooth(r2, f(r2 + f(0.001)), 0),
    bright = f(f(a1 * a2) * 0.5),
    color = sample(x, y);
  return [
    f(f(color[0]) + bright),
    f(f(color[1]) + bright),
    f(f(color[2]) + bright),
    f(f(color[3]) * f(p.alpha)),
  ];
}
export function artemisDimensionFragmentSource(kind: ArtemisDimensionKind): string {
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uCenterX;
uniform float uCenterY;
uniform float uRadius;
uniform float uRatio;
${kind === 'dimring' ? 'uniform float uThick;' : ''}
out vec4 outColor;
float hlslSmooth(float a,float b,float x){
 float t=a==b?(x>a?1.0:0.0):clamp((x-a)/(b-a),0.0,1.0);
 return t*t*(3.0-2.0*t);
}
void main(){
 vec2 cn=vec2(uCenterX,uCenterY);
 vec2 corrected=vec2(vUv.x,(vUv.y-0.5)*uRatio+0.5);
 float r=distance(cn,corrected),r1=r-uRadius;
 ${
   kind === 'dimhole'
     ? `float r2=r1-uRadius*1.5;
 float range=1.0-hlslSmooth(r,r2,0.0);
 float dist=range<=0.0?1.0:1.0-range;
 vec4 fore=texture(uFore,mix(cn,vUv,dist));
 fore.a*=1.0-hlslSmooth(r1,r1+0.001,0.0);`
     : `float r2=r1-uThick;
 vec4 fore=texture(uFore,vUv);
 float a1=hlslSmooth(r1,r1-0.001,0.0);
 float a2=hlslSmooth(r2,r2+0.001,0.0);
 fore.rgb+=a1*a2*0.5;`
 }
 fore.a*=uAlpha;
 outColor=fore;
}`;
}
