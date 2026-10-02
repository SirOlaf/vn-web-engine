/**
 * Arithmetic on four 8-bit lanes packed in one 32-bit word, each lane independent of its
 * neighbours. Results are unsigned.
 */

/** Lane-wise `a + b` modulo 256. */
export function addLanes(a: number, b: number): number {
  const mask = 0x00ff00ff;
  return (
    ((((a & mask) + (b & mask)) & mask) |
      (((((a >>> 8) & mask) + ((b >>> 8) & mask)) & mask) << 8)) >>>
    0
  );
}

/** Lane-wise `floor((a + b) / 2)`. */
export function averageLanesFloor(a: number, b: number): number {
  return ((a & b) + (((a ^ b) & 0xfefefefe) >>> 1)) >>> 0;
}

/** Lane-wise `ceil((a + b) / 2)`. */
export function averageLanesCeil(a: number, b: number): number {
  return ((a | b) - (((a ^ b) & 0xfefefefe) >>> 1)) >>> 0;
}

/** Lane-wise `min(a + b, 255)` of the low three lanes; the high lane becomes zero. */
export function addLanesSaturated24(a: number, b: number): number {
  const carry = ((((((a ^ b) & 0xfefefe) + ((a & b) << 1)) >>> 8) & 0x10101) + 0x7f7f7f) ^ 0x7f7f7f;
  return (carry | ((a + b - carry) >>> 0)) >>> 0;
}
