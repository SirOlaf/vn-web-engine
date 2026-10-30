/**
 * PackinOne's `layerExImage` (wamsoft layerExImage as of 2013-06-30, CxImage 7.0.2 DSP code):
 * `Layer.light`, `colorize`, `modulate`, `noise`, `generateWhiteNoise` and `gaussianBlur` on
 * the clipped main image, followed by `update` of the clip rectangle.
 *
 * Arithmetic follows the x87 build: expressions run in double precision and values are rounded
 * to `float` where the C code stores them in `float` variables (`Math.fround`); conversions to
 * `BYTE` truncate to an integer and keep the low 8 bits. `noise` and `generateWhiteNoise` use
 * the plugin's C runtime `rand` (seed 1 at load).
 */
import {
  ncbInt,
  ncbReal,
  NcbClassInfo,
  type NcbAttachDefinition,
} from '../../engines/kirikiri/tp-stub/ncbind.js';
import type {TvpFunctionExporter} from '../tvp-plugin/contract.js';
import {LayerExBase, MsvcRand, RAND_MAX} from './layer-access.js';

const f32 = Math.fround;
/** `(BYTE)x` of a floating value. */
const byte = (x: number) => Math.trunc(x) & 0xff;

class LayerExImage extends LayerExBase {
  /** `reset`: the buffer at the clip origin, the size of the clip rectangle. */
  override reset(): void {
    super.reset();
    this.buffer += this.clipTop * this.pitch + this.clipLeft * 4;
    this.width = this.clipWidth;
    this.height = this.clipHeight;
  }
}

const HSLMAX = 255;
const RGBMAX = 255;
const HSLUNDEFINED = Math.trunc((HSLMAX * 2) / 3);

/** `RGBtoHSL`: [H, S, L] bytes (the RGBQUAD's red, green and blue). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const cMax = Math.max(r, g, b);
  const cMin = Math.min(r, g, b);
  const l = Math.trunc(((cMax + cMin) * HSLMAX + RGBMAX) / (2 * RGBMAX)) & 0xff;
  let h: number;
  let s: number;
  if (cMax === cMin) {
    s = 0;
    h = HSLUNDEFINED;
  } else {
    if (l <= HSLMAX / 2)
      s =
        Math.trunc(((cMax - cMin) * HSLMAX + Math.trunc((cMax + cMin) / 2)) / (cMax + cMin)) & 0xff;
    else
      s =
        Math.trunc(
          ((cMax - cMin) * HSLMAX + Math.trunc((2 * RGBMAX - cMax - cMin) / 2)) /
            (2 * RGBMAX - cMax - cMin),
        ) & 0xff;
    const d = (c: number) =>
      Math.trunc(
        ((cMax - c) * Math.trunc(HSLMAX / 6) + Math.trunc((cMax - cMin) / 2)) / (cMax - cMin),
      ) & 0xffff;
    const rd = d(r);
    const gd = d(g);
    const bd = d(b);
    if (r === cMax) h = (bd - gd) & 0xff;
    else if (g === cMax) h = (Math.trunc(HSLMAX / 3) + rd - bd) & 0xff;
    else h = (Math.trunc((2 * HSLMAX) / 3) + gd - rd) & 0xff;
    if (h > HSLMAX) h -= HSLMAX;
  }
  return [h, s, l];
}

function hueToRgb(n1: number, n2: number, hue: number): number {
  let h = hue;
  if (h > 360) h = f32(h - 360);
  else if (h < 0) h = f32(h + 360);
  let v: number;
  if (h < 60) v = n1 + ((n2 - n1) * h) / 60;
  else if (h < 180) v = n2;
  else if (h < 240) v = n1 + ((n2 - n1) * (240 - h)) / 60;
  else v = n1;
  return f32(v);
}

/** `HSLtoRGB` of [H, S, L] bytes: [r, g, b]. */
function hslToRgb(hb: number, sb: number, lb: number): [number, number, number] {
  const h = f32((hb * 360) / 255);
  const s = f32(sb / 255);
  const l = f32(lb / 255);
  const m2 = l <= 0.5 ? f32(l * (1 + s)) : f32(l + s - l * s);
  const m1 = f32(2 * l - m2);
  if (s === 0) {
    const v = byte(l * 255);
    return [v, v, v];
  }
  return [
    byte(hueToRgb(m1, m2, f32(h + 120)) * 255),
    byte(hueToRgb(m1, m2, h) * 255),
    byte(hueToRgb(m1, m2, f32(h - 120)) * 255),
  ];
}

