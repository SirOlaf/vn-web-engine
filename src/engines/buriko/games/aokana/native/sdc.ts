import {randomByteGenerator} from '../../../../../formats/buriko/binary.js';
import {decodeSdc, SdcIntegrityError} from '../../../../../formats/buriko/compressed-resource.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {codecView, codecWrite, type AokanaCodecPointer} from './codec-storage.js';

/** F49E0/F42D0/F4440: actual caller output, with private checked token storage. */
export function decodeAokanaSdcInto(
  destination: AokanaCodecPointer | null,
  source: AokanaBpPointer | null,
): number {
  const sourceView = (offset: number, count: number): DataView => {
    if (source === null) throw new Error('Aokana SDC reads a null source');
    return pointerView({bytes: source.bytes, offset: source.offset + offset}, count);
  };
  const magic = 'SDC FORMAT 1.00\0';
  for (let index = 0; index < magic.length; index++)
    if (sourceView(index, 1).getUint8(0) !== magic.charCodeAt(index)) return 0;
  const random = randomByteGenerator(sourceView(16, 4).getUint32(0, true)),
    stored = sourceView(20, 4).getUint32(0, true),
    tokens = new Uint8Array(stored);
  let sum = 0,
    xor = 0;
  for (let index = 0; index < stored; index++) {
    const next = random(),
      value = sourceView(32 + index, 1).getUint8(0);
    tokens[index] = value - next;
    sum = (sum + value) & 0xffff;
    xor ^= value;
  }
  if (sourceView(28, 2).getUint16(0, true) !== sum || sourceView(30, 2).getUint16(0, true) !== xor)
    return 0;

  // F49E0 never reads the advertised uncompressed size at +24.
  let input = 0,
    output = 0,
    remaining = stored;
  const token = (): number => {
    const value = tokens[input++];
    if (value === undefined) throw new RangeError('Aokana SDC reads beyond private token storage');
    return value;
  };
  while (remaining !== 0) {
    const control = token();
    if ((control & 0x80) !== 0) {
      const count = ((control >>> 3) & 15) + 2,
        distance = ((control & 7) << 8) + token() + 2;
      remaining = (remaining - 2) >>> 0;
      for (let index = 0; index < count; index++) {
        const value = codecView(destination, output - distance, 1).getUint8(0);
        codecWrite(destination, output, value);
        output++;
      }
    } else {
      const count = control + 1;
      remaining = (remaining - 1 - count) >>> 0;
      for (let index = 0; index < count; index++) {
        const value = token();
        codecWrite(destination, output, value);
        output++;
      }
    }
  }
  return output >>> 0;
}

/** F49E0 returns zero for signature/checksum/count failure; unsafe ranges remain explicit. */
export function decodeAokanaSdc(bytes: Uint8Array): Uint8Array | null {
  const magic = 'SDC FORMAT 1.00\0';
  for (let i = 0; i < magic.length; i++) {
    if (i >= bytes.length)
      throw new RangeError('Aokana SDC signature exceeds native source storage');
    if (bytes[i] !== magic.charCodeAt(i)) return null;
  }
  try {
    return decodeSdc(bytes, null);
  } catch (error) {
    if (error instanceof SdcIntegrityError) return null;
    throw error;
  }
}

/** F44F0: newest-first byte buckets, exact2049-position window, longest2..17 match. */
function compressInto(input: Uint8Array, write: (offset: number, value: number) => void): number {
  const head = new Int32Array(256).fill(-1),
    tail = new Int32Array(256).fill(-1),
    older = new Int32Array(2049).fill(-1),
    newer = new Int32Array(2049).fill(-1),
    positions = new Uint32Array(2049);
  let position = 0,
    literalStart = 0,
    literals = 0,
    output = 0;
  const insert = (): void => {
    const slot = position % 2049;
    if (position > 2048) {
      const byte = input[position - 2049]!,
        next = newer[slot]!;
      tail[byte] = next;
      if (next >= 0) older[next] = -1;
      else head[byte] = -1;
    }
    const byte = input[position]!,
      previous = head[byte]!;
    positions[slot] = position;
    older[slot] = previous;
    newer[slot] = -1;
    if (previous >= 0) newer[previous] = slot;
    else tail[byte] = slot;
    head[byte] = slot;
    position++;
  };
  const flush = (): void => {
    if (literals === 0) return;
    write(output++, literals - 1);
    for (let i = 0; i < literals; i++) write(output++, input[literalStart + i]!);
    literals = 0;
    literalStart = position;
  };
  while (position < input.length) {
    let count = 0,
      distance = 0;
    const maximum = Math.min(17, input.length - position);
    for (let slot = head[input[position]!]!; slot >= 0; slot = older[slot]!) {
      const offset = position - positions[slot]!;
      if (offset === 1) continue;
      let length = 1;
      while (length < maximum && input[position + length - offset] === input[position + length])
        length++;
      if (length > 1 && length > count) {
        count = length;
        distance = offset;
      }
      if (length > 1 && length === maximum) break;
    }
    if (count > 1) {
      flush();
      for (let i = 0; i < count; i++) insert();
      const code = distance + 0x6ffe + count * 0x800;
      // F44F0 stores the low byte at +1 before the high byte at +0.
      write(output + 1, code & 255);
      write(output, (code >>> 8) & 255);
      output += 2;
      literalStart = position;
    } else {
      insert();
      if (++literals >= 128) flush();
    }
  }
  flush();
  return output;
}

