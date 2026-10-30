import {decodePng} from '../../formats/png/decode.js';
import type {TriangleImage} from '../../graphics/triangle-draw.js';
import {artemisPngDecodeOptions} from './png-surface.js';
import {artemisRevision, type ArtemisRevision} from './revision.js';
type CacheLayout = NonNullable<ArtemisRevision['fontCacheKey']>;
import type {ArtemisFileGlyph} from './file-fonts.js';
import type {ArtemisGlyphSurface} from './glyph-paint.js';

export interface ArtemisFontCacheKey {
  readonly face: string;
  readonly size: number;
  readonly shadow: number;
  readonly outline: number;
  readonly color: number;
  readonly shadowColor: number;
  readonly outlineColor: number;
  readonly style: number;
  readonly codePoint: number;
}
interface Entry {
  readonly atlas: TriangleImage | undefined;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly glyphLeft: number;
  readonly glyphTop: number;
  readonly advance: number;
}
const key = (v: ArtemisFontCacheKey, layout: CacheLayout) => {
  if (layout === 'packed') {
    // Rev.2601 0x525720 stores byte size and bold/italic/underline/strike flags.
    // 0x525830 uses shadow/outline bits 4/5 and this ushort above char16.
    const style =
      (v.style & 3) | ((v.style & 24) >> 1) | (v.shadow ? 16 : 0) | (v.outline ? 32 : 0);
    const packed = ((style << 24) | ((v.size & 255) << 16) | (v.codePoint & 65535)) >>> 0;
    return JSON.stringify([
      v.face,
      v.color >>> 0,
      v.shadowColor >>> 0,
      v.outlineColor >>> 0,
      packed,
    ]);
  }
  if (layout === 'expanded-metrics')
    return JSON.stringify([
      v.face,
      v.size >>> 0,
      v.shadow >>> 0,
      v.outline >>> 0,
      v.color >>> 0,
      v.shadowColor >>> 0,
      v.outlineColor >>> 0,
      v.style >>> 0,
      v.codePoint >>> 0,
    ]);
  return JSON.stringify([
    v.face,
    v.size >>> 0,
    v.shadow >>> 0,
    v.outline >>> 0,
    v.color >>> 0,
    v.shadowColor >>> 0,
    v.outlineColor >>> 0,
    (((v.style & 255) << 16) | (v.codePoint & 65535)) >>> 0,
  ]);
};

/** Global painted-glyph cache: Rev.2601 402c40, Rev.2898 4a6280 / 4a8cd0.
 * Exact revision selects packed or expanded keys. Atlas storage is shared
 * by index entries; cropped glyph storage is allocated only when a renderer uses it.
 */
