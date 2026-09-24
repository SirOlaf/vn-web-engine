import {pointerView, type AokanaBpPointer} from '../bp/memory.js';

/** 056FC0: signed IDIV consumes the signed64 result of the numerator SHL. */
export function perspectiveScale(depth: number, perspective: number): number {
  depth |= 0;
  perspective >>>= 0;
  if (depth === 0 || perspective === 0) return 0x10000;
  const p = BigInt(perspective),
    z = BigInt(depth);
  if (depth >= 0) return Number(BigInt.asIntN(64, p << 32n) / (z + p * 0x10000n)) | 0;
  return Number((p * 0x10000n - z) / p) | 0;
}

function word(pointer: AokanaBpPointer | null, offset: number): DataView {
  if (pointer === null) throw new Error('Aokana perspective point dereferences a null pointer');
  return pointerView({bytes: pointer.bytes, offset: pointer.offset + offset}, 4);
}

/** 032370 reads sourceY only after destinationX is published. */
export function projectAokanaPoint(
  destination: AokanaBpPointer | null,
  source: AokanaBpPointer | null,
  perspectiveX: number,
  perspectiveY: number,
): void {
  const scaleX = perspectiveScale(word(source, 8).getInt32(0, true), perspectiveX) >>> 0;
  const scaleY = perspectiveScale(word(source, 8).getInt32(0, true), perspectiveY) >>> 0;
  const x = word(source, 0).getInt32(0, true);
  word(destination, 0).setInt32(0, Number((BigInt(x) * BigInt(scaleX)) >> 16n) | 0, true);
  const y = word(source, 4).getInt32(0, true);
  word(destination, 4).setInt32(0, Number((BigInt(y) * BigInt(scaleY)) >> 16n) | 0, true);
}
