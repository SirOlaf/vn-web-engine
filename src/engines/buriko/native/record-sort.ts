import type {BurikoBpPointer} from '../bp/memory.js';
import {pointerBytes} from '../bp/opcodes/operands.js';

/** 1400f4bb0 and the executable's six signed, subtracting comparators. */
export function sortNativeRecords(
  base: BurikoBpPointer | null,
  count: number,
  stride: number,
  keyOffset: number,
  selector: number,
): number {
  count >>>= 0;
  stride >>>= 0;
  keyOffset >>>= 0;
  if (count < 2) return 1;
  if (selector < 0 || selector > 5) return 3;
  const width = 1 << (selector >>> 1);
  if ((keyOffset + width) >>> 0 > stride) return 2;
  if (base === null || stride === 0) {
    throw new Error('Buriko native qsort invalid parameter');
  }
  const view = new DataView(base.bytes.buffer, base.bytes.byteOffset, base.bytes.byteLength);
  const read = (index: number): number => {
    const displacement = index * stride + keyOffset;
    pointerBytes(base, width, displacement);
    const address = base.offset + displacement;
    return width === 4
      ? view.getInt32(address, true)
      : width === 2
        ? view.getInt16(address, true)
        : view.getInt8(address);
  };
  const compare = (left: number, right: number): number => {
    const a = read(left),
      b = read(right);
    // Subtraction, including signed DWORD overflow, is observable to the partitioner.
    return (selector & 1) === 0 ? (a - b) | 0 : (b - a) | 0;
  };
  const swap = (left: number, right: number): void => {
    if (left === right) return;
    const a = pointerBytes(base, stride, left * stride);
    const b = pointerBytes(base, stride, right * stride);
    for (let offset = 0; offset < stride; offset++) {
      const byte = a[offset]!;
      a[offset] = b[offset]!;
      b[offset] = byte;
    }
  };
  nativeQuickSort(count, compare, swap);
  return 0;
}

/** 14001c030: median-of-three CRT qsort, with its exact equal-key permutation. */
export function nativeQuickSort(
  count: number,
  compare: (left: number, right: number) => number,
  swap: (left: number, right: number) => void,
): void {
  const pending: [number, number][] = [];
  let lo = 0,
    hi = count - 1;
  for (;;) {
    const length = hi - lo + 1;
    if (length <= 8) {
      while (lo < hi) {
        let maximum = lo;
        for (let current = lo + 1; current <= hi; current++) {
          if (compare(current, maximum) > 0) maximum = current;
        }
        swap(maximum, hi--);
      }
    } else {
      let pivot = lo + Math.floor(length / 2);
      if (compare(lo, pivot) > 0) swap(lo, pivot);
      if (compare(lo, hi) > 0) swap(lo, hi);
      if (compare(pivot, hi) > 0) swap(pivot, hi);
      let left = lo,
        right = hi,
        end = right;
      for (;;) {
        // The two loops skip comparing the record at the pivot's own address.
        if (left < pivot) {
          do {
            left++;
          } while (left < pivot && compare(left, pivot) <= 0);
        }
        if (left >= pivot) {
          do {
            left++;
          } while (left <= hi && compare(left, pivot) <= 0);
        }
        do {
          end = right;
          right--;
        } while (right > pivot && compare(right, pivot) > 0);
        if (left > right) break;
        swap(left, right);
        if (pivot === right) pivot = left;
      }
      if (pivot < end) {
        do {
          end--;
        } while (end > pivot && compare(end, pivot) === 0);
      }
      if (end <= pivot) {
        do {
          end--;
        } while (end > lo && compare(end, pivot) === 0);
      }
      // Process the shorter partition first, retaining the native stack order.
      if (end - lo < hi - left) {
        if (left < hi) pending.push([left, hi]);
        if (lo < end) {
          hi = end;
          continue;
        }
      } else {
        if (lo < end) pending.push([lo, end]);
        if (left < hi) {
          lo = left;
          continue;
        }
      }
    }
    const next = pending.pop();
    if (next === undefined) return;
    [lo, hi] = next;
  }
}
