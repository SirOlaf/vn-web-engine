import {
  artemisRasterShade,
  artemisShaderFragmentSource,
  type ArtemisShaderSample,
} from './raster-shader.js';
import {artemisColorShade} from './color-shader.js';
import {artemisBlurShade, artemisBlurFragmentSource} from './blur-shader.js';
import {artemisCompositeShade} from './composite-shader.js';
import {artemisMosaicShade} from './mosaic-shader.js';
import {artemisScreenShade} from './screen-shader.js';
import type {ArtemisShaderConstant} from './shader-properties.js';

export type ArtemisDx9BlurKind =
  | 'blur_h_plain'
  | 'blur_v_plain'
  | 'blur_h_mask'
  | 'blur_v_mask'
  | 'blur_h_aa'
  | 'blur_v_aa'
  | 'blur_h_mask_aa'
  | 'blur_v_mask_aa';

export function artemisDx9BlurMode(
  kind: string,
): {axis: 'blur_h' | 'blur_v'; mask: boolean; background: boolean} | undefined {
  const modes: readonly string[] = [
    'blur_h_plain',
    'blur_v_plain',
    'blur_h_mask',
    'blur_v_mask',
    'blur_h_aa',
    'blur_v_aa',
    'blur_h_mask_aa',
    'blur_v_mask_aa',
  ];
  if (!modes.includes(kind)) return undefined;
  return {
    axis: kind.startsWith('blur_h_') ? 'blur_h' : 'blur_v',
    mask: kind.includes('_mask'),
    background: kind.endsWith('_aa'),
  };
}

export type ArtemisDx9ShaderKind =
  | ArtemisDx9BlurKind
  | 'raster'
  | 'screen'
  | 'add'
  | 'mul'
  | 'mul_lerp'
  | 'compbr'
  | 'compbrc'
  | 'compdk'
  | 'compdkc'
  | 'mosaic'
  | 'blur_h'
  | 'blur_v'
  | 'cadd'
  | 'cmul'
  | 'gray'
  | 'nega'
  | 'reset'
  | 'rgb'
  | 'sepia'
  | 'sepia2';
/** Raw source signatures, including original line endings and non-UTF8 comments. */
export const artemisDx9ShaderSources: Readonly<Record<string, ArtemisDx9ShaderKind>> =
  Object.freeze({
    e0ad84f7f214165bb7deb6c03afbb4f96b77b39364f4d888506f8e297f4881b1: 'blur_h_plain',
    '0b34ebf9ec5746af9328da6b3e0d18a3401a45f4c2abd72febffac264f55d47a': 'blur_h_aa',
    '6f13ce307619fc72de6387724f1557f0565f76e6a2500d90fdc41e2d4af6bd24': 'blur_h_mask',
    d90f2dbf77627c0a218b86e58eb32ea47855b87d187746d49b7110deeb73ea37: 'blur_h_mask_aa',
    '5129e456559f00a11a8bfa2f1ea07251129d665638347d50d15f5d4e1323a0a4': 'blur_v_plain',
    d8f52e166c2d120362cfa7b71183f337c886bbb8bee7a03ac716c12fa892d621: 'blur_v_aa',
    '6dd7f7ad0b2045bf1e384020f94517449d6ce85ec7e0c7f19439f5c3d0500e4f': 'blur_v_mask',
    '4dc114788e9e8465a8533a5a44bdde276ed3f6a0ea9808c542e33881709d18eb': 'blur_v_mask_aa',

    ad94765fa25e003048372257de2c48f96efb0dd22a82f689a93ea13a99881207: 'add',
    '6fa56eb0e99084cb7d2298337b4ca484569888656cf2504076bc51ce15894538': 'blur_h',
    '110ec434d003b0848f28465834df5334da5f2f5b38f17f4850a4cacbfacfb09d': 'blur_v',
    '0bfbaf6dfe46151fbad0687e6eae2810cc2755cd2ebced890aabb0bb13e8a006': 'cadd',
    '40477ceca5377c3500cc8d60a266b3ef073264beba34a1068edaa1c22fec5652': 'cmul',
    '67857d93874486f0a4d64807df090b995315e6df5d47744d3ef0a770dc6efc43': 'compbr',
    d4d2992e199b9af2bb765269f94ad2ba9bea580443e5010704342df7c2e5b1b8: 'compbrc',
    d4bcc2fef36f3174bc11ccf7d0d82e25777afcb8b27e54126d3fb1a77f020533: 'compdk',
    cd0981fcc5bdf8fba0b031c12212c8ac3349e53de691ba6fc3e4213b5b2d5f95: 'compdkc',
    cbdcebaa2a495912bc388e0c2b317230c94c2fc87a6eeb3d7ff976935b090cd2: 'gray',
    dd56e462d08e0c8cc7c6491b906883cc20904addbaa169678c6bf285ca965495: 'mosaic',
    '0a17fc5754a70db813fc340607b2f35f5122eef9a53725c037a6441ce0b4c8b5': 'mul',
    '154274ae0ce16676298de24c66edf4200d5f8d3eb98a8a2c42e987b7c144188c': 'mul_lerp',
    '57c2ba521bc70163744ae7acdea4a214f0902ac3bd2f440ebbaffcdd8b46f6e2': 'nega',
    ee136fde3eb26cb5d262af876a7209eaf075f303ffb7911a400447bbc0507e32: 'raster',
    f658f114a137169216ed35860fc2d77f022a094f2ce533ccca6724bb856391be: 'reset',
    cc2a75d320e5178954665cfac77871ca6aed129a091e509e463aee2decc4cf2a: 'rgb',
    '4e0abc9d945ef2d6cfc914ff93527801bf9c28838984d3c76f594056c7ba1e7a': 'screen',
    d6763064e8699beefeb73123300096d505023f9aeb1ef9d517a4f3be92809969: 'sepia',
    '3350d77079ca7bcdc33ba515608596b8f764194adb4c9dc9a187bd4881c30d00': 'sepia2',
  });

