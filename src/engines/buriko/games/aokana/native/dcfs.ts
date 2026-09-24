import {
  codecCopy,
  codecMark,
  codecView,
  codecWrite,
  type AokanaCodecPointer,
} from './codec-storage.js';

const magic = new TextEncoder().encode('DCFS FORMAT 1.00');
const firstMagic = 0x524f462053464344n,
  secondMagic = 0x30302e312054414dn;

/** 08D740/08DA90. Run totals are checked after actual memmove writes. */
export function decodeAokanaDcfs(
  destination: AokanaCodecPointer | null,
  source: AokanaCodecPointer | null,
): number {
  if (
    codecView(source, 0, 8).getBigUint64(0, true) !== firstMagic ||
    codecView(source, 8, 8).getBigUint64(0, true) !== secondMagic
  )
    return 0x80000003;
  const size = codecView(source, 16, 4).getUint32(0, true);
  if (size === 0) return 0x80000004;
  const count = codecView(source, 20, 4).getUint32(0, true);
  if (count === 0) return 0x80000004;
  codecCopy(destination, 0, source, 24, size);
  let input = 24 + size,
    output = size,
    previous = 0;
  for (let record = 1; record < count; record++) {
    let total = 0,
      literal = false;
    do {
      let run = 0,
        shift = 0,
        byte: number;
      do {
        byte = codecView(source, input++, 1).getUint8(0);
        run = (run | ((byte & 127) << (shift & 31))) >>> 0;
        shift = (shift + 7) & 255;
      } while ((byte & 128) !== 0);
      if (literal) {
        codecCopy(destination, output, source, input, run);
        input += run;
      } else if (run !== 0) codecCopy(destination, output, destination, previous, run);
      total = (total + run) >>> 0;
      output += run;
      previous += run;
      literal = !literal;
    } while (total < size);
    if (total !== size) return 0x80000004;
  }
  return 0;
}

/** 08D890/08DAE0, including native next-byte comparisons at each completed run. */
export function encodeAokanaDcfs(
  destination: AokanaCodecPointer | null,
  result: {value: number},
  source: AokanaCodecPointer | null,
  size: number,
  count: number,
): number {
  size >>>= 0;
  count >>>= 0;
  if (count === 0) return 0x80000001;
  if (size === 0) return 0x80000002;
  codecView(destination, 0, 16, false);
  destination!.bytes.set(magic, destination!.offset);
  codecMark(destination!, 0, 16);
  codecView(destination, 16, 4, false).setUint32(0, size, true);
  codecMark(destination!, 16, 4);
  codecView(destination, 20, 4, false).setUint32(0, count, true);
  codecMark(destination!, 20, 4);
  codecCopy(destination, 24, source, 0, size);
  let output = (size + 24) >>> 0,
    length = output,
    previous = 0,
    current = size;
  for (let record = 1; record < count; record++) {
    let remaining = size,
      literal = false;
    while (remaining !== 0) {
      let run = 0;
      const equal = (offset: number): boolean => {
        const value = codecView(source, current + offset, 1).getUint8(0);
        return codecView(source, previous + offset, 1).getUint8(0) === value;
      };
      if (equal(0) !== literal) {
        do {
          if (run >= remaining) break;
          run++;
        } while (equal(run) !== literal);
      }
      let encoded = run,
        bytes = 0;
      do {
        codecWrite(destination, output + bytes++, encoded > 127 ? (encoded & 127) | 128 : encoded);
        encoded >>>= 7;
      } while (encoded !== 0);
      output += bytes;
      length = (length + bytes) >>> 0;
      if (literal) {
        codecCopy(destination, output, source, current, run);
        output += run;
        length = (length + run) >>> 0;
      }
      previous += run;
      current += run;
      literal = !literal;
      remaining = (remaining - run) >>> 0;
    }
  }
  const extent = Math.imul(size, count) >>> 0,
    verification: AokanaCodecPointer = {
      bytes: new Uint8Array(extent),
      offset: 0,
      initialized: new Uint8Array(extent),
    };
  decodeAokanaDcfs(verification, destination);
  for (let index = 0; index < extent; index++) {
    const left = codecView(verification, index, 1).getUint8(0),
      right = codecView(source, index, 1).getUint8(0);
    if (left !== right) return 0xffffffff;
  }
  result.value = length;
  return 0;
}