export class ArtemisRestoredFontCache {
  private readonly entries = new Map<string, Entry>();
  private hits = 0;
  private closed = false;
  private readonly layout: CacheLayout;
  constructor(
    hash: string,
    private readonly read: (path: string) => Promise<Uint8Array | null>,
  ) {
    const layout = artemisRevision(hash).fontCacheKey;
    if (layout === null) throw Error('Unsupported Artemis font cache layout');
    this.layout = layout;
  }
  async restore(path: string): Promise<void> {
    this.assertOpen();
    path = path.split('\0', 1)[0]!;
    const atlases: TriangleImage[] = [];
    // Native tries successive numbered PNGs, stopping at the first open failure.
    for (let index = 0; ; index++) {
      const bytes = await this.read(path + index + '.png');
      this.assertOpen();
      if (bytes === null) break;
      const image = await decodePng(bytes, artemisPngDecodeOptions);
      this.assertOpen();
      if (image.colorType === 0) throw Error('Unsupported gray Artemis font atlas');
      atlases.push(image);
    }
    const bytes = await this.read(path + 'index.dat');
    this.assertOpen();
    if (bytes === null) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const take = (length: number) => {
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length)
        throw Error('Truncated Artemis font cache index');
      const at = offset;
      offset += length;
      return at;
    };
    const u32 = () => view.getUint32(take(4), true);
    const f32 = () => view.getFloat32(take(4), true);
    const count = u32();
    if (
      count >
      Math.floor(
        (bytes.length - offset) /
          (this.layout === 'packed' ? 40 : this.layout === 'expanded' ? 52 : 68),
      )
    )
      throw Error('Truncated Artemis font cache records');
    const pending = new Map<string, Entry>();
    for (let index = 0; index < count; index++) {
      const length = u32();
      const face = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
        bytes.subarray(take(length), offset),
      );
      const identity: (string | number)[] = [face];
      if (this.layout !== 'packed') identity.push(u32(), u32(), u32());
      identity.push(u32(), u32(), u32(), u32());
      if (this.layout === 'expanded-metrics') identity.push(u32());
      const atlas = atlases[u32()];
      const glyphLeft = this.layout === 'expanded-metrics' ? f32() : 0,
        glyphTop = this.layout === 'expanded-metrics' ? f32() : 0,
        nativeAdvance = this.layout === 'expanded-metrics' ? f32() : null;
      const left = f32(),
        top = f32(),
        right = f32(),
        bottom = f32();
      const width = right - left + 1,
        height = bottom - top + 1;
      if (
        ![left, top, width, height].every(Number.isInteger) ||
        left < 0 ||
        top < 0 ||
        width < 0 ||
        height < 0
      )
        throw Error('Unsupported Artemis font cache clip');
      if (![glyphLeft, glyphTop, nativeAdvance ?? width].every(Number.isFinite))
        throw Error('Invalid Artemis font cache metrics');
      if (atlas && (left + width > atlas.width || top + height > atlas.height))
        throw Error('Artemis font cache clip outside atlas');
      pending.set(JSON.stringify(identity), {
        atlas,
        left,
        top,
        width,
        height,
        glyphLeft,
        glyphTop,
        advance: nativeAdvance ?? width,
      });
    }
    // Native does not require EOF after the declared records. Existing keys are replaced;
    // other cached glyphs survive another restore and scenario reset.
    for (const [name, entry] of pending) this.entries.set(name, entry);
  }
  get(value: ArtemisFontCacheKey): ArtemisGlyphSurface | undefined {
    this.assertOpen();
    const entry = this.entries.get(key(value, this.layout));
    if (!entry) return undefined;
    this.hits++;
    const {atlas, left, top, width, height, glyphLeft, glyphTop, advance} = entry;
    if (!atlas)
      return this.layout === 'expanded-metrics'
        ? {image: null, left: glyphLeft, top: glyphTop, advance}
        : {image: null, left: 0, top: 0, advance: 0};
    const pixels = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      const start = ((top + row) * atlas.width + left) * 4;
      pixels.set(atlas.pixels.subarray(start, start + width * 4), row * width * 4);
    }
    return {image: {width, height, pixels}, left: glyphLeft, top: glyphTop, advance};
  }
  has(value: ArtemisFontCacheKey): boolean {
    this.assertOpen();
    return this.entries.has(key(value, this.layout));
  }
  statistics(): {entries: number; atlasBytes: number; hits: number} {
    const atlases = new Set([...this.entries.values()].map((v) => v.atlas));
    return {
      entries: this.entries.size,
      atlasBytes: [...atlases].reduce((n, v) => n + (v?.pixels.byteLength ?? 0), 0),
      hits: this.hits,
    };
  }
  close(): void {
    this.closed = true;
    this.entries.clear();
  }
  private assertOpen(): void {
    if (this.closed) throw Error('Artemis font cache closed');
  }
}

/** 2898 FreeType provider 5d75c0: clamp negative bearings and place the bitmap in
 * an advance-wide, byte-size-high cell, expanding the cell for a protruding bitmap.
 */
export function artemisClippedCellGlyph(glyph: ArtemisFileGlyph, size: number): ArtemisFileGlyph {
  const left = Math.max(0, glyph.left),
    top = Math.max(0, glyph.top);
  const width = Math.max(glyph.advance, left + glyph.width);
  const height = Math.max(size, top + glyph.height);
  if (
    ![left, top, width, height].every(Number.isInteger) ||
    width < 0 ||
    height < 0 ||
    width > 4096 ||
    height > 4096 ||
    glyph.pixels.length !== glyph.width * glyph.height
  )
    throw Error('Unsupported Artemis font cell');
  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < glyph.height; row++)
    pixels.set(
      glyph.pixels.subarray(row * glyph.width, (row + 1) * glyph.width),
      (top + row) * width + left,
    );
  return {width, height, left: 0, top: 0, advance: width, pixels};
}
