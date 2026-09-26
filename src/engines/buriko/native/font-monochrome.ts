import {BurikoBitmapStorage} from './bitmap.js';
import type {BurikoFontFace} from './font-browser.js';
import type {BurikoNativeFonts} from './fonts.js';
import {burikoWideCharacter} from './font-raster.js';

export interface BurikoMonochromeGlyph {
  readonly character: number | undefined;
  readonly wide: number | undefined;
  readonly storage: BurikoBitmapStorage;
  readonly offset: number;
  readonly bounds: readonly [number, number, number, number] | undefined;
  /** Native +20/+28 are copied by MOVUPS, not consumed by0354F0. */
  readonly trailing: readonly [unknown, unknown];
}
interface CacheRecord {
  character: number | undefined;
  wide: number | undefined;
  offset: number;
  bounds: readonly [number, number, number, number] | undefined;
  trailing: readonly [unknown, unknown];
  next: CacheRecord | undefined;
}

/** 06CCB0..06C450: the separate512-glyph packed mono owner, not CFont's raster cache. */
export class BurikoMonochromeFont {
  private active = false;
  private sizeValue: number | undefined;
  private packed = new BurikoBitmapStorage(new Uint8Array(1), false);
  private rowBytes: number | undefined;
  private records: CacheRecord[] = [];
  private used = 0;
  private head: CacheRecord | undefined;
  private fixedCount: number | undefined;
  private readonly fixedRecords: BurikoMonochromeGlyph[] = [];
  private face: BurikoFontFace | undefined;
  private dib: BurikoBitmapStorage | undefined;
  private dibStride: number | undefined;

  constructor(readonly fonts: BurikoNativeFonts) {}

  async initialize(
    name: Uint8Array,
    size: number,
    bold: number,
  ): Promise<0 | 0x80000002 | 0x80000004> {
    this.releaseFace();
    size |= 0;
    if ((size - 8) >>> 0 >= 0xc1) return 0x80000002;
    this.rowBytes = (size + 7) >> 3;
    const blockSize = this.rowBytes * size;
    this.packed.release();
    this.packed = new BurikoBitmapStorage(new Uint8Array(blockSize * 512), false);
    this.records = Array.from({length: 512}, (_, index) => ({
      character: undefined,
      wide: undefined,
      offset: index * blockSize,
      bounds: undefined,
      trailing: [undefined, undefined] as const,
      next: undefined,
    }));
    this.used = 0;
    //06CA00 does not reset the head pointer or initialize record links/trailing fields.
    const charset = await this.fonts.charset(name);
    try {
      this.face = await this.fonts.browser.create({
        face: this.fonts.text.decodeCp932(name),
        height: size,
        width: Math.trunc(size / 2),
        weight: bold === 0 ? 400 : 700,
        italic: false,
        charset,
        pitchAndFamily: 1,
      });
    } catch {
      return 0x80000004;
    }
    this.sizeValue = size;
    this.dibStride = ((size + 31) & ~31) >>> 3;
    this.dib = new BurikoBitmapStorage(new Uint8Array(this.dibStride * size), false);
    this.fixedCount = 0;
    this.active = true;
    return 0;
  }

  get size(): number {
    if (this.sizeValue === undefined) throw new Error('Buriko mono font reads unwritten size');
    return this.sizeValue;
  }

  get cssFamily(): string | undefined {
    return this.face?.cssFamily;
  }

  private releaseFace(): void {
    if (!this.active) return;
    this.face = undefined;
    this.dib?.release();
    this.dib = undefined;
    this.active = false;
  }

  dispose(): void {
    this.releaseFace();
    this.packed.release();
  }

