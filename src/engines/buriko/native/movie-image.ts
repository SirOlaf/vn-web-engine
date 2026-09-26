import {bitmapStorage, type BurikoBitmap, type BurikoBitmapStorage} from './bitmap.js';

export interface BurikoMovieMediaType {
  readonly majorType: string;
  readonly subtype: string;
  readonly formatType: string;
  /** Native VIDEOINFOHEADER, including the BITMAPINFOHEADER at byte48. */
  readonly format: Uint8Array;
}
export interface BurikoMovieSample {
  readonly storage: BurikoBitmapStorage;
  readonly offset: number;
}
export class BurikoMovieImageConfiguration {
  /** 1401d29cc: one selects dimensions from CheckMediaType, others select SetMediaType. */
  dimensionMode = 0;
}
const rgbSubtypes = [
  'e436eb7e-524f-11ce-9f53-0020af0ba770', // RGB32
  'e436eb7d-524f-11ce-9f53-0020af0ba770', // RGB24
  'e436eb7c-524f-11ce-9f53-0020af0ba770', // RGB555
  'e436eb7b-524f-11ce-9f53-0020af0ba770', // RGB565
] as const;
function mediaInfo(type: BurikoMovieMediaType): DataView {
  if (type.format.length < 60)
    throw new RangeError('Buriko movie reads beyond VIDEOINFOHEADER storage');
  return new DataView(type.format.buffer, type.format.byteOffset, type.format.byteLength);
}

/** DCVideoRenderer media negotiation and DCVideoImageSender's four verified RGB conversions. */
export class BurikoMovieImage {
  private requestedWidth = 0;
  private requestedHeight = 0;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private selectedFormat = -1;
  sourceStride = 0;
  bottomUp = false;
  averageFrameTime = 0n;
  constructor(readonly configuration: BurikoMovieImageConfiguration) {}
  get width(): number {
    return this.configuration.dimensionMode === 1 ? this.requestedWidth : this.sourceWidth;
  }
  get height(): number {
    return this.configuration.dimensionMode === 1 ? this.requestedHeight : this.sourceHeight;
  }
  /** 0a9c00; ordering and HRESULTs are part of DirectShow media-type negotiation. */
  checkMediaType(type: BurikoMovieMediaType | null): number {
    if (type === null) return 0x80004003;
    if (type.majorType !== '73646976-0000-0010-8000-00aa00389b71') return 0x80040200;
    const format = rgbSubtypes.findIndex((subtype) => subtype === type.subtype);
    if (format < 0) return 0x80040201;
    if (type.formatType !== '05589f80-c356-11ce-bf01-00aa0055595a') return 0x80040206;
    const info = mediaInfo(type);
    this.requestedWidth = info.getInt32(52, true);
    this.requestedHeight = info.getInt32(56, true);
    this.selectedFormat = format;
    return 0;
  }
  /** 0a9b80 does not repeat CheckMediaType or add geometry validation. */
  setMediaType(type: BurikoMovieMediaType): number {
    const info = mediaInfo(type),
      width = info.getInt32(52, true),
      height = info.getInt32(56, true);
    this.sourceWidth = width;
    const sign = height >> 31;
    this.sourceHeight = ((height ^ sign) - sign) | 0;
    this.sourceStride =
      this.selectedFormat === 0
        ? Math.imul(width, 4)
        : this.selectedFormat === 1
          ? Math.imul((width + 1) | 0, 3) & ~3
          : this.selectedFormat === 2 || this.selectedFormat === 3
            ? Math.imul(width, 2)
            : 0;
    this.bottomUp = ~height >>> 31 !== 0;
    this.averageFrameTime = info.getBigInt64(40, true);
    return 0;
  }
  /** 0a97c0 writes BGRX with zero X; the 16-bit branches really produce boolean0/1 pixels. */
  copySample(destination: BurikoBitmap, sample: BurikoMovieSample): number {
    if (destination.format !== 1) return 0x80000001;
    const width = Math.min(destination.width >>> 0, this.width >>> 0);
    const height = Math.min(destination.height >>> 0, this.height >>> 0);
    const source = sample.storage;
    const read = (offset: number, size: number): number => {
      source.range(offset, size, true);
      if (size === 4) return source.view.getUint32(offset, true);
      if (size === 2) return source.view.getUint16(offset, true);
      return source.bytes[offset]!;
    };
    for (let y = 0; y < height; y++) {
      let input = sample.offset + y * this.sourceStride;
      let output = destination.offset + y * destination.stride;
      const put = (pixel: number): void => {
        const target = bitmapStorage(destination, output, 4, false);
        target.view.setUint32(output, pixel >>> 0, true);
        target.written(output, 4);
        output += 4;
      };
      if (this.selectedFormat === 0) {
        let x = 0;
        const separated =
          destination.storage !== source ||
          input + (width - 1) * 4 < output ||
          output + (width - 1) * 4 < input;
        if (width >= 16 && separated) {
          const load = (at: number): Uint8Array => {
            source.range(at, 16, true);
            const bytes = source.bytes.slice(at, at + 16);
            for (let alpha = 3; alpha < 16; alpha += 4) bytes[alpha] = 0;
            return bytes;
          };
          const store = (bytes: Uint8Array): void => {
            const target = bitmapStorage(destination, output, 16, false);
            target.bytes.set(bytes, output);
            target.written(output, 16);
            output += 16;
          };
          for (; x < (width & ~15); x += 16, input += 64) {
            const first = load(input),
              second = load(input + 16);
            store(first);
            const third = load(input + 32);
            store(second);
            const fourth = load(input + 48);
            store(third);
            store(fourth);
          }
        }
        for (; x < width; x++, input += 4) put(read(input, 4) & 0xffffff);
      } else if (this.selectedFormat === 1) {
        let x = 0;
        for (; x + 4 <= width; x += 4, input += 12) {
          put(read(input, 4) & 0xffffff);
          const secondLow = read(input + 3, 1),
            secondHigh = read(input + 4, 2);
          put(secondLow | (secondHigh << 8));
          const thirdLow = read(input + 6, 2),
            thirdHigh = read(input + 8, 1);
          put(thirdLow | (thirdHigh << 16));
          put(read(input + 8, 4) >>> 8);
        }
        for (; x < width; x++, input += 3) {
          // Tail instructions fetch bytes1,2,0, in that order.
          const green = read(input + 1, 1),
            red = read(input + 2, 1),
            blue = read(input, 1);
          put(blue | (green << 8) | (red << 16));
        }
      } else if (this.selectedFormat === 2 || this.selectedFormat === 3) {
        const mask = this.selectedFormat === 2 ? 0x7fff : 0xffff;
        for (let x = 0; x < width; x++, input += 2) put((read(input, 2) & mask) === 0 ? 0 : 1);
      }
    }
    return 0;
  }
  /** 0a94c0 flips the destination descriptor, leaving the decoded input row order intact. */
  orientDestination(bitmap: BurikoBitmap): BurikoBitmap {
    const destination = {...bitmap};
    if (this.bottomUp) {
      destination.offset += Math.imul((destination.height - 1) | 0, destination.stride) >>> 0;
      destination.stride = -destination.stride;
    }
    return destination;
  }
}
