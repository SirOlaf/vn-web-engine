import {ADD_TABLE, DEL_TABLE, type RScriptSurface} from './pixels.js';

/**
 * Tone curve `level` (0x441C50, 0x44F2D0): levels below 128 darken with add row
 * 254 - 2 * level, levels from 128 brighten with del row 2 * level - 255, so 127 and 128
 * are close to neutral. The native tables sit back to back, which this indexing mirrors.
 */
function tone(level: number, value: number): number {
  return level >= 128
    ? DEL_TABLE[((2 * level - 255) << 8) | value]!
    : ADD_TABLE[((254 - 2 * level) << 8) | value]!;
}

/** Per-channel tone levels packed as 0xRRGGBB. */
function curves(levels: number, pixel: number): number {
  const b = tone(levels & 0xff, pixel & 0xff);
  const g = tone((levels >>> 8) & 0xff, (pixel >>> 8) & 0xff);
  const r = tone((levels >>> 16) & 0xff, (pixel >>> 16) & 0xff);
  return ((pixel & 0xff000000) | (r << 16) | (g << 8) | b) >>> 0;
}

/**
 * sub_44F3F0: the tone curves weighted by the darkest channel, so pale pixels take the
 * curve and saturated ones keep their colour.
 */
function blendedCurves(levels: number, pixel: number): number {
  const b = pixel & 0xff,
    g = (pixel >>> 8) & 0xff,
    r = (pixel >>> 16) & 0xff;
  const low = Math.min(r, g, b),
    high = 255 - low;
  const mix = (level: number, value: number): number =>
    Math.min(255, ADD_TABLE[(high << 8) | tone(level, value)]! + ADD_TABLE[(low << 8) | value]!);
  return (
    ((pixel & 0xff000000) |
      (mix((levels >>> 16) & 0xff, r) << 16) |
      (mix((levels >>> 8) & 0xff, g) << 8) |
      mix(levels & 0xff, b)) >>>
    0
  );
}

/** sub_441C50: the grey level picks a tone curve, which is applied to `color` (0xRRGGBB). */
function tint(color: number, pixel: number): number {
  const grey = Math.trunc(((pixel & 0xff) + ((pixel >>> 8) & 0xff) + ((pixel >>> 16) & 0xff)) / 3);
  return (
    ((pixel & 0xff000000) |
      (tone(grey, (color >>> 16) & 0xff) << 16) |
      (tone(grey, (color >>> 8) & 0xff) << 8) |
      tone(grey, color & 0xff)) >>>
    0
  );
}

const FILTERS: Readonly<Record<number, (pixel: number) => number>> = {
  // sub_441F90 with colour 0: a silhouette.
  1: (p) => (p & 0xff000000) >>> 0,
  // sub_441E40: negative.
  2: (p) => (p ^ 0xffffff) >>> 0,
  // sub_4418C0: grey from the channel average.
  3: (p) => {
    const grey = Math.trunc(((p & 0xff) + ((p >>> 8) & 0xff) + ((p >>> 16) & 0xff)) / 3);
    return ((p & 0xff000000) | (grey << 16) | (grey << 8) | grey) >>> 0;
  },
  4: (p) => tint(0x8b4513, p),
  5: (p) => tint(0x483d8b, p),
  6: (p) => tint(0xff8000, p),
  7: (p) => blendedCurves(0x181020, p),
  8: (p) => curves(0x282040, p),
  9: (p) => curves(0x383080, p),
  10: (p) => curves(0x802d50, p),
  11: (p) => blendedCurves(0x904030, p),
  12: (p) => curves(0x805030, p),
  13: (p) => curves(0xa06040, p),
};

/**
 * Colour effects of layer images, selected by their load flags (kind 0 sub_40C870, kind 1
 * sub_40C2F0): silhouette, negative, grey, three tints and seven tone curves. Kind 0 also
 * has a hue recolour (flags 15, sub_44F5F0) that no supported title selects. Returns a
 * filtered copy, or the surface itself for other flags.
 */
export function filterLayerImage(surface: RScriptSurface, flags: number): RScriptSurface {
  const filter = FILTERS[flags];
  if (!filter) return surface;
  const data = new Uint32Array(surface.data.length);
  for (let i = 0; i < data.length; i++) data[i] = filter(surface.data[i]!);
  return {width: surface.width, height: surface.height, data};
}
