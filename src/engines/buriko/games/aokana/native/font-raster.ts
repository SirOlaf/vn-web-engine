import {AokanaBrowserFontFace} from './font-browser.js';
import {nativeSineFirstQuadrant} from '../bp/opcodes/native-math.js';

export type AokanaFontTransform = readonly [number, number, number, number, number];
export interface AokanaFontGeometry {
  readonly size: number;
  readonly widthPercent: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly dibWidth: number;
  readonly dibHeight: number;
  readonly fontHeight: number;
  readonly fontWidth: number;
  readonly autoFit: boolean;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly extra: number;
}

/** Native font globals have title-local lifetime; changing them does not flush cached glyphs. */
export class AokanaFontRasterSettings {
  textOut = true;
  quality = 1;
  sampleScale = 4;
  sampleShift = 2;
  areaShift = 4;
  gamma: 0 | 1 = 0;
  preserveVariablePitch = 0;
  setQuality(value: number): boolean {
    value |= 0;
    if (value >= 4) return false;
    const selected = this.textOut ? value : -1;
    this.sampleShift = selected >= 0 && selected <= 3 ? selected + 1 : 0;
    this.sampleScale = 1 << this.sampleShift;
    this.areaShift = this.sampleShift * 2;
    this.quality = value;
    return true;
  }
  useOutline(): void {
    this.textOut = false;
    this.setQuality(this.quality);
  }
  setGamma(value: number): boolean {
    if (value >>> 0 >= 2) return false;
    this.gamma = value as 0 | 1;
    return true;
  }
}

function divide(value: number, divisor: number): number {
  if (divisor === 0 || (value === -2147483648 && divisor === -1))
    throw new RangeError('Aokana native font integer division fault');
  return Math.trunc((value | 0) / (divisor | 0));
}
function fixed(a: number, b: number): number {
  return Math.imul(a, b) >> 16;
}

export function validateAokanaFont(
  nameLength: number | null,
  size: number,
  widthPercent: number,
  allowDefault: boolean,
): number {
  if ((nameLength === null || (nameLength - 1) >>> 0 >= 0x5f) && !allowDefault) return 0x80000004;
  if ((size - 4) >>> 0 > 0xc4 && (!allowDefault || size !== 0)) return 0x80000002;
  if ((widthPercent - 25) >>> 0 > 0xaf && (!allowDefault || widthPercent !== 0)) return 0x80000003;
  return 0;
}

export function validateAokanaFontTransform(transform: AokanaFontTransform): number {
  const [x, y, offsetX, offsetY, extra] = transform;
  if ((extra + 0x10000) >>> 0 > 0x20000) return 0x80000007;
  if (x === 0 && y === 0 && offsetX === 0 && offsetY === 0) return 0;
  if (x !== 0 && (x - 0x10000) >>> 0 > 0x10000) return 0x80000005;
  if ((y - 0x10000) >>> 0 > 0x10000) return 0x80000005;
  if (
    offsetX > Math.trunc(65536 - 4294967296 / (x === 0 ? y : x)) ||
    offsetY > Math.trunc(65536 - 4294967296 / y)
  )
    return 0x80000006;
  return 0;
}

/** 14006a590 geometry before platform font creation and outline-metric correction. */
export function aokanaFontGeometry(
  size: number,
  widthPercent: number,
  transform: AokanaFontTransform | null,
  settings: AokanaFontRasterSettings,
): AokanaFontGeometry {
  const autoFit = transform !== null && transform.slice(0, 4).every((value) => value === 0);
  const scaleY = transform && !autoFit ? transform[1] : 65536;
  const scaleX = transform && !autoFit ? (transform[0] === 0 ? scaleY : transform[0]) : 65536;
  const applyWidth = transform === null || (!autoFit && transform[0] !== 0);
  const width = divide(Math.imul(Math.imul(size, widthPercent), 2), 100);
  const height = divide(Math.imul(size, 3), 2);
  const scaledSize = fixed(scaleY, size);
  return {
    size,
    widthPercent,
    width,
    height,
    stride: width,
    dibWidth: Math.imul(fixed(width, scaleX), settings.sampleScale),
    dibHeight: Math.imul(
      autoFit ? Math.imul(height, 2) : fixed(height, scaleY),
      settings.sampleScale,
    ),
    fontHeight: Math.imul(Math.imul(scaledSize, settings.sampleScale), autoFit ? -1 : 1),
    fontWidth: applyWidth
      ? Math.imul(
          fixed(divide(Math.imul(size, widthPercent), 100), scaleX),
          settings.sampleScale,
        ) >> 1
      : 0,
    autoFit,
    scaleX,
    scaleY,
    offsetX: transform ? fixed(fixed(scaleX, size), transform[2]) : 0,
    offsetY: transform ? fixed(scaledSize, transform[3]) : 0,
    extra: transform?.[4] ?? 0,
  };
}

