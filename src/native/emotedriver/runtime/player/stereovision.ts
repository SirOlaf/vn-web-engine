const f = Math.fround;

/** Native 0x180038480/0x1800386b0: strict comparisons retain the first equal bound. */
export function expandEmoteVariableBounds(bounds: Float32Array, begin: number, end: number): void {
  begin = f(begin);
  end = f(end);
  const low = end <= begin && begin !== end ? end : begin,
    high = begin <= end && end !== begin ? end : begin;
  if (low < bounds[0]!) bounds[0] = low;
  if (bounds[1]! < high) bounds[1] = high;
}

/**
 * Native 0x18001f990. Pairs are multiply/add coefficients for each screen.
 * Keep the SSE instruction grouping: scaled spans are rounded before the
 * screen-index multiplication, and cancellation is performed separately.
 */
export function emoteStereovisionCoefficients(
  begin: number,
  end: number,
  volume: number,
  parallax: number,
  count: number,
  out: Float32Array,
): void {
  const product = f(f(parallax) * f(volume)),
    remaining = f(1 - product),
    span = f(f(end) - f(begin)),
    scaled = f(span * product),
    kept = f(remaining * span),
    denominator = f((count - 1) >>> 0);
  for (let screen = 0; screen < count; screen++) {
    const origin = f(f(f(f((count - screen - 1) >>> 0) * scaled) / denominator) + f(begin)),
      multiply = f(f(1 / span) * f(f(origin + kept) - origin));
    out[screen * 2] = multiply;
    out[screen * 2 + 1] = f(origin - f(f(begin) * multiply));
  }
}
