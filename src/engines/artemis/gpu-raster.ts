import type {BlendState} from '../../graphics/blend.js';
import type {ArtemisFloatTrig} from './display-object.js';
import {artemisRevision} from './revision.js';
import type {ArtemisLayerMode} from './layer-properties.js';

export interface ArtemisRasterEffects {
  readonly negative: boolean;
  readonly grayscale: boolean;
  readonly colorMultiply: number;
}
export function artemisHasRasterEffects(effects: ArtemisRasterEffects): boolean {
  return effects.negative || effects.grayscale || effects.colorMultiply !== 0xffffff;
}

export interface ArtemisRasterPolicy {
  readonly filter: 'nearest' | 'linear';
  readonly blend: BlendState;
  readonly trig?: ArtemisFloatTrig;
  readonly discardTransparent?: boolean;
  readonly clearColor?: readonly [number, number, number, number];
  /** Ordinary foreground-only mode shader/blend selection; no captured back texture. */
  readonly layerMode?: (mode: ArtemisLayerMode) => {blend: BlendState; fragment?: string};
  readonly effects?: (
    mode: ArtemisLayerMode,
    effects: ArtemisRasterEffects,
  ) => {blend: BlendState; fragment?: string};
  /** Format-2 intermediate targets sample a GPU background copy and replace RGBA. */
  readonly captured?: (
    mode: ArtemisLayerMode,
    effects: ArtemisRasterEffects,
  ) => {blend: BlendState; fragment: string};
}

/** Exact revision's ordinary D3D11 image modes, with single-level surfaces.
 * 15f1d0 sampler, 15fd30 binding, 15d120 blending, shader table 349f50[0..7,24..31,48..55].
 * Captured-back shaders, custom shaders, transition textures and mip chains require owners.
 */
export function createArtemisOrdinaryGpuRaster(
  executableSha256: string,
  trig?: ArtemisFloatTrig,
): ArtemisRasterPolicy {
  const dx9 = artemisRevision(executableSha256).graphicsApi === 'd3d9';
  const effects: NonNullable<ArtemisRasterPolicy['effects']> = (mode, effects) => {
    const alpha: BlendState['alpha'] = {
      source: 'source-alpha',
      destination: 'one',
      operation: 'add',
    };
    let color: BlendState['color'];
    let result = 's';
    switch (mode) {
      case 'normal':
        color = {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'};
        break;
      case 'add':
        color = {source: 'source-alpha', destination: 'one', operation: 'add'};
        break;
      case 'screen':
        color = {source: 'inverse-destination-color', destination: 'one', operation: 'add'};
        result = 'vec4(s.rgb*s.a,0.0)';
        break;
      case 'multiply':
        color = {source: 'zero', destination: 'source-color', operation: 'add'};
        result = 'vec4(s.rgb+(vec3(1.0)-s.rgb)*(1.0-s.a),1.0)';
        break;
      default:
        throw new Error('Unsupported Artemis layer mode');
    }
    const negative = effects.negative ? 's.rgb=vec3(1.0)-s.rgb;' : '';
    const gray = effects.grayscale
      ? 'float gray=s.r*0.298912+s.g*0.586611+s.b*0.114478;s.rgb=vec3(gray);'
      : '';
    return {
      blend: {color, alpha},
      fragment:
        artemisHasRasterEffects(effects) || mode === 'screen' || mode === 'multiply'
          ? `vec4 shade(vec4 sampleColor,vec4 tint){vec4 s=sampleColor;s.a*=tint.a;${negative}${gray}s.rgb*=tint.rgb;return ${result};}`
          : undefined,
    };
  };
  const layerMode: NonNullable<ArtemisRasterPolicy['layerMode']> = (mode) =>
    effects(mode, {negative: false, grayscale: false, colorMultiply: 0xffffff});
  // 15d120 selects shader bases 72/96/120/144 for a format-2 target and
  // disables D3D blending after copying the target through CGpuSurface+88.
  const captured: NonNullable<ArtemisRasterPolicy['captured']> = (mode, state) => {
    let numerator: string;
    switch (mode) {
      case 'normal':
        numerator = 'b.rgb*b.a*(1.0-s.a)+s.rgb*s.a';
        break;
      case 'add':
        numerator = 'clamp(b.rgb+s.rgb,0.0,1.0)*b.a*s.a+b.rgb*b.a*(1.0-s.a)+s.rgb*s.a*(1.0-b.a)';
        break;
      case 'screen':
        numerator =
          '(vec3(1.0)-(vec3(1.0)-b.rgb)*(vec3(1.0)-s.rgb))*b.a*s.a+b.rgb*b.a*(1.0-s.a)+s.rgb*s.a*(1.0-b.a)';
        break;
      case 'multiply':
        numerator = '(b.rgb*b.a)*(s.rgb*s.a)+b.rgb*b.a*(1.0-s.a)+s.rgb*s.a*(1.0-b.a)';
        break;
      default:
        throw new Error('Unsupported Artemis captured layer mode');
    }
    const negative = state.negative ? 's.rgb=vec3(1.0)-s.rgb;' : '';
    const gray = state.grayscale
      ? 'float gray=s.r*0.298912+s.g*0.586611+s.b*0.114478;s.rgb=vec3(gray);'
      : '';
    return {
      blend: {
        color: {source: 'one', destination: 'zero', operation: 'add'},
        alpha: {source: 'one', destination: 'zero', operation: 'add'},
      },
      fragment: `vec4 shade(vec4 sampleColor,vec4 tint){vec4 b=texture(additionalAtlas0,additionalUV0);vec4 s=sampleColor;s.a*=tint.a;${negative}${gray}s.rgb*=tint.rgb;float a=b.a*(1.0-s.a)+s.a;return vec4((${numerator})/a,a);}`,
    };
  };
  return {
    filter: 'linear',
    blend: {
      color: {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'},
      alpha: {source: 'source-alpha', destination: 'one', operation: 'add'},
    },
    discardTransparent: false,
    clearColor: dx9 ? [0, 0, 0, 1] : [0, 0, 0, 0],
    trig,
    layerMode,
    effects,
    captured,
  };
}

/** 2898 CGpuLayer5cf080 updates SRCBLEND/DESTBLEND only on an ordinary target.
 * Separate alpha blending stays disabled. Captured custom passes inherit these
 * device factors; builtin captured passes disable blending themselves. */
export function artemisDx9DeviceBlend(mode?: ArtemisLayerMode): BlendState {
  let channel: BlendState['color'];
  switch (mode) {
    case undefined:
      channel = {source: 'one', destination: 'zero', operation: 'add'};
      break;
    case 'normal':
      channel = {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'};
      break;
    case 'add':
      channel = {source: 'source-alpha', destination: 'one', operation: 'add'};
      break;
    case 'screen':
      channel = {source: 'inverse-destination-color', destination: 'one', operation: 'add'};
      break;
    case 'multiply':
      channel = {source: 'zero', destination: 'source-color', operation: 'add'};
      break;
    default:
      throw Error('Unsupported Artemis DX9 layer mode');
  }
  return {color: channel, alpha: {...channel}};
}