/** The original nineteen-source set has eighteen mask programs; reset ignores its mask.
 * The additional source-selected blur variants have explicit mask and captured-Back policies. */
export function artemisDx9ShaderFragmentSource(kind: ArtemisDx9ShaderKind): string {
  if (!Object.values(artemisDx9ShaderSources).includes(kind))
    throw Error('Unsupported Artemis DX9 shader kind');
  const blur = artemisDx9BlurMode(kind);
  if (blur) {
    let source = artemisBlurFragmentSource(blur.axis);
    if (blur.mask)
      source = source.replace(
        'precision highp float;',
        'precision highp float;\nuniform sampler2D uMask;',
      );
    if (blur.background)
      source = source.replace(
        'in vec2 vUv;',
        'in vec2 vUv;\nin vec2 vBackUv;\nuniform sampler2D uBack;',
      );
    return source.replace(
      'c.a *= uAlpha; outColor=c;',
      `${blur.mask ? 'c.a *= texture(uMask,vUv).a;' : ''} c.a *= uAlpha;
       ${
         blur.background
           ? `vec4 back = texture(uBack,vBackUv);
       float a = back.a * (1.0-c.a) + c.a;
       outColor = vec4((back.rgb * back.a * (1.0-c.a) + c.rgb*c.a)/a,a);`
           : 'outColor=c;'
       }`,
    );
  }
  let source = artemisShaderFragmentSource(kind);
  if (kind === 'reset') return source;
  source = source.replace('uniform float uAlpha;', '').replace(/\buAlpha\b/g, '(maskAlpha*uAlpha)');
  source = source.replace(
    'precision highp float;',
    'precision highp float;\nuniform float uAlpha;\nuniform sampler2D uMask;',
  );
  source = source.replace(
    /void main\(\)\s*\{/,
    'void main(){\nfloat maskAlpha=texture(uMask,vUv).a;',
  );
  if (kind === 'add')
    source = source.replace('user.a * user.rgb * uParam', 'maskAlpha * user.a * user.rgb * uParam');
  return source;
}
export interface ArtemisDx9ShaderUniforms {
  readonly alpha: number;
  readonly angle?: number;
  readonly inter?: number;
  readonly size?: number;
  readonly ratio?: number;
  readonly param?: number;
  readonly red?: number;
  readonly green?: number;
  readonly blue?: number;
  readonly step?: number;
  readonly weights?: readonly number[];
  readonly mask?: ArtemisShaderSample;
  readonly user?: ArtemisShaderSample;
  readonly back?: ArtemisShaderSample;
  readonly backUV?: readonly [number, number];
}
const nullTexture: ArtemisShaderSample = () => [0, 0, 0, 1];
export interface ArtemisDx9ShaderExecutable {
  (
    fore: ArtemisShaderSample,
    u: number,
    v: number,
    p: ArtemisDx9ShaderUniforms,
  ): readonly [number, number, number, number];
  (
    fore: ArtemisShaderSample,
    user: ArtemisShaderSample,
    u: number,
    v: number,
    p: ArtemisDx9ShaderUniforms,
  ): readonly [number, number, number, number];
}
/** Keep the existing calibration call shapes for shaders with/without a user sample. */
export function artemisDx9ShaderExecutable(kind: ArtemisDx9ShaderKind): ArtemisDx9ShaderExecutable {
  return (
    fore: ArtemisShaderSample,
    u: number | ArtemisShaderSample,
    v: number,
    p: number | ArtemisDx9ShaderUniforms,
    extra?: ArtemisDx9ShaderUniforms,
  ) => {
    if (typeof u === 'function') {
      if (typeof p !== 'number' || !extra) throw Error('Invalid Artemis DX9 user sample call');
      return artemisDx9ShaderShade(kind, fore, v, p, {...extra, user: u});
    }
    if (typeof p === 'number') throw Error('Invalid Artemis DX9 shader call');
    return artemisDx9ShaderShade(kind, fore, u, v, p);
  };
}
/** CPU calibration for these exact sources; unassigned float globals start at zero.
 * Fore/User/Mask sampling and native A8 channel conversion are supplied by the owner. */
export function artemisDx9ShaderShade(
  kind: ArtemisDx9ShaderKind,
  fore: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisDx9ShaderUniforms,
): readonly [number, number, number, number] {
  const blur = artemisDx9BlurMode(kind);
  if (blur) {
    const f = Math.fround;
    const c = [
      ...artemisBlurShade(blur.axis, fore, u, v, {
        alpha: 1,
        weights: p.weights ?? new Array(8).fill(0),
        step: p.step ?? 0,
      }),
    ];
    if (blur.mask) c[3] = f(c[3]! * f((p.mask ?? nullTexture)(u, v)[3]));
    c[3] = f(c[3]! * f(p.alpha));
    if (blur.background) {
      if (!p.back) throw Error('Artemis DX9 alpha blur requires a background sample');
      const back = p.back(...(p.backUV ?? [u, v]));
      const inverse = f(1 - c[3]!);
      const a = f(f(f(back[3]) * inverse) + c[3]!);
      return [0, 1, 2]
        .map((i) => f(f(f(f(f(back[i]!) * f(back[3])) * inverse) + f(c[i]! * c[3]!)) / a))
        .concat(a) as [number, number, number, number];
    }
    return c as [number, number, number, number];
  }
  const mask = kind === 'reset' ? 1 : (p.mask ?? nullTexture)(u, v)[3];
  const alpha = Math.fround(Math.fround(mask) * Math.fround(p.alpha));
  switch (kind) {
    case 'raster':
      return artemisRasterShade(fore, u, v, {
        alpha,
        angle: p.angle ?? 0,
        inter: p.inter ?? 0,
        size: p.size ?? 0,
      });
    case 'mosaic':
      return artemisMosaicShade(fore, u, v, {alpha, size: p.size ?? 0, ratio: p.ratio ?? 0});
    case 'blur_h':
    case 'blur_v':
      return artemisBlurShade(kind, fore, u, v, {
        alpha,
        weights: p.weights ?? new Array(8).fill(0),
        step: p.step ?? 0,
      });
    case 'screen':
      return artemisScreenShade(fore, p.user ?? nullTexture, u, v, {alpha});
    case 'add':
    case 'mul':
    case 'mul_lerp':
    case 'compbr':
    case 'compbrc':
    case 'compdk':
    case 'compdkc': {
      const user = p.user ?? nullTexture;
      const sample: ArtemisShaderSample =
        kind === 'add'
          ? (x, y) => {
              const c = user(x, y);
              return [c[0], c[1], c[2], Math.fround(Math.fround(mask) * Math.fround(c[3]))];
            }
          : user;
      return artemisCompositeShade(kind, fore, sample, u, v, {alpha, param: p.param ?? 0});
    }
    case 'rgb':
    case 'reset':
    case 'sepia':
    case 'sepia2':
    case 'gray':
    case 'nega':
    case 'cadd':
    case 'cmul':
      return artemisColorShade(kind, fore, u, v, {
        alpha,
        red: p.red ?? 0,
        green: p.green ?? 0,
        blue: p.blue ?? 0,
      });
    default:
      throw Error('Unsupported Artemis DX9 shader kind');
  }
}

/** Effect-owned float state. 5cf080 sets alpha, then named arrays via44858f.
 * Scalar/vector/array writes stop at Count or the field end; untouched values persist.
 * Layout below is the web shade ABI, not the padded native parameter allocation. */
export class ArtemisDx9EffectConstants {
  private readonly values: Map<string, Float32Array>;
  constructor(private readonly fields: readonly {readonly name: string; readonly size: number}[]) {
    this.values = new Map(fields.map((f) => [f.name, new Float32Array(f.size)]));
  }
  update(constants: readonly ArtemisShaderConstant[], alpha: number): Float32Array {
    if (!Number.isFinite(Math.fround(alpha))) throw Error('Invalid Artemis effect alpha');
    const result = new Float32Array(32);
    result[31] = alpha;
    for (const c of constants) {
      if (!c.values.every(Number.isFinite)) throw Error('Invalid Artemis effect float values');
      if (c.name === 'alpha') {
        if (c.values.length) result[31] = c.values[0]!;
        continue;
      }
      const element = /^([^\[\]]+)\[(\d+)\]$/.exec(c.name);
      const value = this.values.get(element ? element[1]! : c.name);
      if (!value) continue; // Native HRESULT ignored for unknown parameter names.
      const at = element ? Number(element[2]) : 0;
      if (at >= value.length || (element && value.length === 1)) continue;
      const count = Math.min(c.values.length, element ? 1 : value.length);
      for (let i = 0; i < count; i++) value[at + i] = c.values[i]!;
    }
    let offset = 0;
    for (const field of this.fields) {
      const value = this.values.get(field.name)!;
      result.set(value, offset);
      offset += value.length;
    }
    if (offset > 31) throw Error('Artemis effect parameter capacity exceeded');
    return result;
  }
}
