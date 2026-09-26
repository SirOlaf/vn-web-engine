import type {AokanaBpPointer} from '../bp/memory.js';
import {allocateAokanaBitmap, type AokanaBitmap} from './bitmap.js';
import {bitmapWrite8, bitmapWrite16, bitmapWrite32} from './bitmap-scalar.js';
import {AokanaMonochromeFont} from './font-monochrome.js';
import {aokanaWideCharacter} from './font-raster.js';
import {recordAokanaBitmapText} from './bitmap-dom-text.js';
import type {AokanaSurfaces} from './surfaces.js';
import {textByte, textLength} from './text.js';

export interface AokanaMonochromeTextArguments {
  surface: number;
  x: number;
  y: number;
  source: AokanaBpPointer | null;
  registeredFont: number;
  size: number;
  bold: number;
  spacing: number;
  color: number;
}

/**0354F0 expands actual packed cache bytes, preserving native format branches. */
function expandGlyph(
  destination: AokanaBitmap,
  font: AokanaMonochromeFont,
  character: number,
  color: number,
): void {
  const glyph = font.glyph(character),
    width = Math.min(destination.width >>> 0, font.size >>> 0),
    height = Math.min(destination.height >>> 0, font.size >>> 0);
  let packed = glyph.offset;
  for (let y = 0; y < height; y++) {
    let output = destination.offset + y * (destination.stride | 0);
    for (let x = 0; x < width;) {
      const count = Math.min(8, width - x);
      glyph.storage.range(packed, 1, true);
      const bits = glyph.storage.bytes[packed++]!;
      for (let bit = 0; bit < count; bit++, x++) {
        if ((bits & (0x80 >>> bit)) === 0) {
          for (let byte = 0; byte < destination.bytesPerPixel >>> 0; byte++)
            bitmapWrite8(destination, output + byte, 0);
        } else if (destination.format === 0)
          bitmapWrite16(
            destination,
            output,
            ((color >>> 9) & 0x7c00) + ((color >>> 6) & 0x3e0) + ((color >>> 3) & 0x1f),
          );
        else if (destination.format === 1) bitmapWrite32(destination, output, color);
        else if (destination.format === 2) bitmapWrite32(destination, output, color | 0xff000000);
        output += destination.bytesPerPixel >>> 0;
      }
    }
  }
}

/**Separate1D03B4/C0/D0/D8 cache and0351E0 renderer over actual shared surface owners. */
export class AokanaMonochromeSurfaceText {
  private font: AokanaMonochromeFont | null = null;
  private name: Uint8Array | null = null;
  private size = 0;
  private bold = 0;
  constructor(readonly surfaces: AokanaSurfaces) {}

  /**035190 releases only this mono cache, not the ordinary CFontManager records. */
  dispose(): void {
    this.font?.dispose();
    this.font = null;
    this.name = null;
  }

  async draw(
    args: AokanaMonochromeTextArguments,
    actor = this.surfaces.allocator.currentActor,
  ): Promise<{status: number; metric?: number}> {
    const operationAllocator = this.surfaces.allocator,
      operationActor = actor;
    const runAsActor = <T>(operation: () => T): T =>
      operationAllocator.withActor(operationActor, operation);

    const destination = this.surfaces.snapshot(args.surface);
    if (destination === null) return {status: 0x80000004};
    const name = this.surfaces.fonts.name(args.registeredFont);
    if (name === null) return {status: 0x80000003};
    const size = args.size | 0,
      bold = args.bold | 0;
    if (
      this.name === null ||
      this.name.length !== name.length ||
      !this.name.every((value, index) => value === name[index]) ||
      this.size !== size ||
      (this.bold !== 0) !== (bold !== 0) ||
      this.font === null
    ) {
      const candidate = new AokanaMonochromeFont(this.surfaces.fonts);
      const status = await candidate.initialize(name, size, bold);
      if (status !== 0) {
        candidate.dispose();
        return {status: status === 0x80000002 ? 0x80000001 : 0x80000000};
      }
      this.dispose();
      this.font = candidate;
      this.name = name.slice();
      this.size = size;
      this.bold = bold;
    }
    const font = this.font;
    if (font === null) throw new Error('Aokana monochrome font was not initialized');
    return {status: 0, metric: runAsActor(() => this.render(destination, args, font))};
  }

