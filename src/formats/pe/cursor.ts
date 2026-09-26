import {sha256} from '../../core/sha256.js';
import {ascii, checkRange} from '../../core/binary.js';
import {parsePeResources} from './resources.js';
import type {PeResource, PeResourceId} from './resources.js';

export interface PeCursorEntry {
  kind: 'static' | 'ani';
  id: PeResourceId;
  language: number;
}
export interface PeCursorImage {
  resourceId: number;
  language: number;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  bitDepth: number;
  encoding: 'dib' | 'png';
}
export interface PeStaticCursor extends PeCursorEntry {
  kind: 'static';
  /** Complete multi-image .cur file; safe to put in an image/x-icon Blob. */
  bytes: Uint8Array;
  images: PeCursorImage[];
}
export interface PeAnimatedCursor extends PeCursorEntry {
  kind: 'ani';
  /** Original RIFF/ACON bytes. ANI is reported, not converted to a static cursor. */
  bytes: Uint8Array;
}

const MAX_CURSOR_BYTES = 16 * 1024 * 1024;

/** Bounded runtime reader for user-supplied executables; no browser or filesystem dependency. */
export class PeCursorReader {
  private readonly resources: PeResource[];
  private hashes: Promise<Map<string, (PeStaticCursor | PeAnimatedCursor)[]>> | undefined;
  constructor(bytes: Uint8Array) {
    this.resources = parsePeResources(bytes, [1, 12, 21]);
  }

  list(): PeCursorEntry[] {
    return this.resources
      .filter((r) => r.type === 12 || r.type === 21)
      .map((r) => ({kind: r.type === 12 ? 'static' : 'ani', id: r.id, language: r.language}));
  }

  /** SHA-256 of the reconstructed CUR file (or original ANI bytes), excluding
   * PE IDs, language and layout. Includes every image, hotspot and mask.
   * Build once per reader; concurrent searches share the in-memory index. */
  private hashIndex(): Promise<Map<string, (PeStaticCursor | PeAnimatedCursor)[]>> {
    return (this.hashes ??= (async () => {
      const index = new Map<string, (PeStaticCursor | PeAnimatedCursor)[]>();
      for (const entry of this.list()) {
        const cursor = this.read(entry.id, entry.language)!;
        const digest = await sha256(cursor.bytes);
        const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
        const matches = index.get(hash) ?? [];
        matches.push(cursor);
        index.set(hash, matches);
      }
      return index;
    })());
  }

  /** Return every matching group/language, including duplicate copies. */
  async findByHash(sha256: string): Promise<PeCursorEntry[]> {
    const matches = (await this.hashIndexFor(sha256)) ?? [];
    return matches.map(({kind, id, language}) => ({kind, id, language}));
  }

  /** Identical content may have multiple IDs; return the first directory entry.
   * Copy results so callers cannot modify the cached content or its metadata. */
  async readByHash(sha256: string): Promise<PeStaticCursor | PeAnimatedCursor | undefined> {
    const cursor = (await this.hashIndexFor(sha256))?.[0];
    if (!cursor) return undefined;
    return cursor.kind === 'static'
      ? {
          ...cursor,
          bytes: new Uint8Array(cursor.bytes),
          images: cursor.images.map((image) => ({...image})),
        }
      : {...cursor, bytes: new Uint8Array(cursor.bytes)};
  }

  private async hashIndexFor(
    sha256: string,
  ): Promise<(PeStaticCursor | PeAnimatedCursor)[] | undefined> {
    if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error('Expected a 64-digit SHA-256 cursor hash');
    return (await this.hashIndex()).get(sha256.toLowerCase());
  }

