import {byteDataView, checkRange} from '../../core/binary.js';
import {LwgImage} from '../../formats/rscript/lwg.js';
import {decodePsd} from '../../formats/rscript/psd.js';
import {decodeWcg, type RScriptImage} from '../../formats/rscript/wcg.js';
import type {RScriptFiles} from './files.js';
import {surfaceFromImage, type RScriptSurface} from './graphics/pixels.js';

/**
 * Uncompressed Windows bitmap to native pixels (0x43AF50/0x43B0F0): 1, 8, 24 and 32-bit
 * BI_RGB images, bottom-up or top-down. Colour images are opaque; `mask` stores the
 * blue channel in the transparency byte like the `.msk` loader (0x43AD20).
 */
export function decodeBmp(bytes: Uint8Array, mask = false): RScriptImage {
  const view = byteDataView(bytes);
  if (bytes.length < 54 || view.getUint16(0, true) !== 0x4d42) throw new Error('Not a BMP image');
  const dataOffset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bits = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (headerSize !== 40 || view.getUint16(26, true) !== 1 || compression !== 0)
    throw new Error('Unsupported BMP header');
  if (![1, 8, 24, 32].includes(bits)) throw new Error(`Unsupported BMP depth ${bits}`);
  const height = Math.abs(rawHeight);
  if (width < 1 || height < 1) throw new Error('Invalid BMP dimensions');
  const stride = Math.ceil((width * bits) / 32) * 4;
  checkRange(bytes.length, dataOffset, stride * height);
  let palette: Uint32Array | null = null;
  if (bits <= 8) {
    const colors = view.getUint32(46, true) || 1 << bits;
    checkRange(bytes.length, 14 + headerSize, colors * 4);
    palette = new Uint32Array(colors);
    for (let i = 0; i < colors; i++)
      palette[i] = view.getUint32(14 + headerSize + i * 4, true) & 0xffffff;
  }
  const pixels = new Uint8Array(width * height * 4);
  const out = new Uint32Array(pixels.buffer);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + stride * (rawHeight > 0 ? height - 1 - y : y);
    for (let x = 0; x < width; x++) {
      let color: number;
      if (bits === 24)
        color =
          bytes[row + x * 3]! | (bytes[row + x * 3 + 1]! << 8) | (bytes[row + x * 3 + 2]! << 16);
      else if (bits === 32) color = view.getUint32(row + x * 4, true) & 0xffffff;
      else {
        const index = bits === 8 ? bytes[row + x]! : (bytes[row + (x >> 3)]! >> (7 - (x & 7))) & 1;
        color = palette![index] ?? 0;
      }
      out[y * width + x] = mask ? ((color & 0xff) << 24) >>> 0 : color;
    }
  }
  return {width, height, pixels};
}

const IMAGE_EXTENSIONS = ['.wcg', '.lim', '.bmp', '.tga', '.psd'] as const;

interface CacheEntry {
  surface: Promise<RScriptSurface | null>;
  bytes: number;
}

/**
 * Resource images with the native search order (0x435780: WCG, LIM, BMP, TGA, PSD).
 * Decoded surfaces are shared read-only; callers copy before modifying pixels.
 */
export class RScriptImages {
  private readonly cache = new Map<string, CacheEntry>();
  private cachedBytes = 0;
  private readonly lwgs = new Map<string, Promise<LwgImage | null>>();

  constructor(
    private readonly files: RScriptFiles,
    private readonly cacheLimit = 256 * 1024 * 1024,
  ) {}

  /** Loads `path` (without extension) using the first matching image format. */
  image(path: string): Promise<RScriptSurface | null> {
    return this.cached(`image:${path.toUpperCase()}`, async () => {
      for (const extension of IMAGE_EXTENSIONS) {
        const bytes = await this.files.read(path + extension);
        if (!bytes) continue;
        if (extension === '.wcg') return surfaceFromImage(decodeWcg(bytes));
        if (extension === '.bmp') return surfaceFromImage(decodeBmp(bytes));
        if (extension === '.psd') return surfaceFromImage(decodePsd(bytes));
        throw new Error(`${path}${extension}: this image format is not supported yet`);
      }
      return null;
    });
  }

  /** `.msk` transition masks: bitmap blue channel in the transparency byte. */
  mask(path: string): Promise<RScriptSurface | null> {
    return this.cached(`mask:${path.toUpperCase()}`, async () => {
      const bytes = await this.files.read(`${path}.msk`);
      return bytes ? surfaceFromImage(decodeBmp(bytes, true)) : null;
    });
  }

  lwg(path: string): Promise<LwgImage | null> {
    const key = path.toUpperCase();
    let image = this.lwgs.get(key);
    if (!image) {
      image = this.files
        .open(`${path}.lwg`)
        .then((source) => (source ? LwgImage.open(source) : null));
      image.catch(() => this.lwgs.delete(key));
      this.lwgs.set(key, image);
    }
    return image;
  }

  /** Decodes one LWG layer; the result is cached under the LWG path and layer name. */
  lwgLayer(path: string, name: string): Promise<RScriptSurface | null> {
    return this.cached(`lwg:${path.toUpperCase()}:${name}`, async () => {
      const lwg = await this.lwg(path);
      const entry = lwg?.find(name);
      if (!lwg || !entry) return null;
      // Layer-set markers carry no image.
      if (!entry.size) return null;
      return surfaceFromImage(decodeWcg(await lwg.read(entry)));
    });
  }

  /** Decodes the LWG layer at `index`, as frame animations address their frames. */
  lwgFrame(path: string, index: number): Promise<RScriptSurface | null> {
    return this.cached(`lwg:${path.toUpperCase()}#${index}`, async () => {
      const lwg = await this.lwg(path);
      const entry = lwg?.entries[index];
      if (!lwg || !entry) return null;
      if (!entry.size) return null;
      return surfaceFromImage(decodeWcg(await lwg.read(entry)));
    });
  }

  private cached(
    key: string,
    load: () => Promise<RScriptSurface | null>,
  ): Promise<RScriptSurface | null> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.surface;
    }
    const entry: CacheEntry = {surface: load(), bytes: 0};
    this.cache.set(key, entry);
    entry.surface.then(
      (surface) => {
        entry.bytes = surface ? surface.data.byteLength : 0;
        this.cachedBytes += entry.bytes;
        this.trim();
      },
      () => this.cache.delete(key),
    );
    return entry.surface;
  }

  private trim(): void {
    for (const [key, entry] of this.cache) {
      if (this.cachedBytes <= this.cacheLimit) break;
      this.cache.delete(key);
      this.cachedBytes -= entry.bytes;
    }
  }
}
