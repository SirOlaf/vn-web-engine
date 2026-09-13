import {aokanaBitmapRectangle, cropAokanaBitmap, type AokanaBitmap} from './bitmap.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';

export interface AokanaBitmapStripPlan {
  count: number;
  increment: number;
}

export type AokanaBitmapOperationPoint = readonly [number, number];

/** 052ba0 advances one wrapping Q16 accumulator and stores its signed integer part. */
export function aokanaBitmapOperationScalars(
  initial: number,
  plan: AokanaBitmapStripPlan,
): number[] {
  const scalars: number[] = [];
  let value = initial << 16;
  for (let index = 0; index < plan.count; index++) {
    scalars.push(value >> 16);
    value = (value + plan.increment) | 0;
  }
  return scalars;
}

/** 052cc0 copies the Q16 X coordinate and subtracts each completed row extent from Y. */
export function aokanaBitmapOperationPoints(
  point: AokanaBitmapOperationPoint,
  plan: AokanaBitmapStripPlan,
): AokanaBitmapOperationPoint[] {
  const points: AokanaBitmapOperationPoint[] = [];
  let fraction = 0,
    y = point[1] | 0;
  for (let index = 0; index < plan.count; index++) {
    const next = (fraction + plan.increment) >>> 0;
    points.push([point[0] | 0, y]);
    fraction = next & 65535;
    y = (y - (next & 0xffff0000)) | 0;
  }
  return points;
}

/** 052e80 selects bitmap-operation strips from the actual attached worker count. */
export function aokanaBitmapStripPlan(
  processing: AokanaDistributedProcessing | null,
  reference: AokanaBitmap,
  axis: 0 | 1,
): AokanaBitmapStripPlan | null {
  if (processing === null || Math.imul(reference.width, reference.height) >>> 0 < 0xa00)
    return null;
  let count = processing.capacity;
  if (count < 2) return null;
  const length = (axis === 0 ? reference.height : reference.width) >>> 0;
  const width = (axis === 0 ? reference.width : reference.height) >>> 0;
  let increment = Math.floor(((length << 16) >>> 0) / count) >>> 0;
  let area = Math.imul(Math.floor(length / count), width) >>> 0;
  while (area > 0xa000) {
    count = (count * 2) >>> 0;
    increment >>>= 1;
    area >>>= 1;
  }
  return increment < 0x10000 ? null : {count, increment};
}

/** 052d70 preserves each descriptor's own final-strip extent and stride arithmetic. */
export function aokanaBitmapOperationStrips(
  bitmaps: readonly AokanaBitmap[],
  plan: AokanaBitmapStripPlan,
  axis: 0 | 1,
): AokanaBitmap[][] {
  const jobs: AokanaBitmap[][] = [];
  let fraction = 0,
    offset = 0;
  for (let i = 0; i < plan.count; i++) {
    const next = (fraction + plan.increment) >>> 0,
      extent = next >>> 16;
    jobs.push(
      bitmaps.map((bitmap) => {
        const copy = {...bitmap};
        if (axis === 0) {
          copy.offset += Math.imul(copy.stride, offset);
          copy.height = i + 1 === plan.count ? (copy.height - offset) | 0 : extent;
        } else {
          copy.offset += Math.imul(copy.bytesPerPixel, offset) >>> 0;
          copy.width = i + 1 === plan.count ? (copy.width - offset) | 0 : extent;
        }
        return copy;
      }),
    );
    fraction = next & 65535;
    offset = (offset + extent) >>> 0;
  }
  return jobs;
}

/** The common 054390 preparation and 052b00 claim use one attached processing object. */
function runBitmapOperation<Auxiliary>(
  processing: AokanaDistributedProcessing | null,
  bitmaps: readonly AokanaBitmap[],
  reference: AokanaBitmap,
  axis: 0 | 1,
  callback: (bitmaps: readonly AokanaBitmap[], auxiliary: Auxiliary | null) => void,
  prepareAuxiliary: (plan: AokanaBitmapStripPlan) => Auxiliary[] | null,
): boolean {
  const clipped = {...reference};
  for (const bitmap of bitmaps) cropAokanaBitmap(clipped, aokanaBitmapRectangle(bitmap));
  const plan = aokanaBitmapStripPlan(processing, clipped, axis);
  if (plan === null || processing === null) return false;
  const jobs = aokanaBitmapOperationStrips(bitmaps, plan, axis);
  const auxiliary = prepareAuxiliary(plan);
  let cursor = 0;
  processing.setCallback(() => {
    // 052b00 claims the actual next strip under the attached pool's shared lock.
    const force = processing.enterShared();
    const index = cursor < jobs.length ? cursor++ : -1;
    processing.leaveShared(force);
    if (index === -1) return 0;
    callback(jobs[index]!, auxiliary?.[index] ?? null);
    return 1;
  }, null);
  processing.run(1);
  processing.setCallback(null, null);
  return true;
}

/**
 * 054390's descriptor-only mode (param5=0) and Q16 point mode (param5=2).
 * The latter is used by the actual 053ef0/053f80 affine worker callbacks.
 */
export function runAokanaBitmapOperation(
  processing: AokanaDistributedProcessing | null,
  bitmaps: readonly AokanaBitmap[],
  reference: AokanaBitmap,
  axis: 0 | 1,
  callback: (bitmaps: readonly AokanaBitmap[], point: AokanaBitmapOperationPoint | null) => void,
  point: AokanaBitmapOperationPoint | null = null,
): boolean {
  return runBitmapOperation(processing, bitmaps, reference, axis, callback, (plan) =>
    point === null ? null : aokanaBitmapOperationPoints(point, plan),
  );
}

/** 054390 mode 5 supplies the actual 053e80 wave callback's signed row displacement. */
export function runAokanaBitmapScalarOperation(
  processing: AokanaDistributedProcessing | null,
  bitmaps: readonly AokanaBitmap[],
  reference: AokanaBitmap,
  axis: 0 | 1,
  callback: (bitmaps: readonly AokanaBitmap[], scalar: number | null) => void,
  initial: number,
): boolean {
  return runBitmapOperation(processing, bitmaps, reference, axis, callback, (plan) =>
    aokanaBitmapOperationScalars(initial, plan),
  );
}