  /** Exact language then neutral (0). Without a language: neutral then lowest LANGID.
   * Missing IDs return undefined; unavailable languages and malformed/unsupported data throw.
   * Keep the input bytes unchanged while using this reader. Returned bytes are independent copies.
   */
  read(id: PeResourceId, language?: number): PeStaticCursor | PeAnimatedCursor | undefined {
    if (
      language !== undefined &&
      (!Number.isInteger(language) || language < 0 || language > 0xffff)
    )
      throw new Error('Invalid cursor language');
    const candidates = this.resources.filter(
      (r) => (r.type === 12 || r.type === 21) && r.id === id,
    );
    if (!candidates.length) return undefined;
    const resource =
      candidates.find((r) => r.language === (language ?? 0)) ??
      candidates.find((r) => r.language === 0) ??
      (language === undefined
        ? candidates.reduce((a, b) => (a.language <= b.language ? a : b))
        : undefined);
    if (!resource) throw new Error('Cursor language unavailable');
    if (candidates.filter((r) => r.language === resource.language).length !== 1)
      throw new Error('Ambiguous static/ANI cursor ID');
    if (resource.type === 21) {
      validateAni(resource.bytes);
      return {kind: 'ani', id, language: resource.language, bytes: new Uint8Array(resource.bytes)};
    }
    const group = resource.bytes,
      v = new DataView(group.buffer, group.byteOffset, group.byteLength);
    checkRange(group.length, 0, 6);
    const count = v.getUint16(4, true);
    if (
      v.getUint16(0, true) ||
      v.getUint16(2, true) !== 2 ||
      !count ||
      count > 256 ||
      group.length !== 6 + count * 14
    )
      throw new Error('Invalid cursor group header/count');
    const images: PeCursorImage[] = [],
      payloads: Uint8Array[] = [];
    let length = 6 + count * 16;
    for (let i = 0; i < count; i++) {
      const p = 6 + i * 14,
        resourceId = v.getUint16(p + 12, true);
      const variants = this.resources.filter((r) => r.type === 1 && r.id === resourceId);
      const image =
        variants.find((r) => r.language === resource.language) ??
        variants.find((r) => r.language === 0);
      if (!image)
        throw new Error(`Missing RT_CURSOR ${resourceId} for language ${resource.language}`);
      if (image.bytes.length !== v.getUint32(p + 8, true))
        throw new Error('Cursor resource size mismatch');
      if (image.bytes.length < 4 || length + image.bytes.length - 4 > MAX_CURSOR_BYTES)
        throw new Error('Cursor output exceeds allocation limit');
      const info = inspectImage(image.bytes);
      // Group cursor height describes both the XOR image and AND mask for DIBs.
      if (
        v.getUint16(p, true) !== info.width ||
        v.getUint16(p + 2, true) !== info.height * (info.encoding === 'dib' ? 2 : 1) ||
        v.getUint16(p + 4, true) !== 1 ||
        v.getUint16(p + 6, true) !== info.bitDepth
      )
        throw new Error('Cursor group/image metadata mismatch');
      const payload = image.bytes.subarray(4);
      length += payload.length;
      if (length > MAX_CURSOR_BYTES) throw new Error('Cursor output exceeds allocation limit');
      images.push({resourceId, language: image.language, ...info});
      payloads.push(payload);
    }
    const bytes = new Uint8Array(length),
      out = new DataView(bytes.buffer);
    out.setUint16(2, 2, true);
    out.setUint16(4, count, true);
    let offset = 6 + count * 16;
    for (let i = 0; i < count; i++) {
      const p = 6 + i * 16,
        info = images[i]!,
        payload = payloads[i]!;
      bytes[p] = info.width === 256 ? 0 : info.width;
      bytes[p + 1] = info.height === 256 ? 0 : info.height;
      // Zero means >=256 colors or unspecified; it is also valid for PNG payloads.
      bytes[p + 2] = info.bitDepth < 8 ? 1 << info.bitDepth : 0;
      out.setUint16(p + 4, info.hotspotX, true);
      out.setUint16(p + 6, info.hotspotY, true);
      out.setUint32(p + 8, payload.length, true);
      out.setUint32(p + 12, offset, true);
      bytes.set(payload, offset);
      offset += payload.length;
    }
    return {kind: 'static', id, language: resource.language, bytes, images};
  }
}

