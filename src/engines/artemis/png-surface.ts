import type {DecodedPng, PngDecodeOptions} from '../../formats/png/decode.js';
import type {ArtemisRuleImage} from './transition.js';

/** The PNG loader 0x1401838e0 reads through libpng 1.6.21 created with
 * png_create_read_struct's defaults (0x140057750: no error/warning handlers, CRC actions
 * unchanged). png_crc_finish 0x14005ccf0 then warns on stderr and drops an ancillary chunk
 * whose CRC fails; the image still loads. A critical chunk's CRC failure fails the load. */
export const artemisPngDecodeOptions: PngDecodeOptions = Object.freeze({
  ancillaryCrcErrors: 'discard',
  // CPng reads image/end and destroys libpng state without checking CFile EOF.
  trailingBytes: 'ignore',
});

/** CPng load 0x1401838e0 (libpng): gray images (colour type 0) create a format 0 image
 * with one byte per pixel; every other colour type creates a format 2 image with four.
 *
 * Gray depths below 8 are expanded by bit replication and 16-bit samples keep their high
 * byte, which is what `decodePng` stores in the red channel. A gray tRNS chunk is not
 * applied natively; format 0 keeps no alpha, so the decoded alpha is dropped. Format 2
 * pixels stay in decoded RGBA order. */
export function artemisPngSurface(png: DecodedPng): ArtemisRuleImage {
  const {width, height} = png;
  if (png.pixels.length !== width * height * 4) throw Error('Invalid decoded PNG pixels');
  if (png.colorType !== 0) return {width, height, bytesPerPixel: 4, pixels: png.pixels, format: 2};
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index++) pixels[index] = png.pixels[index * 4]!;
  return {width, height, bytesPerPixel: 1, pixels, format: 0};
}