function hue2rgb(n1: number, n2: number, hue: number): number {
  let h = hue;
  if (h < 0) h += 1.0;
  else if (h > 1.0) h -= 1.0;
  let c: number;
  if (h < 1.0 / 6.0) c = n1 + (n2 - n1) * h * 6.0;
  else if (h < 1.0 / 2.0) c = n2;
  else if (h < 2.0 / 3.0) c = n1 + (n2 - n1) * (2.0 / 3.0 - h) * 6.0;
  else c = n1;
  return Math.trunc(c * 255.0);
}

/** `::modulate` of one pixel. */
function modulatePixel(
  b: number,
  g: number,
  r: number,
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  const red = r / 255.0;
  const green = g / 255.0;
  const blue = b / 255.0;
  const cMax = Math.max(red, green, blue);
  const cMin = Math.min(red, green, blue);
  const delta = cMax - cMin;
  const add = cMax + cMin;
  let luminance = add / 2.0;
  let hue: number;
  let saturation: number;
  if (delta === 0) {
    saturation = 0;
    hue = 0;
  } else {
    saturation = luminance < 0.5 ? delta / add : delta / (2.0 - add);
    if (red === cMax) hue = (green - blue) / delta;
    else if (green === cMax) hue = 2.0 + (blue - red) / delta;
    else hue = 4.0 + (red - green) / delta;
    hue /= 6.0;
  }
  hue += h;
  while (hue < 0) hue += 1.0;
  while (hue > 1.0) hue -= 1.0;
  if (s > 0) saturation += (1.0 - saturation) * s;
  else saturation += saturation * s;
  if (l > 0) luminance += (1.0 - luminance) * l;
  else luminance += luminance * l;
  if (saturation === 0.0) {
    const v = Math.trunc(luminance * 255.0);
    return [v, v, v];
  }
  const m2 =
    luminance <= 0.5
      ? luminance * (1 + saturation)
      : luminance + saturation - luminance * saturation;
  const m1 = 2.0 * luminance - m2;
  return [hue2rgb(m1, m2, hue - 1.0 / 3.0), hue2rgb(m1, m2, hue), hue2rgb(m1, m2, hue + 1.0 / 3.0)];
}

/** `gen_convolve_matrix`. */
function convolveMatrix(radiusParam: number): Float32Array {
  let radius = f32(f32(Math.abs(0.5 * radiusParam)) + 0.25);
  const stdDev = radius;
  radius = f32(stdDev * 2);
  let length = Math.trunc(2 * Math.ceil(radius - 0.5) + 1);
  if (length <= 0) length = 1;
  const m = new Float32Array(length);
  const half = Math.trunc(length / 2);
  for (let i = half + 1; i < length; i++) {
    const baseX = f32(i - f32(Math.floor(f32(half))) - 0.5);
    let sum = 0;
    for (let j = 1; j <= 50; j++) {
      if (baseX + 0.02 * j <= radius)
        sum = f32(
          sum + f32(Math.exp((-(baseX + 0.02 * j) * (baseX + 0.02 * j)) / (2 * stdDev * stdDev))),
        );
    }
    m[i] = sum / 50;
  }
  for (let i = 0; i <= half; i++) m[i] = m[length - 1 - i]!;
  let sum = 0;
  for (let j = 0; j <= 50; j++)
    sum = f32(sum + f32(Math.exp((-(0.5 + 0.02 * j) * (0.5 + 0.02 * j)) / (2 * stdDev * stdDev))));
  m[half] = sum / 51;
  sum = 0;
  for (let i = 0; i < length; i++) sum = f32(sum + m[i]!);
  for (let i = 0; i < length; i++) m[i] = m[i]! / sum;
  return m;
}

/** `gen_lookup_table`. */
function lookupTable(m: Float32Array): Float32Array {
  const t = new Float32Array(m.length * 256);
  for (let i = 0; i < m.length; i++) for (let j = 0; j < 256; j++) t[i * 256 + j] = m[i]! * j;
  return t;
}