function inspectImage(bytes: Uint8Array): Omit<PeCursorImage, 'resourceId' | 'language'> {
  checkRange(bytes.length, 0, 16);
  if (bytes.length > MAX_CURSOR_BYTES) throw new Error('Cursor image exceeds allocation limit');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hotspotX = v.getUint16(0, true),
    hotspotY = v.getUint16(2, true),
    dib = bytes.subarray(4);
  let width: number,
    height: number,
    bitDepth: number,
    encoding: 'dib' | 'png' = 'dib';
  if (dib[0] === 137 && ascii(dib, 1, 7) === 'PNG\r\n\x1a\n') {
    ({width, height, bitDepth} = inspectPng(dib));
    encoding = 'png';
  } else {
    const header = v.getUint32(4, true);
    if (![12, 40, 108, 124].includes(header))
      throw new Error(`Unsupported cursor DIB header ${header}`);
    checkRange(bytes.length, 4, header);
    const core = header === 12;
    width = core ? v.getUint16(8, true) : v.getInt32(8, true);
    const storedHeight = core ? v.getUint16(10, true) : v.getInt32(12, true);
    height = storedHeight / 2;
    const planes = v.getUint16(core ? 12 : 16, true);
    bitDepth = v.getUint16(core ? 14 : 18, true);
    dimensions(width, height);
    if (planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bitDepth))
      throw new Error('Unsupported cursor DIB planes/bit depth');
    if (!core && v.getUint32(20, true) !== 0)
      throw new Error('Unsupported compressed/bitfields cursor DIB');
    const used = core ? 0 : v.getUint32(36, true),
      palette = used || (bitDepth <= 8 ? 1 << bitDepth : 0);
    if (palette > (bitDepth <= 8 ? 1 << bitDepth : 256))
      throw new Error('Invalid cursor DIB palette');
    const xorSize = Math.ceil((width * bitDepth) / 32) * 4 * height;
    const pixelSize = xorSize + Math.ceil(width / 32) * 4 * height;
    const pixelOffset = header + palette * (core ? 3 : 4);
    checkRange(dib.length, pixelOffset, pixelSize);
    if (dib.length !== pixelOffset + pixelSize) throw new Error('Cursor DIB size mismatch');
    // Writers differ on whether biSizeImage includes the AND mask; both forms are valid.
    if (!core && ![0, xorSize, pixelSize].includes(v.getUint32(24, true)))
      throw new Error('Invalid cursor DIB image size');
    if (header === 124 && (v.getUint32(116, true) || v.getUint32(120, true)))
      throw new Error('Unsupported cursor DIB color profile');
  }
  dimensions(width, height);
  if (hotspotX >= width || hotspotY >= height) throw new Error('Cursor hotspot outside image');
  return {width, height, bitDepth, hotspotX, hotspotY, encoding};
}

function dimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 256 ||
    height > 256
  )
    throw new Error('Invalid cursor dimensions');
}

/** Validate the PNG envelope/CRCs; decompression remains the browser's responsibility. */
function inspectPng(bytes: Uint8Array): {width: number; height: number; bitDepth: number} {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8,
    width = 0,
    height = 0,
    bitDepth = 0,
    palette = false,
    data = false,
    dataEnded = false;
  while (p < bytes.length) {
    checkRange(bytes.length, p, 12);
    const length = v.getUint32(p),
      type = ascii(bytes, p + 4, 4);
    checkRange(bytes.length, p + 8, length + 4);
    let crc = 0xffffffff;
    for (let i = p + 4; i < p + 8 + length; i++) {
      crc ^= bytes[i]!;
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== v.getUint32(p + 8 + length))
      throw new Error('Invalid cursor PNG CRC');
    if (p === 8) {
      if (type !== 'IHDR' || length !== 13) throw new Error('Invalid cursor PNG IHDR');
      width = v.getUint32(p + 8);
      height = v.getUint32(p + 12);
      dimensions(width, height);
      const depth = bytes[p + 16]!,
        color = bytes[p + 17]!;
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!depths[color]?.includes(depth) || bytes[p + 18] || bytes[p + 19] || bytes[p + 20]! > 1)
        throw new Error('Unsupported cursor PNG IHDR');
      bitDepth = depth * {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]!;
    } else if (type === 'PLTE') {
      if (palette || data || !length || length % 3 || length > 768)
        throw new Error('Invalid cursor PNG palette');
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (bytes[25] === 3 && !palette))
        throw new Error('Invalid cursor PNG image data');
      data = true;
    } else if (type === 'IEND') {
      if (length || !data || p + 12 !== bytes.length) throw new Error('Invalid cursor PNG end');
      return {width, height, bitDepth};
    } else {
      if (type === 'IHDR' || !(bytes[p + 4]! & 32))
        throw new Error('Unsupported cursor PNG critical chunk');
      if (data) dataEnded = true;
    }
    p += length + 12;
  }
  throw new Error('Missing cursor PNG IEND');
}

function validateAni(bytes: Uint8Array): void {
  checkRange(bytes.length, 0, 12);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length > MAX_CURSOR_BYTES ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'ACON' ||
    v.getUint32(4, true) !== bytes.length - 8
  )
    throw new Error('Invalid ANI RIFF/ACON envelope');
  let p = 12;
  while (p < bytes.length) {
    checkRange(bytes.length, p, 8);
    const size = v.getUint32(p + 4, true);
    checkRange(bytes.length, p + 8, size + (size & 1));
    p += 8 + size + (size & 1);
  }
}
