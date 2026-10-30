import {formatCGeneral} from '../../core/c-number-format.js';
import type {ArtemisDisplayObject} from './display-object.js';
import type {ArtemisImageClip, ArtemisLayerMode} from './layer-properties.js';
import type {ArtemisShaderConstant} from './shader-properties.js';

/** One scene actor as `var system=get_layer_info` (0x140116ee0) reads it. */
export interface ArtemisLayerInfo {
  readonly display: ArtemisDisplayObject;
  /** IDisplayObject +0x40/+0x48 (CLayer 0x1400a3e60/0x1400a3ee0); see `artemisLayerExtent`. */
  readonly width: number;
  readonly height: number;
  /** Actor slot +0 surface, its +0x10/+0x18 integer size; null without a surface. */
  readonly surface: {readonly width: number; readonly height: number} | null;
  /** Actor +0x10 TRect<float> (CLayer +0xe0). */
  readonly clip: ArtemisImageClip;
  readonly layerMode: ArtemisLayerMode;
  readonly negative: boolean;
  readonly grayscale: boolean;
  readonly colorMultiply: number;
  readonly shader: string;
  readonly shaderConstants: readonly ArtemisShaderConstant[];
}

/** CLayer width/height: 0 without a surface; otherwise the nonzero clip size, else the
 * surface size converted to float. */
export function artemisLayerExtent(
  surface: ArtemisLayerInfo['surface'],
  clip: ArtemisImageClip,
): {width: number; height: number} {
  if (!surface) return {width: 0, height: 0};
  return {
    width: clip.width !== 0 ? clip.width : Math.fround(surface.width),
    height: clip.height !== 0 ? clip.height : Math.fround(surface.height),
  };
}

/** 0x1400fdda0 (boost::lexical_cast<std::string>(float)): MSVC `%.9g` of the widened
 * float; infinities print as `inf`/`-inf`, NaN as `nan`. */
export function artemisFloatText(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  return formatCGeneral(value, 9);
}

/** cvttss2si: truncation, with 0x80000000 for values outside int32. */
function truncate(value: number): number {
  const result = Math.trunc(value);
  return Number.isFinite(result) && result >= -0x80000000 && result <= 0x7fffffff
    ? result
    : -0x80000000;
}

const layerModes: Record<ArtemisLayerMode, number> = {normal: 0, add: 1, multiply: 2, screen: 4};

/** The keys 0x140116ee0 writes below `prefix.`, in native order. Integers go through the
 * integer setter; clip, shader constants and drag area are float text. */
export function artemisLayerInfoFields(info: ArtemisLayerInfo): [string, string][] {
  const p = info.display.properties,
    f = Math.fround;
  const flag = (value: boolean) => (value ? '1' : '0');
  const rect = (values: readonly number[]) => values.map(artemisFloatText).join(',');
  const fields: [string, string][] = [
    ['left', p.left],
    ['top', p.top],
    ['width', info.width],
    ['height', info.height],
    ['alpha', f(p.alpha * 255)],
    ['anchorx', p.anchorx],
    ['anchory', p.anchory],
    ['xscale', f(p.xscale * 100)],
    ['yscale', f(p.yscale * 100)],
    ['rotate', p.rotate],
  ].map(([key, value]) => [key as string, String(truncate(value as number))]);
  fields.push(['reversex', flag(p.reversex)], ['reversey', flag(p.reversey)]);
  fields.push(['visible', flag(p.visible)]);
  if (info.surface)
    fields.push(
      ['surfacewidth', String(info.surface.width | 0)],
      ['surfaceheight', String(info.surface.height | 0)],
    );
  const {clip} = info;
  fields.push(['clip', rect([clip.left, clip.top, clip.width, clip.height])]);
  fields.push(['layermode', String(layerModes[info.layerMode])]);
  fields.push(['negative', flag(info.negative)], ['grayscale', flag(info.grayscale)]);
  fields.push(['colormultiply', String(info.colorMultiply | 0)]);
  fields.push(['shader', info.shader]);
  fields.push(['shaderconstant.size', String(info.shaderConstants.length)]);
  info.shaderConstants.forEach(({name, values}, index) => {
    const key = `shaderconstant.${index}.`;
    fields.push([`${key}name`, name], [`${key}data.size`, String(values.length)]);
    values.forEach((value, at) => fields.push([`${key}data.${at}`, artemisFloatText(value)]));
  });
  fields.push(['clickablethreshold', String(info.display.clickableThreshold)]);
  fields.push(['draggable', flag(info.display.draggable)]);
  const area = info.display.dragArea;
  fields.push(['dragarea', rect([area.left, area.top, area.right, area.bottom])]);
  return fields;
}