/** `blur_line` over `y` pixels of `bytes` channels. */
function blurLine(
  ctable: Float32Array,
  m: Float32Array,
  cur: Uint8Array,
  dest: Uint8Array,
  y: number,
  bytes: number,
): void {
  const len = m.length;
  const middle = Math.trunc(len / 2);
  let row: number;
  if (len > y) {
    for (row = 0; row < y; row++) {
      let scale = 0;
      for (let j = 0; j < y; j++)
        if (j + middle - row >= 0 && j + middle - row < len)
          scale = f32(scale + m[j + middle - row]!);
      for (let i = 0; i < bytes; i++) {
        let sum = 0;
        for (let j = 0; j < y; j++)
          if (j >= row - middle && j <= row + middle) sum = f32(sum + cur[j * bytes + i]! * m[j]!);
        dest[row * bytes + i] = byte(0.5 + sum / scale);
      }
    }
    return;
  }
  for (row = 0; row < middle; row++) {
    let scale = 0;
    for (let j = middle - row; j < len; j++) scale = f32(scale + m[j]!);
    for (let i = 0; i < bytes; i++) {
      let sum = 0;
      for (let j = middle - row; j < len; j++)
        sum = f32(sum + cur[(row + j - middle) * bytes + i]! * m[j]!);
      dest[row * bytes + i] = byte(0.5 + sum / scale);
    }
  }
  let d = row * bytes;
  for (; row < y - middle; row++) {
    let c = (row - middle) * bytes;
    for (let i = 0; i < bytes; i++) {
      let sum = 0;
      let c1 = c;
      let t = 0;
      for (let j = len; j > 0; j--) {
        sum = f32(sum + ctable[t + cur[c1]!]!);
        c1 += bytes;
        t += 256;
      }
      c++;
      dest[d++] = byte(0.5 + sum);
    }
  }
  for (; row < y; row++) {
    let scale = 0;
    for (let j = 0; j < y - row + middle; j++) scale = f32(scale + m[j]!);
    for (let i = 0; i < bytes; i++) {
      let sum = 0;
      for (let j = 0; j < y - row + middle; j++)
        sum = f32(sum + cur[(row + j - middle) * bytes + i]! * m[j]!);
      dest[row * bytes + i] = byte(0.5 + sum / scale);
    }
  }
}

export const LAYER_EX_IMAGE = new NcbClassInfo<LayerExImage>('layerExImage');

