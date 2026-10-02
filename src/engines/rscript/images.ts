import {decodeBmp} from '../../formats/bmp.js';
import {LwgImage} from '../../formats/rscript/lwg.js';
import {decodePsd} from '../../formats/rscript/psd.js';
import {decodeWcg, type RScriptImage} from '../../formats/rscript/wcg.js';
import type {RScriptFiles} from './files.js';
import {surfaceFromImage, type RScriptSurface} from './graphics/pixels.js';

/**
 * Uncompressed Windows bitmap to native pixels (0x43AF50/0x43B0F0): 1, 8, 24 and 32-bit
 * BI_RGB images with a BITMAPINFOHEADER. Colour images are opaque; `mask` stores the
 * blue channel in the transparency byte like the `.msk` loader (0x43AD20).
 */
export function decodeRScriptBmp(bytes: Uint8Array, mask = false): RScriptImage {
  const bitmap = decodeBmp(bytes);
  if (bitmap.header.size !== 40) throw new Error('Unsupported BMP header');
  if (bitmap.header.bitDepth === 4) throw new Error('Unsupported BMP depth 4');
  const {width, height, colors} = bitmap;
  const pixels = new Uint8Array(width * height * 4);
  const out = new Uint32Array(pixels.buffer);
  if (mask) for (let i = 0; i < colors.length; i++) out[i] = ((colors[i]! & 0xff) << 24) >>> 0;
  else out.set(colors);
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
        if (extension === '.bmp') return surfaceFromImage(decodeRScriptBmp(bytes));
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
      return bytes ? surfaceFromImage(decodeRScriptBmp(bytes, true)) : null;
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
