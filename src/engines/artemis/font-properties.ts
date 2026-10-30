import {artemisDecimal, artemisInteger, artemisHexUint32} from './numbers.js';
import type {ArtemisLayerMode} from './layer-properties.js';

const floats = [
  'left',
  'top',
  'width',
  'height',
  'entirealpha',
  'entireanchorx',
  'entireanchory',
  'entirerotate',
  'alpha',
  'rotate',
  'spacetop',
  'spacemiddle',
  'spacebottom',
  'kerning',
  'rubykerning',
  'entirexscale',
  'entireyscale',
  'xscale',
  'yscale',
] as const;
const integers = [
  'size',
  'shadow',
  'outline',
  'rubysize',
  'rubyshadow',
  'rubyoutline',
  'overflow',
] as const;
const flags = ['anchorcenter', 'visible', 'vertical', 'hung'] as const;
const colors = ['color', 'shadowcolor', 'outlinecolor'] as const;
const strings = ['face', 'rubyface'] as const;
export type ArtemisFontPropertyPatch = Partial<
  Record<(typeof floats)[number] | (typeof integers)[number] | (typeof colors)[number], number>
> &
  Partial<Record<(typeof flags)[number], boolean>> &
  Partial<Record<(typeof strings)[number], string>> & {
    layermode?: ArtemisLayerMode;
    align?: 'left' | 'center' | 'right' | 'equalize';
    styleBits?: number;
  };
const supported = new Set<string>([
  ...floats,
  ...integers,
  ...flags,
  ...colors,
  ...strings,
  'layermode',
  'align',
  'style',
  'stack',
  'layered',
  'show',
  // Forwarded by Lua styling; applied through separate indent/prohibit/wordparts tags.
  // evidence/font-ignored-strings.txt: these literals are referenced only by the tag
  // registry b9e80 (and range/logicalrange by d0510), never by the font handler.
  'range',
  'logicalrange',
  'indent',
  'prohibit',
  'wordparts',
  // Lua may forward its ruby-face alias after resolving rubyface. Rev.2601
  // font wrapper 0x49b8a0 / attribute setter 0x479a00 never query this key;
  // the separate ruby tag is registered at 0x48b340.
  'ruby',
]);

/** a74d0 font-frame attributes. Omitted values remain owned by the selected font;
 * overflow is the font frame's extra int, not part of the selected font copy.
 * Unimplemented float forms/int overflow refuse rather than fabricate attributes.
 */
export function artemisFontProperties(args: ReadonlyMap<string, string>): ArtemisFontPropertyPatch {
  for (const key of args.keys())
    if (!supported.has(key)) throw Error('Unsupported Artemis font property ' + key);
  const patch: ArtemisFontPropertyPatch = {};
  for (const key of floats)
    if (args.has(key)) {
      const divisor = key.endsWith('alpha') ? 255 : key.endsWith('scale') ? 100 : 1;
      const value = Math.fround(artemisDecimal(args.get(key)!) / divisor);
      if (!Number.isFinite(value)) throw Error('Unsupported Artemis font number');
      patch[key] = value; // Native divides as double, then converts once to float32.
    }
  for (const key of integers) if (args.has(key)) patch[key] = artemisInteger(args.get(key)!);
  for (const key of flags) if (args.has(key)) patch[key] = artemisInteger(args.get(key)!) !== 0;
  for (const key of colors) if (args.has(key)) patch[key] = artemisHexUint32(args.get(key)!);
  for (const key of strings) if (args.has(key)) patch[key] = args.get(key)!;
  const mode = args.get('layermode');
  if (mode === 'normal' || mode === 'add' || mode === 'screen' || mode === 'multiply')
    patch.layermode = mode;
  const align = args.get('align');
  if (align === 'left' || align === 'center' || align === 'right' || align === 'equalize')
    patch.align = align;
  if (args.has('style')) {
    patch.styleBits = 0;
    let specialized = false,
      shadow = false,
      outline = false;
    for (const token of args.get('style')!.split(',')) {
      if (token === 'bold') patch.styleBits |= 8;
      else if (token === 'italic') patch.styleBits |= 16;
      else if (token === 'underline') patch.styleBits |= 32;
      else if (token === 'strikeout') patch.styleBits |= 64;
      else if (token === 'single') specialized = true;
      else if (token === 'shadow') {
        specialized = true;
        shadow = true;
      } else if (token === 'outline') {
        specialized = true;
        outline = true;
      } else if (token === 'outline_shadow') {
        specialized = true;
        shadow = true;
        outline = true;
      }
    }
    if (specialized) {
      patch.shadow = patch.rubyshadow = shadow ? 1 : 0;
      patch.outline = patch.rubyoutline = outline ? 1 : 0;
    }
  }
  // stack controls the font deque; layered/show are not read by cd460/a74d0.
  return patch;
}
