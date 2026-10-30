import {decodePng} from '../../formats/png/decode.js';
import {
  artemisRftEntry,
  artemisRftSettingsEntry,
  artemisRftVersion,
  type ArtemisRftEntry,
} from '../../formats/artemis/rft.js';
import type {ArtemisFileFontMetrics, ArtemisFileGlyph} from './file-fonts.js';
import {ArtemisIni, artemisAtoi} from './ini.js';

/** Reads a rendered font file; null when it does not exist. */
export type ArtemisRenderedFontRead = (path: string) => Promise<Uint8Array | null>;

/** One opened `.rft` file of CRenderedFont (open 0x14018a160, glyph 0x14018a700).
 *
 * Open builds `<face>_<size>.rft` from the revision's size argument; the file layer also tries that name
 * with a second `.rft`. Code 0's entry (the `rft3` settings) supplies `[FONT]`
 * STRIKEOUT_SIZE, STRIKEOUT_POSITION, UNDERSCORE_SIZE, UNDERSCORE_POSITION and COLOR_32;
 * without it, code 0x41's entry opens the font with zero metrics and the `rft2` 32-bit mark.
 * Bold and italic do not apply. A 32-bit glyph (Rev.2601 0x543c80, Rev.2762 0x544440)
 * reports 4 bytes per pixel; its RGBA image is kept as the glyph color and its alpha as
 * coverage. Revisions without that verified path refuse 32-bit glyphs.
 *
 * A glyph is its entry's image placed at the line top, advancing by its width. A code the
 * index does not hold is an empty space advancing by (size+1)/2 for U+0020 and by the size
 * for U+3000; any other such code, and an empty entry, fail (empty, zero-advance
 * characters in the renderer).
 */
export class ArtemisRenderedFont {
  private constructor(
    readonly name: string,
    private readonly bytes: Uint8Array,
    private readonly unicodeRanges: boolean,
    readonly metrics: ArtemisFileFontMetrics,
    readonly color32: boolean,
    private readonly colorGlyphs: boolean,
  ) {}
  /** `charsets` is the process-wide CHARSET choice per file name (map 0x140485a38): the
   * settings of a name are read once. */
  static async open(
    read: ArtemisRenderedFontRead,
    charsets: Map<string, boolean>,
    face: string,
    size: number,
    sizeBits: 8 | 32 = 8,
    colorGlyphs = false,
  ): Promise<ArtemisRenderedFont | null> {
    const nativeSize = sizeBits === 8 ? size & 255 : size | 0;
    const name = `${face}_${nativeSize}.rft`;
    const bytes = (await read(name)) ?? (await read(name + '.rft'));
    if (!bytes || artemisRftVersion(bytes) === undefined) return null;
    const version = artemisRftVersion(bytes)!;
    let unicodeRanges = false;
    if (version === 3) {
      if (!charsets.has(name)) {
        const charset = settings(bytes, artemisRftSettingsEntry(bytes)).get('FONT', 'CHARSET');
        charsets.set(name, new TextDecoder().decode(charset) === 'UTF-8');
      }
      unicodeRanges = charsets.get(name)!;
    }
    const metrics = (values: readonly number[]): ArtemisFileFontMetrics =>
      Object.freeze({
        size: nativeSize,
        baseline: 0,
        decorationThickness: values[0]!,
        strikeoutPosition: values[1]!,
        underlineThickness: values[2]!,
        underlinePosition: values[3]!,
      });
    const header = artemisRftEntry(bytes, 0, unicodeRanges);
    if (header) {
      const ini = settings(bytes, header);
      const value = (key: string) => artemisAtoi(ini.get('FONT', key));
      return new ArtemisRenderedFont(
        name,
        bytes,
        unicodeRanges,
        metrics(
          ['STRIKEOUT_SIZE', 'STRIKEOUT_POSITION', 'UNDERSCORE_SIZE', 'UNDERSCORE_POSITION'].map(
            value,
          ),
        ),
        value('COLOR_32') !== 0,
        colorGlyphs,
      );
    }
    if (!artemisRftEntry(bytes, 0x41, unicodeRanges)) return null;
    return new ArtemisRenderedFont(
      name,
      bytes,
      unicodeRanges,
      metrics([0, 0, 0, 0]),
      version === 2,
      colorGlyphs,
    );
  }
  /** The glyph of `code`, or null when the native glyph call fails. */
  async glyph(code: number): Promise<ArtemisFileGlyph | null> {
    const entry = artemisRftEntry(this.bytes, code, this.unicodeRanges);
    if (!entry) {
      const advance =
        code === 0x20 ? (this.metrics.size + 1) >> 1 : code === 0x3000 ? this.metrics.size : -1;
      if (advance < 0) return null;
      return {width: 0, height: 0, left: 0, top: 0, advance, pixels: new Uint8Array()};
    }
    if (!entry.size) return null;
    const data = this.bytes.subarray(entry.offset, entry.offset + entry.size);
    if (![137, 80, 78, 71].every((byte, index) => data[index] === byte))
      throw new Error('Unsupported Artemis rendered glyph image');
    if (this.color32 && !this.colorGlyphs)
      throw new Error('Unsupported Artemis 32-bit rendered glyphs');
    const image = await decodePng(data);
    if (this.color32) {
      // The 32-bit surface rows are read as 4-byte pixels; only 8-bit RGBA images are that.
      if (image.colorType !== 6 || image.bitDepth !== 8)
        throw new Error('Unsupported Artemis 32-bit rendered glyph pixel format');
      const color = Uint8Array.from(image.pixels.subarray(0, image.width * image.height * 4));
      const pixels = new Uint8Array(image.width * image.height);
      for (let index = 0; index < pixels.length; index++) pixels[index] = color[index * 4 + 3]!;
      return {
        width: image.width,
        height: image.height,
        left: 0,
        top: 0,
        advance: image.width,
        pixels,
        color,
      };
    }
    if (image.colorType !== 0 || image.bitDepth !== 8)
      throw new Error('Unsupported Artemis rendered glyph pixel format');
    const pixels = new Uint8Array(image.width * image.height);
    for (let index = 0; index < pixels.length; index++) pixels[index] = image.pixels[index * 4]!;
    return {
      width: image.width,
      height: image.height,
      left: 0,
      top: 0,
      advance: image.width,
      pixels,
    };
  }
}

/** An entry's INI text, ending at the entry end. Both revisions parse the open-time buffer
 * without a terminator (Rev.3139 0x1401885d0 allocates it raw, Rev.3179 zero-fills exactly
 * the entry bytes), so text without a NUL natively runs on into unrelated heap bytes. */
function settings(bytes: Uint8Array, entry: ArtemisRftEntry): ArtemisIni {
  return ArtemisIni.parse(bytes.subarray(entry.offset, entry.offset + entry.size));
}
