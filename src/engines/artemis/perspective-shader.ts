import type {ArtemisShaderSample} from './raster-shader.js';
export type ArtemisPerspectiveKind =
  'perspective' | 'perspective_anchored' | 'perspective_vertical' | 'perspective_vertical_anchored';

/** Native constant-buffer order; fixed-center variants retain their unused center slot. */
export interface ArtemisPerspectiveUniforms {
  readonly alpha: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly scale: number;
  readonly fade: number;
}
const f = Math.fround;
function smooth(edge0: number, edge1: number, value: number): number {
  const quotient = f(f(value - edge0) / f(edge1 - edge0));
  const t = Number.isNaN(quotient) ? 0 : Math.max(0, Math.min(1, quotient));
  return f(f(t * t) * f(3 - f(2 * t)));
}

/** Reconstructed from the exact 271173e7… shader source; no game pixels are required. */
export function artemisPerspectiveShade(
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisPerspectiveUniforms,
  kind: ArtemisPerspectiveKind = 'perspective',
): readonly [number, number, number, number] {
  if (![u, v, p.alpha, p.centerX, p.centerY, p.scale, p.fade].every(Number.isFinite))
    throw Error('Invalid Artemis perspective uniforms');
  const scale = f(p.scale),
    center = f(p.centerX),
    fade = f(p.fade);
  const slope = f(f(1 - scale) / 2);
  const vertical = kind === 'perspective_vertical' || kind === 'perspective_vertical_anchored';
  const anchored = kind === 'perspective_anchored' || kind === 'perspective_vertical_anchored';
  const majorCenter = vertical ? f(p.centerY) : center;
  const minorCenter = anchored ? (vertical ? center : f(p.centerY)) : 0.5;
  const major = f(f(f(f(vertical ? v : u) - majorCenter) / scale) + majorCenter);
  const displacement = anchored ? f(majorCenter - major) : f(major - majorCenter);
  const minor = f(
    f(f(f(vertical ? u : v) - minorCenter) / f(1 - f(displacement * slope))) + minorCenter,
  );
  const x = vertical ? minor : major;
  const y = vertical ? major : minor;
  const color = sample(x, y);
  let alpha = f(color[3]);
  alpha = f(alpha * (major >= 0 && (kind === 'perspective_anchored' || major <= 1) ? 1 : 0));
  alpha = f(alpha * f(smooth(f(-fade), 0, minor) * smooth(0, fade, f(1 - minor))));
  alpha = f(alpha * f(p.alpha));
  return [color[0], color[1], color[2], alpha];
}

export function artemisPerspectiveFragmentSource(kind: ArtemisPerspectiveKind): string {
  const vertical = kind === 'perspective_vertical' || kind === 'perspective_vertical_anchored';
  const anchored = kind === 'perspective_anchored' || kind === 'perspective_vertical_anchored';
  const major = vertical ? 'y' : 'x',
    minor = vertical ? 'x' : 'y';
  const majorCenter = vertical ? 'uCenterY' : 'uCenterX';
  const minorCenter = anchored ? (vertical ? 'uCenterX' : 'uCenterY') : '0.5';
  const displacement = anchored ? `${majorCenter}-${major}` : `${major}-${majorCenter}`;
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uCenterX;
uniform float uCenterY;
uniform float uScale;
uniform float uFade;
out vec4 outColor;
void main(){
 float slope=(1.0-uScale)*0.5;
 float ${major}=(vUv.${major}-${majorCenter})/uScale+${majorCenter};
 float ${minor}=(vUv.${minor}-${minorCenter})/(1.0-(${displacement})*slope)+${minorCenter};
 vec4 c=texture(uFore,vec2(x,y));
 c.a*=step(1.0-${major},1.0)${kind === 'perspective_anchored' ? '' : `*step(${major},1.0)`};
 c.a*=smoothstep(-uFade,0.0,${minor})*smoothstep(0.0,uFade,1.0-${minor});
 c.a*=uAlpha;outColor=c;
}`;
}
export const ARTEMIS_PERSPECTIVE_FRAGMENT_SOURCE = artemisPerspectiveFragmentSource('perspective');
