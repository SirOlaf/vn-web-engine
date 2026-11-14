import type {TriangleImage} from '../../graphics/triangle-draw.js';
import {decodePng, type DecodedPng} from '../../formats/png/decode.js';
import {decodeArtemisPsd} from '../../formats/artemis/psd.js';
import {decodeImageOffThread} from '../../graphics/image-decode-offload.js';
import {decodeOpaqueJpeg} from '../../graphics/browser-jpeg.js';
import {artemisRevision} from './revision.js';
import {artemisPngDecodeOptions} from './png-surface.js';

/** Logical resource geometry; the owner decides whether it needs decoded pixel storage. */
export interface ArtemisImageDimensions {
  readonly width: number;
  readonly height: number;
}
export interface ArtemisImageCodec<I extends ArtemisImageDimensions = TriangleImage> {
  /** Native plugins expose case-sensitive extension strings in registration order. */
  readonly extensions: readonly string[];
  /** Null is native decode failure; exceptions represent unsupported/host failures. */
  decode(bytes: Uint8Array): Promise<I | null>;
  /** The native image format of a decoded image, when this codec determines it. */
  surfaceFormat?(image: I): 0 | 1 | 2 | undefined;
}

/** CPng 0x1401838e0: colour type 0 (gray) creates a format 0 image, every other colour
 * type format 2. */
export function artemisPngSurfaceFormat(image: {readonly colorType?: number}): 0 | 2 | undefined {
  return image.colorType === undefined ? undefined : image.colorType === 0 ? 0 : 2;
}
export interface ArtemisLoadedImage<I extends ArtemisImageDimensions = TriangleImage> {
  readonly path: string;
  readonly image: I;
  /** Native image format (virtual +0x20) when the decoder determines it: 0 is the one-byte
   * gray format, 2 the four-byte format, 1 the solid RGB fill. */
  readonly surfaceFormat?: 0 | 1 | 2;
  /** One native surface-manager loan; transfer to a successful outer layer wrapper. */
  readonly lease?: {release(): void};
}

export interface ArtemisImageSource<I extends ArtemisImageDimensions = TriangleImage> {
  load(name: string): Promise<ArtemisLoadedImage<I> | null>;
}

/** Native 0x1401756a0: extension preference, content sniffing, then appended candidates. */
export class ArtemisImageLoader<I extends ArtemisImageDimensions = TriangleImage> {
  private readonly codecs: readonly ArtemisImageCodec<I>[];
  constructor(
    private readonly readFile: (path: string) => Promise<Uint8Array | null>,
    codecs: readonly ArtemisImageCodec<I>[],
  ) {
    this.codecs = codecs.map((codec) => ({
      extensions: [...codec.extensions],
      decode: (bytes) => codec.decode(bytes),
      surfaceFormat: codec.surfaceFormat && ((image) => codec.surfaceFormat!(image)),
    }));
  }
  private async decode(
    codec: ArtemisImageCodec<I>,
    path: string,
    bytes: Uint8Array,
  ): Promise<ArtemisLoadedImage<I> | null> {
    const image = await codec.decode(bytes);
    if (image === null) return null;
    const surfaceFormat = codec.surfaceFormat?.(image);
    return surfaceFormat === undefined ? {path, image} : {path, image, surfaceFormat};
  }
  async load(name: string): Promise<ArtemisLoadedImage<I> | null> {
    if (name.includes('\0')) throw new Error('Unsupported Artemis image path containing NUL');
    const exact = await this.readFile(name);
    if (exact !== null) {
      // Native CFileName uses its Windows separator and does not fold extension case.
      const basename = name.slice(name.lastIndexOf('\\') + 1);
      const dot = basename.lastIndexOf('.');
      const extension = dot < 0 ? '' : basename.slice(dot + 1);
      if (extension)
        for (const codec of this.codecs)
          if (codec.extensions.includes(extension)) {
            const resource = await this.decode(codec, name, exact);
            if (resource !== null) return resource;
          }
      for (const codec of this.codecs) {
        const resource = await this.decode(codec, name, exact);
        if (resource !== null) return resource;
      }
    }
    for (const codec of this.codecs)
      for (const extension of codec.extensions) {
        const path = `${name}.${extension}`;
        const bytes = await this.readFile(path);
        if (bytes === null) continue;
        const resource = await this.decode(codec, path, bytes);
        if (resource !== null) return resource;
      }
    return null;
  }
}

/** Exact revision's stage codec order. Missing optional codecs refuse when their file is selected. */
export function createArtemisImageLoader(
  executableSha256: string,
  readFile: (path: string) => Promise<Uint8Array | null>,
  decoders: {
    readonly jpeg?: ArtemisImageCodec['decode'];
    readonly psd?: ArtemisImageCodec['decode'];
  } = {},
): ArtemisImageLoader {
  artemisRevision(executableSha256);
  const absent =
    (name: string): ArtemisImageCodec['decode'] =>
    async () => {
      throw new Error(`Unsupported Artemis ${name} image decoder`);
    };
  return new ArtemisImageLoader(readFile, [
    {
      extensions: ['png', 'PNG'],
      decode: async (bytes) => {
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
          return null;
        return (
          (await decodeImageOffThread(bytes, 'png', artemisPngDecodeOptions)) ??
          decodePng(bytes, artemisPngDecodeOptions)
        );
      },
      surfaceFormat: (image) => artemisPngSurfaceFormat(image as DecodedPng),
    },
    {extensions: ['jpg', 'jpeg', 'JPG', 'JPEG'], decode: decoders.jpeg ?? absent('JPEG')},
    {
      extensions: ['psd', 'PSD'],
      decode:
        decoders.psd ??
        (async (bytes) => {
          if (![56, 66, 80, 83].every((byte, index) => bytes[index] === byte)) return null;
          return (await decodeImageOffThread(bytes, 'artemis-psd')) ?? decodeArtemisPsd(bytes);
        }),
    },
  ]);
}

/** Browser-owned opaque RGB JPEG alongside the native PNG/merged PSD readers.
 * Exact revision's default CJpg path has no alpha sidecar (178e80/179120).
 * Grayscale format0 and paired alpha JPEGs require separate owners.
 */
export function createArtemisBrowserImageLoader(
  executableSha256: string,
  readFile: (path: string) => Promise<Uint8Array | null>,
): ArtemisImageLoader {
  return createArtemisImageLoader(executableSha256, readFile, {
    jpeg: async (bytes) => {
      if (bytes[0] !== 255 || bytes[1] !== 216) return null;
      return (await decodeImageOffThread(bytes, 'opaque-jpeg')) ?? decodeOpaqueJpeg(bytes);
    },
  });
}
