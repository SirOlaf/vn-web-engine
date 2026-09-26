/** Native CSpline (1400879a0), used by logical-grid line-of-sight sampling. */
export class BurikoNativeSpline {
  private readonly coordinates: [number[], number[], number[]] = [[], [], []];
  private coefficients: [SplineAxis, SplineAxis, SplineAxis] | undefined;
  private duration = 0;

  clear(): void {
    for (const axis of this.coordinates) axis.length = 0;
    this.duration = 0;
    this.coefficients = undefined;
  }

  append(x: number, y: number, z: number): boolean {
    if (this.coordinates[0].length >= 100) return false;
    this.coefficients = undefined;
    this.coordinates[0].push(x | 0);
    this.coordinates[1].push(y | 0);
    this.coordinates[2].push(z | 0);
    return true;
  }

  setDuration(duration: number): void {
    this.duration = duration >>> 0;
  }

  /** 140087720 clears all output coordinates even when no sample is available. */
  sample(time: number, output: Int32Array): boolean {
    if (output.length < 3) throw new Error('Buriko spline output access exceeds allocation');
    output[0] = output[1] = output[2] = 0;
    const count = this.coordinates[0].length;
    if (this.duration === 0 || count === 0) return false;
    time >>>= 0;
    if (time >= this.duration) {
      for (let axis = 0; axis < 3; axis++) output[axis] = this.coordinates[axis]![count - 1]!;
      return true;
    }
    const fraction = time / this.duration;
    if (count < 3) {
      for (let axis = 0; axis < 3; axis++) {
        const points = this.coordinates[axis]!,
          first = points[0]!;
        output[axis] =
          count === 1
            ? first
            : (truncateSplineInteger(((points[1]! - first) | 0) * fraction) + first) | 0;
      }
      return true;
    }
    this.coefficients ??= this.coordinates.map((axis) => new SplineAxis(axis)) as [
      SplineAxis,
      SplineAxis,
      SplineAxis,
    ];
    for (let axis = 0; axis < 3; axis++) {
      output[axis] = truncateSplineInteger(this.coefficients[axis]!.evaluate(fraction));
    }
    return true;
  }
}

/** CVTTSD2SI, including the native integer-indefinite result. */
export function truncateSplineInteger(value: number): number {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -0x80000000 || integer >= 0x80000000
    ? -0x80000000
    : integer;
}

/** 140087470 natural cubic coefficients; each expression retains SSE2 grouping. */
class SplineAxis {
  private readonly linear: Float64Array;
  private readonly quadratic: Float64Array;
  private readonly cubic: Float64Array;
  constructor(private readonly points: readonly number[]) {
    const segments = points.length - 1;
    this.linear = new Float64Array(points.length);
    this.quadratic = new Float64Array(points.length);
    this.cubic = new Float64Array(points.length);
    const inverse = new Float64Array(points.length),
      q = this.quadratic;
    for (let i = 1; i < segments; i++) {
      q[i] = (points[i - 1]! - (points[i]! + points[i]!) + points[i + 1]!) * 3;
    }
    for (let i = 1; i < segments; i++) {
      const denominator = 4 - inverse[i - 1]!;
      q[i] = (q[i]! - q[i - 1]!) / denominator;
      inverse[i] = 1 / denominator;
    }
    for (let i = segments - 1; i > 0; i--) q[i] = q[i]! - inverse[i]! * q[i + 1]!;
    for (let i = 0; i < segments; i++) {
      const cubic = (q[i + 1]! - q[i]!) / 3;
      this.cubic[i] = cubic;
      this.linear[i] = points[i + 1]! - points[i]! - q[i]! - cubic;
    }
  }

  evaluate(fraction: number): number {
    const segments = this.points.length - 1,
      position = fraction * segments;
    let index = truncateSplineInteger(Math.floor(position));
    if (index < 0) index = 0;
    else if (index >= segments) index = segments - 1;
    const remainder = position - index;
    return (
      ((remainder * this.cubic[index]! + this.quadratic[index]!) * remainder +
        this.linear[index]!) *
        remainder +
      this.points[index]!
    );
  }
}
