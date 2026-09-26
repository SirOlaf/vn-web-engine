import {
  BurikoBitmapStorage,
  allocateBurikoBitmap,
  burikoBitmapPixelSize,
  type BurikoBitmap,
} from './bitmap.js';
import {bitmapWrite32} from './bitmap-scalar.js';
import {BurikoSurfaces} from './surfaces.js';
import {codecView} from './codec-storage.js';

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function byte(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined)
    throw new RangeError('Buriko bitmap image reads outside its native byte buffer');
  return value;
}

/** 037730 identifies the engine's sixteen-byte bitmap header, independently of compression. */
export function burikoPackedBitmapFormat(bytes: Uint8Array, initialized?: Uint8Array): number {
  const word = (at: number) => codecView({bytes, offset: 0, initialized}, at, 2).getUint16(0, true);
  switch (word(4)) {
    case 8:
      return 3;
    case 16:
      return 0;
    case 24:
      return 1;
    case 32: {
      const subtype = word(8);
      return subtype === 4 || subtype === 5 || subtype === 7 ? subtype : 2;
    }
    case 48:
      return 6;
    default:
      return -1;
  }
}

/** 0378D0 / 037BA0 reconstruct channel-plane deltas in alternating row directions. */
export function decodeBurikoPackedBitmap(bytes: Uint8Array): Uint8Array {
  return decodePackedStorage(bytes).bytes;
}
function decodePackedStorage(
  bytes: Uint8Array,
  initialized?: Uint8Array,
  allocated?: Uint8Array,
): {
  bytes: Uint8Array;
  initialized?: Uint8Array;
} {
  const source = {bytes, offset: 0, initialized},
    word = (at: number) => codecView(source, at, 2).getUint16(0, true),
    compression = word(6);
  if (compression !== 1) return {bytes, initialized};
  const height = word(2),
    width = word(0);
  const channels = word(4) >>> 3;
  const count = Math.imul(width, height),
    size = Math.imul(channels, count);
  const output = allocated ?? new Uint8Array(size + 16);
  // The native local has four explicitly initialized predictor bytes.
  const previous: (number | undefined)[] = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inputPixel = y * width + x;
      const outputPixel = y * width + (y & 1 ? width - 1 - x : x);
      for (let channel = 0; channel < channels; channel++) {
        const predictor = previous[channel];
        if (predictor === undefined)
          throw new Error('Buriko bitmap delta reads an unwritten predictor byte');
        const value =
          (codecView(source, 16 + channel * count + inputPixel, 1).getUint8(0) + predictor) & 255;
        output[16 + outputPixel * channels + channel] = value;
        previous[channel] = value;
      }
    }
  }
  // 0378D0 loads the second header QWORD before the first, after channel reconstruction.
  const high = codecView(source, 8, 8).getBigUint64(0, true),
    low = codecView(source, 0, 8).getBigUint64(0, true);
  view(output).setBigUint64(0, low, true);
  view(output).setBigUint64(8, high, true);
  view(output).setUint16(6, 0, true);
  return {bytes: output};
}

/** 09B740's image descriptor, including its packed BGR24-to-DWORD expansion. */
export function burikoPackedBitmapDescriptor(bytes: Uint8Array): {
  bitmap: BurikoBitmap;
  header: Uint8Array;
  temporary: boolean;
} {
  const decoded = decodeBurikoPackedBitmap(bytes),
    data = view(decoded);
  const width = data.getUint16(0, true),
    height = data.getUint16(2, true);
  const format = burikoPackedBitmapFormat(decoded),
    bytesPerPixel = burikoBitmapPixelSize(format);
  const header = new Uint8Array(16);
  for (let index = 0; index < 16; index++) header[index] = byte(decoded, index);
  if (format === 1) {
    const bitmap = allocateBurikoBitmap(width, height, 1);
    for (let index = 0; index < width * height; index++) {
      const at = 16 + index * 3;
      const green = byte(decoded, at + 1),
        red = byte(decoded, at + 2),
        blue = byte(decoded, at);
      bitmapWrite32(bitmap, index * 4, blue | (green << 8) | (red << 16));
    }
    return {bitmap, header, temporary: true};
  }
  return {
    bitmap: {
      storage: new BurikoBitmapStorage(decoded, true),
      offset: 16,
      width,
      height,
      format,
      bytesPerPixel,
      stride: Math.imul(width, bytesPerPixel),
    },
    header,
    temporary: false,
  };
}

