export interface JpegHeader {
  readonly width: number;
  readonly height: number;
  readonly components: number;
  readonly precision: number;
  readonly frameMarker: number;
  /** Original bytes unless APP1/APP2 metadata was explicitly removed. */
  readonly bytes: Uint8Array;
}

/** Read JPEG marker structure without decoding media. Optional APP1/APP2 removal
 * lets an owner ignore EXIF orientation and ICC profiles, including between scans.
 * Entropy byte stuffing and restart markers remain untouched.
 */
export function readJpegHeader(bytes: Uint8Array, ignoreExifAndIcc = false): JpegHeader {
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Not a JPEG image');
  let offset = 2,
    entropy = false;
  let header: Omit<JpegHeader, 'bytes'> | undefined;
  const omitted: {start: number; end: number}[] = [];
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  while (offset < bytes.length) {
    if (entropy) {
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) {
          offset++;
          continue;
        }
        let next = offset + 1;
        while (bytes[next] === 255) next++;
        const marker = bytes[next];
        if (marker === 0 || (marker !== undefined && marker >= 208 && marker <= 215)) {
          offset = next + 1;
          continue;
        }
        break;
      }
      if (offset >= bytes.length) break;
      entropy = false;
    }
    const start = offset;
    if (bytes[offset++] !== 255) throw new Error('Invalid JPEG marker');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) throw new Error('Truncated JPEG marker');
    if (marker === 217) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (marker === 0 || marker === 216) throw new Error('Invalid JPEG marker sequence');
    if (offset + 2 > bytes.length) throw new Error('Truncated JPEG segment');
    const length = u16(offset),
      end = offset + length;
    if (length < 2 || end > bytes.length) throw new Error('Invalid JPEG segment length');
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (length < 8) throw new Error('Truncated JPEG frame');
      const precision = bytes[offset + 2]!,
        height = u16(offset + 3),
        width = u16(offset + 5),
        components = bytes[offset + 7]!;
      if (!width || !height || !components || length < 8 + components * 3)
        throw new Error('Invalid JPEG frame dimensions or components');
      if (header) throw new Error('Unsupported multiple JPEG frames');
      header = {width, height, components, precision, frameMarker: marker};
    }
    if (ignoreExifAndIcc && (marker === 225 || marker === 226)) omitted.push({start, end});
    offset = end;
    if (marker === 218) entropy = true;
  }
  if (!header) throw new Error('JPEG frame header missing');
  if (!omitted.length) return {...header, bytes};
  const result = new Uint8Array(
    bytes.length - omitted.reduce((size, range) => size + range.end - range.start, 0),
  );
  let source = 0,
    destination = 0;
  for (const range of omitted) {
    result.set(bytes.subarray(source, range.start), destination);
    destination += range.start - source;
    source = range.end;
  }
  result.set(bytes.subarray(source), destination);
  return {...header, bytes: result};
}
