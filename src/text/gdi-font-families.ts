import type {SfntFontMetadata} from '../formats/sfnt.js';

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