/** F4900 owns only the source snapshot and verification scratch; output belongs to its caller. */
export function encodeAokanaSdcInto(
  destination: AokanaBpPointer | null,
  source: AokanaBpPointer | null,
  count: number,
  readSystemTime: () => Date,
): number {
  count >>>= 0;
  const plain = new Uint8Array(count);
  if (count !== 0) {
    if (source === null) throw new Error('Aokana SDC encoding reads a null source');
    pointerView(source, count);
    plain.set(source.bytes.subarray(source.offset, source.offset + count));
  }
  const view = (offset: number, length: number): DataView => {
    if (destination === null) throw new Error('Aokana SDC encoding accesses a null destination');
    return pointerView({bytes: destination.bytes, offset: destination.offset + offset}, length);
  };
  const packed = compressInto(plain, (offset, value) => view(32 + offset, 1).setUint8(0, value));
  view(20, 4).setUint32(0, packed, true);
  view(24, 4).setUint32(0, count, true);
  const magic = 'SDC FORMAT 1.00\0';
  for (let index = 0; index < magic.length; index++)
    view(index, 1).setUint8(0, magic.charCodeAt(index));
  const seed = readSystemTime().getUTCMilliseconds(),
    next = randomByteGenerator(seed);
  let sum = 0,
    xor = 0;
  for (let index = 0; index < packed; index++) {
    const cell = view(32 + index, 1),
      value = (cell.getUint8(0) + next()) & 255;
    cell.setUint8(0, value);
    sum = (sum + value) & 0xffff;
    xor ^= value;
  }
  view(16, 4).setUint32(0, seed, true);
  view(28, 2).setUint16(0, sum, true);
  view(30, 2).setUint16(0, xor, true);
  const verification = new Uint8Array((count * 2) >>> 0),
    produced = decodeAokanaSdcInto({bytes: verification, offset: 0}, destination);
  if (produced !== count) return 0;
  for (let index = 0; index < count; index++) if (verification[index] !== plain[index]) return 0;
  return (packed + 32) >>> 0;
}

/** F4900/F4390. Seed is the actual GetSystemTime UTC millisecond component supplied by caller. */
export function encodeAokanaSdc(input: Uint8Array, seed: number): Uint8Array | null {
  const plain = input.slice(),
    bytes: number[] = [];
  compressInto(plain, (offset, value) => {
    bytes[offset] = value;
  });
  const packed = Uint8Array.from(bytes);
  if (packed.length + 32 > (plain.length * 2) >>> 0)
    throw new RangeError('Aokana SDC encoder exceeds its native double-input allocation');
  const encoded = new Uint8Array(32 + packed.length),
    view = new DataView(encoded.buffer),
    next = randomByteGenerator(seed >>> 0);
  encoded.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
  view.setUint32(16, seed >>> 0, true);
  view.setUint32(20, packed.length, true);
  view.setUint32(24, plain.length, true);
  let sum = 0,
    xor = 0;
  for (let i = 0; i < packed.length; i++) {
    const value = (packed[i]! + next()) & 255;
    encoded[32 + i] = value;
    sum = (sum + value) & 0xffff;
    xor ^= value;
  }
  view.setUint16(28, sum, true);
  view.setUint16(30, xor, true);
  const restored = decodeAokanaSdc(encoded);
  return restored !== null &&
    restored.length === plain.length &&
    restored.every((v, i) => v === plain[i])
    ? encoded
    : null;
}
