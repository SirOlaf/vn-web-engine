/** 0f6140: add signed half, then CVTTSD2SI, including the indefinite result. */
function roundCoordinate(value: number): number {
  const result = Math.trunc(value + (value >= 0 ? 0.5 : -0.5));
  return Number.isFinite(result) && result >= -0x80000000 && result < 0x80000000
    ? result | 0
    : -0x80000000;
}

/** 0f63e0/0f5ea0: the dedicated three-knot XY path, not CSpline. */
export function threeKnotPath(
  startX: number,
  startY: number,
  viaX: number,
  viaY: number,
  endX: number,
  endY: number,
  count: number,
): Int32Array | null {
  startX |= 0;
  startY |= 0;
  viaX |= 0;
  viaY |= 0;
  endX |= 0;
  endY |= 0;
  if ((startX < viaX && viaX > endX) || (startX > viaX && viaX < endX)) return null;
  const ascending = startX < viaX && viaX < endX;
  if (!ascending) {
    startX = -startX | 0;
    viaX = -viaX | 0;
    endX = -endX | 0;
  }
  const x = [0, (viaX - startX) | 0, (endX - startX) | 0],
    y = [0, (viaY - startY) | 0, (endY - startY) | 0],
    h = [x[1]! - x[0]!, x[2]! - x[1]!],
    sum = h[1]! + h[0]!,
    center = (((y[2]! - y[1]!) / h[1]! - (y[1]! - y[0]!) / h[0]!) * 3) / (sum + sum),
    c = [0, center, 0],
    result = new Int32Array((count >>> 0) * 2),
    step = (x[2]! - x[0]!) / ((count - 1) >>> 0);
  let position = x[0]!;
  for (let index = 0; index < count >>> 0; index++) {
    const roundedX = (roundCoordinate(position) + startX) | 0;
    result[index * 2] = ascending ? roundedX : -roundedX | 0;
    const segment = x[1]! > position ? 0 : 1,
      width = h[segment]!,
      left = c[segment]!,
      right = c[segment + 1]!,
      local = position - x[segment]!,
      linear = (y[segment + 1]! - y[segment]!) / width - ((left + left + right) * width) / 3,
      cubic = (right - left) / (width * 3),
      ordinate = (linear + (cubic * local + left) * local) * local + y[segment]!;
    result[index * 2 + 1] = (roundCoordinate(ordinate) + startY) | 0;
    position += step;
  }
  return result;
}