  glyph(character: number): BurikoMonochromeGlyph {
    character >>>= 0;
    if (this.fixedCount === undefined)
      throw new Error('Buriko mono font reads unwritten fixed-cache count');
    for (let index = 0; index < this.fixedCount; index++) {
      const record = this.fixedRecords[index];
      if (record === undefined)
        throw new Error('Buriko mono font dereferences an unwritten fixed record');
      if (record.character === character) return {...record};
    }
    let cursor = this.head,
      previous: CacheRecord | null = null,
      selected: CacheRecord | undefined;
    for (let index = 0; index < this.used; index++) {
      if (cursor === undefined)
        throw new Error('Buriko mono font dereferences an unwritten cache link');
      const next = cursor.next;
      if (cursor.character === character) {
        if (previous === null) this.head = next;
        else previous.next = next;
        selected = cursor;
        break;
      }
      previous = cursor;
      cursor = next;
    }
    if (selected === undefined) {
      selected = this.used < 512 ? this.records[this.used++] : (previous ?? undefined);
      if (selected === undefined)
        throw new Error('Buriko mono font dereferences an unwritten cache record');
      selected.character = character;
      selected.wide = burikoWideCharacter(character);
      selected.bounds = this.raster(selected.offset, character);
    }
    selected.next = this.head;
    this.head = selected;
    return {
      character: selected.character,
      wide: selected.wide,
      storage: this.packed,
      offset: selected.offset,
      bounds: selected.bounds,
      trailing: [...selected.trailing],
    };
  }

  private raster(offset: number, character: number): readonly [number, number, number, number] {
    const size = this.size,
      rowBytes = this.rowBytes,
      stride = this.dibStride,
      dib = this.dib;
    if (
      rowBytes === undefined ||
      stride === undefined ||
      dib === undefined ||
      this.face === undefined
    )
      throw new Error('Buriko mono font consumes unwritten raster state');
    let text: string | undefined;
    if ((character - 0x20) >>> 0 < 0xd7e0 || (character >= 0xf900 && character < 0x10000))
      text = String.fromCharCode(character);
    else if (character > 0xffff)
      text = String.fromCharCode(
        (((character - 0x10000) >>> 10) + 0xd800) & 0xffff,
        (character & 0x3ff) + 0xdc00,
      );
    else if (character === 0xef40) text = '\u2014\u2014';
    else if (character === 0x1e) text = '\u2661';
    else if (character === 0x1f) text = '\u2665';
    else if (character === 0x7f) text = '\u2014';
    else if (character === 0xef41) text = '\u266a';
    else if (character === 0xef42) text = '\uff5e';
    else if (character === 0xef43) text = '\u2606';
    if (text !== undefined) {
      dib.bytes.fill(0);
      dib.written(0, dib.bytes.length);
      const raster = this.face.rasterMonochrome(text, stride * 8, size);
      for (let y = 0; y < size; y++) {
        const input = y * raster.stride;
        if (input + stride > raster.bytes.length)
          throw new RangeError('Buriko mono font platform DIB is truncated');
        dib.bytes.set(raster.bytes.subarray(input, input + stride), y * stride);
      }
    }
    for (let y = 0; y < size; y++) {
      const input = y * stride,
        output = offset + y * rowBytes;
      // Raw native copies propagate unknown bytes; bounds scanning below consumes them.
      const initialized = dib.initializedRange(input, rowBytes);
      this.packed.range(output, rowBytes, false);
      this.packed.bytes.set(dib.bytes.subarray(input, input + rowBytes), output);
      for (let x = 0; x < rowBytes; x++)
        if (initialized[x] !== 0) this.packed.written(output + x, 1);
    }
    let left = size - 1,
      right = 0;
    for (let y = 0; y < size; y++) {
      dib.range(y * stride, rowBytes, true);
      for (let byte = 0; byte < rowBytes; byte++)
        for (let bit = 0; bit < 8; bit++)
          if ((dib.bytes[y * stride + byte]! & (0x80 >>> bit)) !== 0) {
            const x = byte * 8 + bit;
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
    }
    const margin = Math.max(1, Math.trunc(size / 8));
    return [Math.max(0, left - margin), 0, Math.min(size - 1, right + margin), size - 1];
  }
}
