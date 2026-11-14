import {artemisShaderProperties, type ArtemisShaderPropertyPatch} from './shader-properties.js';
import {artemisHexUint32, artemisDecimal, artemisInteger} from './numbers.js';

export type ArtemisLayerMode = 'normal' | 'add' | 'screen' | 'multiply';
/** Native TRect<float> stores dimensions and inclusive endpoints independently. */
export interface ArtemisImageClip {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}
export interface ArtemisLayerPropertyPatch {
  customShader?: ArtemisShaderPropertyPatch;
  left?: number;
  top?: number;
  alpha?: number;
  /** Outer CArtemisLayer alpha uses double division before conversion to float. */
  wrapperAlpha?: number;
  anchorx?: number;
  anchory?: number;
  xscale?: number;
  yscale?: number;
  rotate?: number;
  reversex?: boolean;
  reversey?: boolean;
  visible?: boolean;
  layermode?: ArtemisLayerMode;
  negative?: boolean;
  grayscale?: boolean;
  colormultiply?: number;
  clip?: ArtemisImageClip;
  intermediateRender?: {enabled: boolean; format?: 1 | 2};
  /** Image path loaded through the stage surface cache (0x1400d76d0) for the node's mask
   * setter 0x1400b29c0; the owner reads the resource. */
  intermediateRenderMask?: string;
  /** 0x1400d76d0 atoi, forwarded by CArtemisLayer +0xe8 (0x1400b2e10) to the inner actors. */
  clickablethreshold?: number;
  /** 0x1400d76d0: exactly "0" clears, any other value sets; actor +0xf0 (0x1400a4970). */
  draggable?: boolean;
  /** 0x1400d76d0: four comma fields through atof; actor +0xf8 (0x1400a4980). */
  dragarea?: ArtemisImageClip;
}
const numeric = [
  'left',
  'top',
  'alpha',
  'anchorx',
  'anchory',
  'xscale',
  'yscale',
  'rotate',
] as const;
const flags = ['reversex', 'reversey', 'visible', 'negative', 'grayscale'] as const;
const supported = new Set<string>([
  'id',
  'shader',
  'shaderconstant',
  'shadertexture',
  'layermode',
  'colormultiply',
  'clip',
  'intermediate_render',
  'intermediate_render_mask',
  'clickablethreshold',
  'draggable',
  'dragarea',
  // Game Lua forwards its creation argument table to lyprop. Native d76d0 /
  // 115650 never query these keys; keep the recorded tag without reloading.
  'file',
  'width',
  'height',
  'color',
  'rule',
  'mask',
  // lyc2 copies these Lua aliases into left/top/xscale/yscale but also forwards
  // the original keys. Native consumes only the resulting property names.
  'x',
  'y',
  'zoom',
  ...numeric,
  ...flags,
]);

/** Decimal finite subset of native atof; preserve prefix parsing and float32 rounding. */
function decimal(value: string): number {
  const number = artemisDecimal(value, 'Unsupported Artemis layer property number');
  if (!Number.isFinite(Math.fround(number)))
    throw new Error('Unsupported Artemis layer property number');
  return number;
}

/** Ordinary image geometry subset of 0x140115650 and wrapper alpha in 0x1400d76d0. */
export function artemisLayerProperties(
  args: ReadonlyMap<string, string>,
  executableSha256?: string,
): ArtemisLayerPropertyPatch {
  const named = new Set<string>();
  for (const key of ['shaderconstant', 'shadertexture'])
    if (args.has(key))
      for (const name of args.get(key)!.split('\0', 1)[0]!.split(',')) named.add(name);
  for (const key of args.keys())
    if (!supported.has(key) && !named.has(key))
      throw new Error(`Unsupported Artemis layer property ${key}`);
  const patch: ArtemisLayerPropertyPatch = {};
  if (['shader', 'shaderconstant', 'shadertexture'].some((key) => args.has(key))) {
    const shader = artemisShaderProperties(args, executableSha256);
    if (Object.keys(shader).length) patch.customShader = shader;
  }
  if (args.has('intermediate_render')) {
    const value = args.get('intermediate_render');
    patch.intermediateRender = {
      enabled: value !== '0',
      format: value === '1' ? 2 : value === '2' ? 1 : undefined,
    };
  }
  if (args.has('intermediate_render_mask'))
    patch.intermediateRenderMask = args.get('intermediate_render_mask')!;
  for (const key of numeric) {
    if (!args.has(key)) continue;
    const double = decimal(args.get(key)!);
    const float = Math.fround(double);
    patch[key] =
      key === 'alpha'
        ? Math.fround(float / 255)
        : key === 'xscale' || key === 'yscale'
          ? Math.fround(float / 100)
          : float;
    if (key === 'alpha') patch.wrapperAlpha = Math.fround(double / 255);
  }
  if (args.has('clickablethreshold'))
    patch.clickablethreshold = artemisInteger(args.get('clickablethreshold')!);
  if (args.has('draggable')) patch.draggable = args.get('draggable') !== '0';
  if (args.has('dragarea')) {
    // Split at "," with empty fields kept (0x1400a0770); other counts are ignored.
    const parts = args.get('dragarea')!.split('\0', 1)[0]!.split(',');
    if (parts.length === 4) {
      const [left, top, right, bottom] = parts.map((part) => Math.fround(decimal(part))) as [
        number,
        number,
        number,
        number,
      ];
      // TRect<float> sizes are inclusive: endpoint difference plus 1.0f (0x1403fbf38).
      const width = Math.fround(Math.fround(right - left) + 1);
      const height = Math.fround(Math.fround(bottom - top) + 1);
      if (!Number.isFinite(width) || !Number.isFinite(height))
        throw new Error('Unsupported Artemis drag area');
      patch.dragarea = {left, top, width, height, right, bottom};
    }
  }
  for (const key of flags) if (args.has(key)) patch[key] = args.get(key) !== '0';
  const mode = args.get('layermode');
  if (mode === 'normal' || mode === 'add' || mode === 'screen' || mode === 'multiply')
    patch.layermode = mode;
  // Native 115650 leaves the prior mode unchanged for any other spelling.
  if (args.has('colormultiply')) patch.colormultiply = artemisHexUint32(args.get('colormultiply')!);
  if (args.has('clip')) {
    const parts = args.get('clip')!.split('\0', 1)[0]!.split(',');
    // 115650 accepts exactly four fields, including empty comma-separated fields.
    if (parts.length === 4) {
      const [left, top, width, height] = parts.map((part) => Math.fround(decimal(part))) as [
        number,
        number,
        number,
        number,
      ];
      const right = Math.fround(Math.fround(left + width) - 1);
      const bottom = Math.fround(Math.fround(top + height) - 1);
      if (!Number.isFinite(right) || !Number.isFinite(bottom))
        throw new Error('Unsupported Artemis clip rectangle');
      patch.clip = {left, top, width, height, right, bottom};
    }
  }
  return patch;
}