/** 036DC0: packed images preserve optional unsigned metadata and use the actual surface import. */
export function importBurikoPackedBitmap(
  surfaces: BurikoSurfaces,
  index: number,
  bytes: Uint8Array,
  initialized?: Uint8Array,
): 0 | 1 | 2 {
  const format = burikoPackedBitmapFormat(bytes, initialized);
  if (format === -1) return 1;
  const compression = codecView({bytes, offset: 0, initialized}, 6, 2).getUint16(0, true);
  if (compression !== 0 && compression !== 1) return 1;
  let allocated: Uint8Array | undefined;
  if (compression === 1) {
    const source = {bytes, offset: 0, initialized},
      channels = codecView(source, 4, 2).getUint16(0, true) >>> 3,
      height = codecView(source, 2, 2).getUint16(0, true),
      width = codecView(source, 0, 2).getUint16(0, true);
    allocated = new Uint8Array(Math.imul(Math.imul(channels, height), width) + 16);
  }
  const decoded =
      compression === 1 ? decodePackedStorage(bytes, initialized, allocated) : {bytes, initialized},
    source = {bytes: decoded.bytes, offset: 0, initialized: decoded.initialized},
    word = (at: number) => codecView(source, at, 2).getUint16(0, true);
  const metadata: [number, number] | null = word(10) === 1 ? [word(12), word(14)] : null;
  const height = word(2),
    width = word(0);
  return surfaces.importRaw(
    index,
    width,
    height,
    format,
    {bytes: decoded.bytes, offset: 16},
    metadata,
    0,
    decoded.initialized,
  ) === 0
    ? 2
    : 0;
}

/** 036EE0 handles the native BITMAPINFOHEADER/BI_RGB forms without browser image decoding. */
export function importBurikoWindowsBitmap(
  surfaces: BurikoSurfaces,
  index: number,
  bytes: Uint8Array,
): number {
  const data = view(bytes);
  if (data.getUint16(0, true) !== 0x4d42) return 0x80000001;
  if (data.getUint32(14, true) !== 40) return 0x80000002;
  if (data.getUint16(26, true) !== 1) return 0x80000003;
  const bits = data.getUint16(28, true);
  const format = ({8: 3, 16: 0, 24: 7, 32: 2} as Record<number, number>)[bits];
  if (format === undefined) return 0x80000004;
  if (data.getUint32(30, true) !== 0) return 0x80000005;
  const width = data.getInt32(18, true),
    height = data.getInt32(22, true);
  if (width === 0 || height === 0) return 0x80000006;
  const inputBpp = bits >>> 3,
    outputBpp = bits === 24 ? 4 : inputBpp;
  const stride = Math.imul(width, outputBpp),
    output = new Uint8Array(Math.imul(height, stride) >>> 0);
  const inputBase = data.getUint32(10, true);
  let inputOffset = 0;
  for (let row = 0; row < height >>> 0; row++) {
    const outputRow = Math.imul((height - row - 1) | 0, stride) >>> 0;
    for (let x = 0; x < width >>> 0; x++) {
      const at = (outputRow + Math.imul(x, outputBpp)) >>> 0;
      for (let channel = 0; channel < inputBpp; channel++) {
        const value = byte(bytes, inputBase + inputOffset + channel);
        if (at + channel >= output.length)
          throw new RangeError('Buriko BMP conversion writes outside its native byte buffer');
        output[at + channel] = value;
      }
      for (let channel = inputBpp; channel < outputBpp; channel++) output[at + channel] = 0;
      inputOffset = (inputOffset + inputBpp) >>> 0;
    }
    inputOffset = (inputOffset + 3) & 0xfffffffc;
  }
  return surfaces.importRaw(index, width, height, format, {bytes: output, offset: 0}, null, 0) === 0
    ? 0x80000007
    : 0;
}