export interface AokanaGlyph {
  readonly character: number;
  readonly fullWidth: number;
  readonly pixels: Uint8Array;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly abc: readonly [number, number, number];
  readonly wideExtent: number;
}

export function aokanaWideCharacter(value: number): number {
  value >>>= 0;
  return Number(!((value - 0x80) >>> 0 > 0xfee0 && value < 0xffa0));
}

function snapNearInteger(value: number): number {
  const floor = Math.floor(value);
  if (1 - 2 ** -14 <= value - floor) return Math.ceil(value);
  return value - floor <= 2 ** -14 ? floor : value;
}

/** TextOutW-only substitutions; the outline path passes the original code directly. */
export function aokanaGlyphText(value: number): {character: number; text: string | null} {
  value >>>= 0;
  if ((value - 0x20) >>> 0 < 0xd7e0 || (value >= 0xf900 && value < 0x10000))
    return {character: value, text: String.fromCharCode(value)};
  if (value >= 0x10000)
    return {
      character: value,
      text: String.fromCharCode(
        (((value - 0x10000) >>> 10) + 0xd800) & 0xffff,
        (value & 0x3ff) + 0xdc00,
      ),
    };
  const replacements = new Map([
    [0x1e, '\u2661'],
    [0x1f, '\u2665'],
    [0x7f, '\u2014'],
    [0xef40, '\u2014\u2014'],
    [0xef41, '\u266a'],
    [0xef42, '\uff5e'],
    [0xef43, '\u2606'],
    [0xef44, '\u2015'],
  ]);
  const text = replacements.get(value);
  return text === undefined ? {character: 0x20, text: null} : {character: value, text};
}

