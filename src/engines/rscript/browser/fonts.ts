import {
  readBrowserLocalFontMetadata,
  type BrowserLocalFontHost,
  type BrowserLocalFontMetadata,
} from '../../../text/browser-local-fonts.js';
import {
  browserDrawsFamily,
  gdiFamilyName,
  supportsGdiCharset,
} from '../../../text/gdi-font-families.js';
import {encodeCp932} from '../text.js';

const SHIFTJIS_CHARSET = 0x80;
/** LOGFONTA::lfFaceName holds 31 bytes and a terminator. */
const FACE_NAME_BYTES = 31;

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
 * The font window's catalog (0x4572F0 with the 0x457340 filter) from installed faces:
 * families EnumFontFamiliesExA lists for SHIFTJIS_CHARSET on Japanese Windows whose
 * vertical `@` faces are fixed pitch, once each. Names must fit a LOGFONTA face name.
 */
export function rscriptFontCatalog(faces: readonly BrowserLocalFontMetadata[]): string[] {
  const names = new Set<string>();
  for (const face of faces) {
    const {data} = face;
    if (!data.fixedPitch || !supportsGdiCharset(data, SHIFTJIS_CHARSET)) continue;
    const name = gdiFamilyName(data, face.family, true);
    const bytes = encodeCp932(name);
    if (bytes && bytes.length > 0 && bytes.length <= FACE_NAME_BYTES) names.add(name);
  }
  return [...names];
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