/** `NCB_ATTACH_CLASS_WITH_HOOK(layerExImage, Layer)`. */
export function layerExImage(
  ex: TvpFunctionExporter,
  memory: () => Uint8Array,
  random: MsvcRand,
): NcbAttachDefinition<LayerExImage> {
  const lut = (t: LayerExImage, table: Uint8Array) => {
    const u8 = memory();
    for (let i = 0, row = t.buffer; i < t.height; i++, row += t.pitch)
      for (let j = 0, p = row; j < t.width; j++, p += 4) {
        u8[p] = table[u8[p]!]!;
        u8[p + 1] = table[u8[p + 1]!]!;
        u8[p + 2] = table[u8[p + 2]!]!;
      }
  };
  return {
    info: LAYER_EX_IMAGE,
    tjs2Class: 'Layer',
    getInstance: (info, objthis) => {
      let inst = info.instance(objthis);
      if (!inst) {
        inst = new LayerExImage(ex, objthis);
        info.attachInstance(objthis, inst);
      }
      inst.reset();
      return inst;
    },
    define: (r) =>
      r
        .method('light', 2, (t, args) => {
          const c = f32((100 + ncbInt(args[1]!)) / 100);
          const brightness = ncbInt(args[0]!) + 128;
          const table = new Uint8Array(256);
          for (let i = 0; i < 256; i++)
            table[i] = Math.max(0, Math.min(255, Math.trunc((i - 128) * c + brightness)));
          lut(t, table);
          t.redraw();
        })
        .method('colorize', 3, (t, args) => {
          const hue = ncbInt(args[0]!) & 0xff;
          const sat = ncbInt(args[1]!) & 0xff;
          let blend = ncbReal(args[2]!);
          if (blend < 0) blend = 0;
          if (blend > 1) blend = 1;
          const a0 = Math.trunc(256 * blend);
          const a1 = 256 - a0;
          const full = blend > f32(0.999);
          const u8 = memory();
          for (let y = 0, row = t.buffer; y < t.height; y++, row += t.pitch)
            for (let x = 0, p = row; x < t.width; x++, p += 4) {
              const b = u8[p]!;
              const g = u8[p + 1]!;
              const rr = u8[p + 2]!;
              const [, , l] = rgbToHsl(rr, g, b);
              const [nr, ng, nb] = hslToRgb(hue, sat, l);
              if (full) {
                u8[p] = nb;
                u8[p + 1] = ng;
                u8[p + 2] = nr;
              } else {
                u8[p] = ((nb * a0 + b * a1) >> 8) & 0xff;
                u8[p + 1] = ((ng * a0 + g * a1) >> 8) & 0xff;
                u8[p + 2] = ((nr * a0 + rr * a1) >> 8) & 0xff;
              }
            }
          t.redraw();
        })
        .method('modulate', 3, (t, args) => {
          const h = ncbInt(args[0]!) / 360.0;
          const s = ncbInt(args[1]!) / 100.0;
          const l = ncbInt(args[2]!) / 100.0;
          const u8 = memory();
          for (let y = 0, row = t.buffer; y < t.height; y++, row += t.pitch)
            for (let x = 0, p = row; x < t.width; x++, p += 4) {
              const [b, g, r2] = modulatePixel(u8[p]!, u8[p + 1]!, u8[p + 2]!, h, s, l);
              u8[p] = b & 0xff;
              u8[p + 1] = g & 0xff;
              u8[p + 2] = r2 & 0xff;
            }
          t.redraw();
        })
        .method('noise', 1, (t, args) => {
          const level = ncbInt(args[0]!);
          const u8 = memory();
          const n = () => Math.trunc((f32(random.rand() / RAND_MAX) - 0.5) * level);
          for (let y = 0, row = t.buffer; y < t.height; y++, row += t.pitch)
            for (let x = 0, p = row; x < t.width; x++, p += 4)
              for (let c = 0; c < 3; c++) u8[p + c] = Math.max(0, Math.min(255, u8[p + c]! + n()));
          t.redraw();
        })
        .method('generateWhiteNoise', 0, (t) => {
          const u8 = memory();
          for (let y = 0, row = t.buffer; y < t.height; y++, row += t.pitch)
            for (let x = 0, p = row; x < t.width; x++, p += 4) {
              const v = Math.trunc(random.rand() / Math.trunc(RAND_MAX / 255)) & 0xff;
              u8[p] = u8[p + 1] = u8[p + 2] = v;
            }
          t.redraw();
        })
        .method('gaussianBlur', 1, (t, args) => {
          const u8 = memory();
          const w = t.width;
          const h = t.height;
          const tmpPitch = w * 4;
          const tmp = new Uint8Array(tmpPitch * h);
          const m = convolveMatrix(f32(ncbReal(args[0]!)));
          const ctable = lookupTable(m);
          const line = new Uint8Array(Math.max(w, h) * 4);
          for (let y = 0; y < h; y++) {
            const start = t.buffer + t.pitch * y;
            line.set(u8.subarray(start, start + w * 4));
            blurLine(ctable, m, line, tmp.subarray(tmpPitch * y, tmpPitch * (y + 1)), w, 4);
          }
          const cur = new Uint8Array(h * 4);
          const dest = new Uint8Array(h * 4);
          for (let x = 0; x < w; x++) {
            for (let y = 0; y < h; y++)
              cur.set(tmp.subarray(tmpPitch * y + x * 4, tmpPitch * y + x * 4 + 4), y * 4);
            blurLine(ctable, m, cur, dest, h, 4);
            for (let y = 0; y < h; y++)
              u8.set(dest.subarray(y * 4, y * 4 + 4), t.buffer + t.pitch * y + x * 4);
          }
          t.redraw();
        }),
  };
}

/** `NCB_PRE_REGIST_CALLBACK(init)`: the CxImage notice in the important log. */
export const CXIMAGE_COPYRIGHT =
  '----- CxImage Copyright START -----\n' +
  'CxImage version 7.0.2 07/Feb/2011\n' +
  'CxImage : Copyright (C) 2001 - 2011, Davide Pizzolato\n' +
  'Original CImage and CImageIterator implementation are:\n' +
  'Copyright (C) 1995, Alejandro Aguilar Sierra (asierra(at)servidor(dot)unam(dot)mx)\n' +
  '----- CxImage Copyright END -----\n';