  private render(
    destination: AokanaBitmap,
    args: AokanaMonochromeTextArguments,
    font: AokanaMonochromeFont,
  ): number {
    const size = font.size,
      scratch = allocateAokanaBitmap(size, size, 1);
    let metric = 0;
    try {
      const source = args.source;
      if (source === null) throw new Error('Aokana mono text dereferences a null text pointer');
      const text = this.surfaces.fonts.text,
        mode = text.detectEncoding(source.bytes, source.offset, true),
        prepared = new Uint8Array(textLength(source) + 1);
      let input = source.offset,
        output = 0;
      const append = (value: number): void => {
        if (output >= prepared.length)
          throw new RangeError('Aokana mono preprocessing writes outside allocated string');
        prepared[output++] = value;
      };
      while (textByte(source.bytes, input) !== 0) {
        const first = textByte(source.bytes, input);
        if (first < 0x20) {
          append(first);
          input += first === 3 ? 2 : 1;
        } else {
          const length = text.readCharacter(source.bytes, input, mode).length;
          if (length === 0) throw new Error('Aokana mono text byte walk does not advance');
          for (let byte = 0; byte < length; byte++) append(textByte(source.bytes, input + byte));
          input += length;
        }
      }
      append(0);
      const wide = text.decodeAuto({bytes: prepared, offset: 0}) + '\0';
      let wideAt = 0,
        x = args.x | 0,
        y = args.y | 0,
        percent = 100,
        wrapWidth = 0;
      input = source.offset;
      const lineAdvance = (): void => {
        y = (y + Math.trunc(Math.imul(percent, size) / 100)) | 0;
        x = args.x | 0;
      };
      for (;;) {
        const first = textByte(source.bytes, input);
        if (first === 0) break;
        let character = wide.charCodeAt(wideAt),
          units = 1;
        if (!Number.isFinite(character))
          throw new Error('Aokana mono text reads outside prepared UTF16 storage');
        if (character >= 0xd800 && character < 0xdc00) {
          const second = wide.charCodeAt(wideAt + 1);
          if (!Number.isFinite(second))
            throw new Error('Aokana mono text reads outside prepared surrogate storage');
          if (second >= 0xdc00 && second < 0xe000) {
            character = ((character - 0xd800) << 10) + second - 0xdc00 + 0x10000;
            units = 2;
          }
        }
        if (first < 0x20) {
          if (first === 3) percent = textByte(source.bytes, ++input);
          else if (first === 4) wrapWidth = destination.width >>> 0;
          else if (first === 10) lineAdvance();
        } else {
          expandGlyph(scratch, font, character, args.color);
          recordAokanaBitmapText(scratch, String.fromCodePoint(character), {
            size,
            family: font.cssFamily,
            bold: args.bold !== 0,
            color: args.color,
          });
          const glyph = {...scratch};
          if (aokanaWideCharacter(character) === 0) glyph.width >>>= 1;
          if (wrapWidth !== 0 && wrapWidth < (x + glyph.width) >>> 0) lineAdvance();
          if (this.surfaces.compositor.draw(destination, x, y, glyph, 0, 0) !== 0) break;
          const advance = (glyph.width + args.spacing) | 0;
          x = (x + advance) | 0;
          metric = (metric + advance) | 0;
        }
        const length = text.readCharacter(source.bytes, input, mode).length;
        if (length === 0) throw new Error('Aokana mono text byte walk does not advance');
        input += length;
        wideAt += units;
      }
      return metric;
    } finally {
      scratch.storage!.release();
    }
  }
}
