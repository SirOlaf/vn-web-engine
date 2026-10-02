import {
  readBrowserLocalFontMetadata,
  type BrowserLocalFontHost,
  type BrowserLocalFontMetadata,
} from '../../../text/browser-local-fonts.js';
import {browserDrawsFamily, enumerateGdiFontFamiliesA} from '../../../text/gdi-font-families.js';

const SHIFTJIS_CHARSET = 0x80;

/**
 * Japanese fixed-pitch families that are commonly installed, for browsers without the
 * Local Font Access API. Only the ones the browser can draw are listed.
 */
const COMMON_FIXED_PITCH = [
  'ＭＳ ゴシック',
  'ＭＳ 明朝',
  'BIZ UDゴシック',
  'BIZ UD明朝 Medium',
  'IPAゴシック',
  'IPA明朝',
  'Noto Sans Mono CJK JP',
  'Source Han Code JP',
];

/**
 * The families the font window offers (0x4572F0 with the 0x457340 filter): those
 * EnumFontFamiliesExA lists for SHIFTJIS_CHARSET whose vertical `@` faces are fixed pitch.
 */
export function rscriptFontCatalog(faces: readonly BrowserLocalFontMetadata[]): string[] {
  return enumerateGdiFontFamiliesA(
    faces.filter((face) => face.data.fixedPitch),
    SHIFTJIS_CHARSET,
  ).map((family) => family.name);
}

/**
 * The font window's catalog. Installed fonts come from the Local Font Access API; without
 * it, or when access is denied, common families the browser can draw are offered.
 */
export async function listRScriptFonts(
  document: Document,
  host: BrowserLocalFontHost = globalThis as BrowserLocalFontHost,
): Promise<string[]> {
  const names = rscriptFontCatalog(await readBrowserLocalFontMetadata(host));
  if (names.length) return names;
  return COMMON_FIXED_PITCH.filter((name) => browserDrawsFamily(document, name));
}
