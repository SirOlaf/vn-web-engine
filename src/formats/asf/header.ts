/** ASF (WMV/WMA) Header Object summary, read without decoding media. */
export interface AsfHeader {
  /** Header Object size: the Data Object starts here. */
  readonly headerSize: number;
  /** File Properties Object play duration in 100 ns units, including the preroll. */
  readonly playDuration: bigint;
  /** File Properties Object preroll in milliseconds. */
  readonly preroll: bigint;
  /** Broadcast flag: duration fields are not valid. */
  readonly broadcast: boolean;
  /** Presentation length in milliseconds (play duration minus preroll), null for a
   * broadcast file. */
  readonly duration: number | null;
}

/** GUID bytes as stored in ASF objects. */
export const asfGuid = (text: string) => {
  const hex = text.replace(/-/g, '');
  const bytes = Uint8Array.from(hex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
  // The first three GUID fields are stored little-endian.
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
};
const headerObject = asfGuid('75B22630-668E-11CF-A6D9-00AA0062CE6C');
const filePropertiesObject = asfGuid('8CABDCA1-A947-11CF-8EE4-00C00C205365');
export const asfGuidAt = (bytes: Uint8Array, at: number, id: Uint8Array) =>
  id.every((byte, index) => bytes[at + index] === byte);

export function isAsf(bytes: Uint8Array): boolean {
  return bytes.length >= 16 && asfGuidAt(bytes, 0, headerObject);
}

/** Header Object (GUID, u64 size, u32 object count, two reserved bytes) followed by its
 * child objects; the File Properties Object is required. */
export function readAsfHeader(bytes: Uint8Array): AsfHeader {
  if (!isAsf(bytes)) throw Error('Not an ASF file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30) throw Error('Truncated ASF header object');
  const size = view.getBigUint64(16, true);
  if (size < 30n || size > BigInt(bytes.length)) throw Error('Invalid ASF header object size');
  const headerSize = Number(size);
  const count = view.getUint32(24, true);
  let offset = 30;
  for (let index = 0; index < count; index++) {
    if (offset + 24 > headerSize) throw Error('Truncated ASF header child');
    const childSize = view.getBigUint64(offset + 16, true);
    if (childSize < 24n || BigInt(offset) + childSize > size)
      throw Error('Invalid ASF header child size');
    if (asfGuidAt(bytes, offset, filePropertiesObject)) {
      if (childSize < 104n) throw Error('Truncated ASF file properties object');
      const body = offset + 24;
      const playDuration = view.getBigUint64(body + 40, true);
      const preroll = view.getBigUint64(body + 56, true);
      const broadcast = (view.getUint32(body + 64, true) & 1) !== 0;
      const duration = broadcast ? null : Number(playDuration) / 10000 - Number(preroll);
      if (duration !== null && duration < 0) throw Error('Invalid ASF duration');
      return {headerSize, playDuration, preroll, broadcast, duration};
    }
    offset += Number(childSize);
  }
  throw Error('Missing ASF file properties object');
}
