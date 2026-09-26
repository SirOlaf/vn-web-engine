import {finishTask, type CooperativeTask} from '../../../core/cooperative-task.js';
import {
  codecCopy,
  codecMark,
  codecRead,
  codecReadableSpan,
  codecView,
  codecWrite,
  type BurikoCodecPointer,
} from './codec-storage.js';

const magic = new TextEncoder().encode('DCFS FORMAT 1.00');
const firstMagic = 0x524f462053464344n,
  secondMagic = 0x30302e312054414dn;

/** 08D740/08DA90. Run totals are checked after actual memmove writes. */
export function decodeBurikoDcfs(
  destination: BurikoCodecPointer | null,
  source: BurikoCodecPointer | null,
): number {
  return finishTask(decodeBurikoDcfsSteps(destination, source));
}

function* decodeBurikoDcfsSteps(
  destination: BurikoCodecPointer | null,
  source: BurikoCodecPointer | null,
): CooperativeTask<number> {
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
    previous = 0,
    work = 0;
  for (let record = 1; record < count; record++) {
    let total = 0,
      literal = false;
    do {
      let run = 0,
        shift = 0,
        byte: number;
      do {
        byte = codecRead(source, input++);
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
      work += run + 1;
      if (work >= 4096) {
        work = 0;
        yield;
      }
    } while (total < size);
    if (total !== size) return 0x80000004;
  }
  return 0;
}

/** 08D890/08DAE0; retains native run encoding and byte-for-byte decode verification. */
export function encodeBurikoDcfs(
  destination: BurikoCodecPointer | null,
  result: {value: number},
  source: BurikoCodecPointer | null,
  size: number,
  count: number,
): number {
  return finishTask(encodeBurikoDcfsSteps(destination, result, source, size, count));
}

/** Native worker entry retains its borrowed source/destination across host slices. */
export function* encodeBurikoDcfsSteps(
  destination: BurikoCodecPointer | null,
  result: {value: number},
  source: BurikoCodecPointer | null,
  size: number,
  count: number,
): CooperativeTask<number> {
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
    current = size,
    work = 0;
  for (let record = 1; record < count; record++) {
    let remaining = size,
      literal = false;
    while (remaining !== 0) {
      let run = 0;
      // Probe without throwing: exceptional storage keeps the native byte-read order.
      // Both records stay live, including when source and destination overlap.
      const spanLength = size + remaining + Number(record !== count - 1);
      let comparison = codecReadableSpan(source, previous, spanLength);
      const equal = (offset: number): boolean => {
        if (comparison !== null) return comparison[size + offset] === comparison[offset];
        const value = codecRead(source, current + offset);
        return codecRead(source, previous + offset) === value;
      };
      if (equal(0) !== literal) {
        do {
          if (run >= remaining) break;
          run++;
          if (++work >= 4096) {
            work = 0;
            yield;
            comparison = codecReadableSpan(source, previous, spanLength);
          }
          // 08D976/08D98C read past the final record before checking remaining.
          // Either comparison result ends this completed run with the same length.
          if (run === remaining && record === count - 1) break;
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
    verification: BurikoCodecPointer = {
      bytes: new Uint8Array(extent),
      offset: 0,
      initialized: new Uint8Array(extent),
    };
  yield* decodeBurikoDcfsSteps(verification, destination);
  for (let start = 0; start < extent; start += 4096) {
    const count = Math.min(4096, extent - start),
      left = codecReadableSpan(verification, start, count),
      right = codecReadableSpan(source, start, count);
    if (left !== null && right !== null) {
      for (let index = 0; index < count; index++)
        if (left[index] !== right[index]) return 0xffffffff;
    } else {
      for (let index = start; index < start + count; index++)
        if (codecRead(verification, index) !== codecRead(source, index)) return 0xffffffff;
    }
    yield;
  }
  result.value = length;
  return 0;
}
