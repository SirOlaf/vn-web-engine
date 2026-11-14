import {readJpegHeader} from '../formats/jpeg/header.js';
import {decodeBrowserImage} from './browser-image.js';

/** Opaque three-component baseline/progressive JPEG with metadata ignored.
 * This owner uses the browser codec, not a native JPEG rounding implementation.
 */
export async function decodeOpaqueJpeg(
  bytes: Uint8Array,
): Promise<{width: number; height: number; pixels: Uint8Array}> {
  const header = readJpegHeader(bytes, true);
  if (header.components !== 3 || header.precision !== 8 || ![192, 194].includes(header.frameMarker))
    throw new Error('Unsupported opaque JPEG layout');
  if (header.width * header.height > Math.floor(0x7fffffff / 4))
    throw new Error('Unsupported opaque JPEG dimensions');
  const image = await decodeBrowserImage(header.bytes, 'image/jpeg');
  if (image.width !== header.width || image.height !== header.height)
    throw new Error('Browser JPEG dimensions differ from stored frame');
  return image;
}
