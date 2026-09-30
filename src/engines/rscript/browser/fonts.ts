import type {SfntFontMetadata} from '../../../formats/sfnt.js';
import {
  readBrowserLocalFontMetadata,
  type BrowserLocalFontHost,
  type BrowserLocalFontMetadata,
} from '../../../text/browser-local-fonts.js';
import {encodeCp932} from '../text.js';

/** SHIFTJIS_CHARSET is bit 17 of the OS/2 code page ranges. */
const SHIFT_JIS_CODE_PAGE = 1 << 17;
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
 * The GDI family name as EnumFontFamiliesExA reports it on Japanese Windows: the Japanese
 * family name when the font has one.
 */
function familyName(data: SfntFontMetadata, fallback: string): string {
  const family = data.names.filter((name) => name.id === 1 && name.platform === 3);
  return (
    family.find((name) => name.language === 0x411)?.unicode ??
    family.find((name) => name.language === 0x409)?.unicode ??
    family[0]?.unicode ??
    fallback
  );
}

/**
 * The font window's catalog (0x4572F0 with the 0x457340 filter) from installed faces:
 * families with a Shift-JIS code page and fixed pitch, whose vertical `@` faces GDI
 * enumerates, once each. Names must fit a LOGFONTA face name.
 */
export function rscriptFontCatalog(faces: readonly BrowserLocalFontMetadata[]): string[] {
  const names = new Set<string>();
  for (const face of faces) {
    const {data} = face;
    if (!data.fixedPitch || !data.codePageRanges) continue;
    if ((data.codePageRanges[0] & SHIFT_JIS_CODE_PAGE) === 0) continue;
    const name = familyName(data, face.family);
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
  return COMMON_FIXED_PITCH.filter((name) => drawable(document, name));
}

/** Whether text in `name` measures the same over two different generic fallbacks. */
function drawable(document: Document, name: string): boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return false;
  const measure = (generic: string): string => {
    context.font = `32px ${JSON.stringify(name)}, ${generic}`;
    const metrics = context.measureText('あぃウェ５＃―壱弐鶴亀ＡｂAb');
    return `${metrics.width}:${metrics.fontBoundingBoxAscent}:${metrics.fontBoundingBoxDescent}`;
  };
  return measure('monospace') === measure('serif');
}
