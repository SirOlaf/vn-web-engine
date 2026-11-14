import type {SfntFontMetadata} from '../formats/sfnt.js';
import type {BrowserLocalFontMetadata} from './browser-local-fonts.js';
import {encodeCp932Exact} from './cp932.js';

/** Windows character sets by the OS/2 code page range bit that declares them. */
const CHARSET_BITS = new Map([
  [0, 0],
  [2, 31],
  [77, 29],
  [128, 17],
  [129, 19],
  [130, 21],
  [134, 18],
  [136, 20],
  [161, 3],
  [162, 4],
  [163, 8],
  [177, 5],
  [178, 6],
  [186, 7],
  [204, 2],
  [222, 16],
  [238, 1],
  [255, 30],
]);

/**
 * Whether EnumFontFamiliesEx lists the face for `charset` (DEFAULT_CHARSET lists every
 * face). Faces are matched by their OS/2 code page ranges; GDI also derives character sets
 * from character coverage, which font metadata does not carry.
 */
export function supportsGdiCharset(data: SfntFontMetadata, charset: number): boolean {
  if (charset === 1) return true;
  const bit = CHARSET_BITS.get(charset);
  return (
    bit !== undefined &&
    data.codePageRanges !== null &&
    ((data.codePageRanges[0] >>> bit) & 1) !== 0
  );
}

/**
 * The family name EnumFontFamiliesEx reports: the face's Japanese family name on Japanese
 * Windows (`japanese`) when it has one, otherwise its English or first Windows family name.
 */
export function gdiFamilyName(data: SfntFontMetadata, fallback: string, japanese: boolean): string {
  const family = data.names.filter((name) => name.id === 1 && name.platform === 3);
  return (
    (japanese ? family.find((name) => name.language === 0x411)?.unicode : undefined) ??
    family.find((name) => name.language === 0x409)?.unicode ??
    family[0]?.unicode ??
    fallback
  );
}

/**
 * Whether the browser draws `family` with an installed face: text in it measures the same
 * over two different generic fallbacks. For hosts without font enumeration.
 */
export function browserDrawsFamily(document: Document, family: string, sample = 'あAa'): boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return false;
  const measure = (generic: string): string => {
    context.font = `32px ${JSON.stringify(family)}, ${generic}`;
    const metrics = context.measureText(sample);
    return `${metrics.width}:${metrics.fontBoundingBoxAscent}:${metrics.fontBoundingBoxDescent}`;
  };
  return measure('monospace') === measure('serif');
}

export interface GdiFontFamily {
  /** The name EnumFontFamiliesEx reports. */
  readonly name: string;
  /** The first face listed under the name. */
  readonly face: BrowserLocalFontMetadata;
}

/** LOGFONTA::lfFaceName holds 31 bytes and a terminator. */
const ANSI_FACE_NAME_BYTES = 31;

/**
 * Families EnumFontFamiliesExA lists for `charset` on Japanese Windows, once each, in face
 * order: names come from `gdiFamilyName` and must fit a LOGFONTA face name in code page 932.
 */
export function enumerateGdiFontFamiliesA(
  faces: readonly BrowserLocalFontMetadata[],
  charset: number,
): GdiFontFamily[] {
  const families = new Map<string, GdiFontFamily>();
  for (const face of faces) {
    if (!supportsGdiCharset(face.data, charset)) continue;
    const name = gdiFamilyName(face.data, face.family, true);
    if (families.has(name)) continue;
    const bytes = encodeCp932Exact(name);
    if (bytes && bytes.length > 0 && bytes.length <= ANSI_FACE_NAME_BYTES)
      families.set(name, {name, face});
  }
  return [...families.values()];
}

/** One EnumFontFamiliesExW callback: a family under one character set. */
export interface GdiEnumeratedFamily {
  /** LOGFONTW::lfFaceName: at most 31 UTF-16 units. A leading `@` names the vertical face
   * GDI adds for the East Asian character sets. */
  readonly name: string;
  /** LOGFONTW::lfCharSet. */
  readonly charset: number;
  /** FIXED_PITCH in LOGFONTW::lfPitchAndFamily. */
  readonly fixedPitch: boolean;
  /** The FontType argument; sfnt faces report TRUETYPE_FONTTYPE (4). */
  readonly fontType: number;
}

/** LOGFONTW::lfFaceName holds 31 UTF-16 units and a terminator. */
const WIDE_FACE_NAME_UNITS = 31;
/** SHIFTJIS, HANGUL, JOHAB, GB2312 and CHINESEBIG5: the sets with `@` vertical faces. */
const VERTICAL_CHARSETS = new Set([128, 129, 130, 134, 136]);

/**
 * EnumFontFamiliesExW with DEFAULT_CHARSET on Japanese Windows (`japanese`) or another
 * locale: every family once per character set it supports, horizontal before vertical, in
 * face order. Names come from `gdiFamilyName`, cut to the LOGFONTW face name size.
 */
export function enumerateGdiFontFamiliesW(
  faces: readonly BrowserLocalFontMetadata[],
  japanese: boolean,
): GdiEnumeratedFamily[] {
  const families = new Map<string, GdiEnumeratedFamily>();
  const add = (name: string, charset: number, fixedPitch: boolean) => {
    const key = `${charset}:${name}`;
    if (!families.has(key)) families.set(key, {name, charset, fixedPitch, fontType: 4});
  };
  for (const face of faces) {
    const name = gdiFamilyName(face.data, face.family, japanese).slice(0, WIDE_FACE_NAME_UNITS);
    if (!name) continue;
    for (const charset of CHARSET_BITS.keys()) {
      if (!supportsGdiCharset(face.data, charset)) continue;
      add(name, charset, face.data.fixedPitch);
      if (VERTICAL_CHARSETS.has(charset))
        add(`@${name}`.slice(0, WIDE_FACE_NAME_UNITS), charset, face.data.fixedPitch);
    }
  }
  return [...families.values()];
}