/** Engine glyph cache and postprocessing, downstream of actual browser font rasterization. */
export class AokanaFontRaster {
  private readonly cache: AokanaGlyph[] = [];
  readonly offsetY: number;
  extra: number;
  extraPixels: number;
  constructor(
    readonly geometry: AokanaFontGeometry,
    readonly face: AokanaBrowserFontFace,
    readonly settings: AokanaFontRasterSettings,
    readonly cacheCapacity: number,
  ) {
    if (cacheCapacity < 2)
      throw new RangeError('Aokana font cache capacity is below native minimum');
    this.extra = geometry.extra;
    this.extraPixels = 0;
    this.setExtra(geometry.extra);
    this.offsetY = geometry.autoFit
      ? Math.max(
          0,
          (face.ascent - divide(Math.imul(Math.abs(geometry.fontHeight), 7), 8)) >>
            settings.sampleShift,
        )
      : geometry.offsetY;
  }
  glyph(character: number): AokanaGlyph {
    character >>>= 0;
    const found = this.cache.findIndex((glyph) => glyph.character === character);
    if (found >= 0) {
      const glyph = this.cache.splice(found, 1)[0]!;
      this.cache.unshift(glyph);
      return glyph;
    }
    const pixels =
      this.cache.length < this.cacheCapacity
        ? new Uint8Array(Math.imul(this.geometry.width, this.geometry.height) >>> 0)
        : this.cache.pop()!.pixels;
    const glyph = this.raster(character, pixels);
    this.cache.unshift(glyph);
    return glyph;
  }
  clear(): void {
    this.cache.length = 0;
  }
  setExtra(value: number): void {
    this.extra = value | 0;
    const scaled = Math.imul(
      fixed(this.geometry.scaleY, this.geometry.size),
      this.settings.sampleScale,
    );
    this.extraPixels = Math.fround(
      snapNearInteger(Math.fround((scaled * (1 / this.settings.sampleScale) * this.extra) / 65536)),
    );
  }
  private raster(original: number, pixels: Uint8Array): AokanaGlyph {
    const geometry = this.geometry;
    const settings = this.settings;
    const put = (offset: number, value: number): void => {
      if (offset < 0 || offset >= pixels.length)
        throw new RangeError('Aokana glyph writes outside native cache allocation');
      pixels[offset] = value;
    };
    let character = original;
    let abc: readonly [number, number, number] = [0, Math.fround(geometry.size), 0];
    if (!settings.textOut) {
      const bits = settings.quality === 0 ? 2 : settings.quality === 1 ? 4 : 6;
      const outline = this.face.outline(character, bits);
      pixels.fill(0);
      if ((outline.width > 1 || outline.height > 1) && outline.width > 0 && outline.height > 0) {
        const top = Math.max(0, (this.face.ascent - this.offsetY - outline.originY) | 0);
        for (let y = 0; y < Math.min(geometry.height, outline.height); y++)
          for (let x = 0; x < Math.min(geometry.width, outline.width); x++)
            put(
              geometry.offsetX + top * geometry.stride + y * geometry.stride + x,
              (outline.bytes[y * outline.stride + x]! * 255) >> bits,
            );
      }
      abc = this.face.abc(character);
    } else {
      const mapped = aokanaGlyphText(character);
      character = mapped.character;
      if (mapped.text !== null) abc = this.face.abc(mapped.text.charCodeAt(0));
      if (mapped.text === null || character === 0x20 || character === 0x3000) pixels.fill(0);
      else {
        const dib = this.face.rasterText(mapped.text, geometry.dibWidth, geometry.dibHeight);
        const read = (x: number, y: number): number => {
          const index = y * dib.stride + x;
          if (index < 0 || index >= dib.bytes.length)
            throw new RangeError('Aokana glyph reads outside native DIB allocation');
          return dib.bytes[index]!;
        };
        const scale = settings.sampleScale;
        if (scale < 2) {
          for (let y = 0; y < geometry.height; y++)
            for (let x = 0; x < geometry.width; x++)
              put(y * geometry.stride + x, read(geometry.offsetX + x, this.offsetY + y));
        } else {
          for (let y = 0; y < geometry.height; y++)
            for (let x = 0; x < geometry.width; x++) {
              let covered = 0;
              for (let dy = 0; dy < scale; dy++)
                for (let dx = 0; dx < scale; dx++)
                  covered += Number(
                    read((geometry.offsetX + x) * scale + dx, (this.offsetY + y) * scale + dy) !==
                      0,
                  );
              put(
                y * geometry.stride + x,
                settings.gamma === 0
                  ? (covered * 255) >> settings.areaShift
                  : Math.trunc(
                      nativeSineFirstQuadrant((covered * (Math.PI / 2)) / (scale * scale)) * 255,
                    ),
              );
            }
        }
      }
    }
    let left = 0;
    let right = divide(geometry.size, 2) - 1;
    let normalized: readonly [number, number, number];
    if (character === 0x20 || character === 0x3000) {
      const sum = Math.fround(Math.fround(abc[1] + abc[0]) + abc[2]);
      right = Math.trunc(snapNearInteger(sum / settings.sampleScale)) - 1;
      normalized = [0, Math.fround(right + 1), 0];
    } else {
      let first = -1;
      let last = -1;
      for (let x = 0; x < geometry.width; x++) {
        for (let y = 0; y < geometry.height; y++)
          if (pixels[y * geometry.stride + x] !== 0) {
            if (first < 0) first = x;
            last = x;
            break;
          }
      }
      if (first >= 0) {
        left = first;
        right = last;
      }
      normalized = [
        Math.fround(snapNearInteger(abc[0] / settings.sampleScale)),
        Math.fround(snapNearInteger(abc[1] / settings.sampleScale)),
        Math.fround(snapNearInteger(abc[2] / settings.sampleScale)),
      ];
    }
    return {
      character: original,
      fullWidth: aokanaWideCharacter(original),
      pixels,
      left,
      top: 0,
      right,
      bottom: geometry.height - 1,
      abc: normalized,
      wideExtent: Number(
        aokanaWideCharacter(character) !== 0 &&
          ((character - 0xff01) >>> 0 < 0x5e ||
            geometry.size >> 1 < this.face.extent(character) >> settings.sampleShift),
      ),
    };
  }
}
