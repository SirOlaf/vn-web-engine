import {burikoBitmapRectangle, cropBurikoBitmap, type BurikoBitmap} from './bitmap.js';
import type {BurikoDistributedProcessing} from './distributed-processing.js';

export interface BurikoBitmapStripPlan {
  count: number;
  increment: number;
}

export type BurikoBitmapOperationPoint = readonly [number, number];

export interface BurikoBitmapMeshOperationStrip<Record> {
  readonly records: readonly Record[];
  readonly firstRow: number;
}

/** 052ba0 advances one wrapping Q16 accumulator and stores its signed integer part. */
export function burikoBitmapOperationScalars(
  initial: number,
  plan: BurikoBitmapStripPlan,
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
export function burikoBitmapOperationPoints(
  point: BurikoBitmapOperationPoint,
  plan: BurikoBitmapStripPlan,
): BurikoBitmapOperationPoint[] {
  const points: BurikoBitmapOperationPoint[] = [];
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
export function burikoBitmapStripPlan(
  processing: BurikoDistributedProcessing | null,
  reference: BurikoBitmap,
  axis: 0 | 1,
): BurikoBitmapStripPlan | null {
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
export function burikoBitmapOperationStrips(
  bitmaps: readonly BurikoBitmap[],
  plan: BurikoBitmapStripPlan,
  axis: 0 | 1,
): BurikoBitmap[][] {
  const jobs: BurikoBitmap[][] = [];
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

/** 052BD0 intersects mesh records with each real mode-four destination strip. */
export function burikoBitmapMeshOperationStrips<Record>(
  records: readonly Record[],
  firstRow: number,
  jobs: readonly BurikoBitmap[][],
): BurikoBitmapMeshOperationStrip<Record>[] {
  const result: BurikoBitmapMeshOperationStrip<Record>[] = [];
  let record = 0,
    remaining = records.length | 0,
    row = firstRow | 0;
  for (const job of jobs) {
    const bitmap = job[0];
    if (bitmap === undefined)
      throw new Error('Buriko mesh operation strip has no destination descriptor');
    const height = bitmap.height | 0,
      blank = height <= row ? height : row,
      available = (height - blank) | 0,
      count = available <= remaining ? available : remaining;
    result.push({
      records: count < 1 ? [] : records.slice(record, record + count),
      firstRow: row,
    });
    if (count >= 1) record += count;
    remaining = (remaining - count) | 0;
    row = (row - blank) | 0;
  }
  return result;
}

/** The common 054390 preparation and 052b00 claim use one attached processing object. */
function runBitmapOperation<Auxiliary>(
  processing: BurikoDistributedProcessing | null,
  bitmaps: readonly BurikoBitmap[],
  reference: BurikoBitmap,
  axis: 0 | 1,
  callback: (bitmaps: readonly BurikoBitmap[], auxiliary: Auxiliary | null) => void,
  prepareAuxiliary: (
    plan: BurikoBitmapStripPlan,
    jobs: readonly BurikoBitmap[][],
  ) => Auxiliary[] | null,
): boolean {
  const clipped = {...reference};
  for (const bitmap of bitmaps) cropBurikoBitmap(clipped, burikoBitmapRectangle(bitmap));
  const plan = burikoBitmapStripPlan(processing, clipped, axis);
  if (plan === null || processing === null) return false;
  const jobs = burikoBitmapOperationStrips(bitmaps, plan, axis);
  const auxiliary = prepareAuxiliary(plan, jobs);
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
export function runBurikoBitmapOperation(
  processing: BurikoDistributedProcessing | null,
  bitmaps: readonly BurikoBitmap[],
  reference: BurikoBitmap,
  axis: 0 | 1,
  callback: (bitmaps: readonly BurikoBitmap[], point: BurikoBitmapOperationPoint | null) => void,
  point: BurikoBitmapOperationPoint | null = null,
): boolean {
  return runBitmapOperation(processing, bitmaps, reference, axis, callback, (plan) =>
    point === null ? null : burikoBitmapOperationPoints(point, plan),
  );
}

/** 054390 mode four partitions only the destination and carries 052BD0 mesh metadata. */
export function runBurikoBitmapMeshOperation<Record>(
  processing: BurikoDistributedProcessing | null,
  destination: BurikoBitmap,
  records: readonly Record[],
  firstRow: number,
  callback: (destination: BurikoBitmap, strip: BurikoBitmapMeshOperationStrip<Record>) => void,
): boolean {
  return runBitmapOperation<BurikoBitmapMeshOperationStrip<Record>>(
    processing,
    [destination],
    destination,
    0,
    (bitmaps, strip) => {
      const output = bitmaps[0];
      if (output === undefined || strip === null)
        throw new Error('Buriko mesh worker is missing its native mode-four metadata');
      callback(output, strip);
    },
    (_plan, jobs) => burikoBitmapMeshOperationStrips(records, firstRow, jobs),
  );
}

/** 054390 mode 5 supplies the actual 053e80 wave callback's signed row displacement. */
export function runBurikoBitmapScalarOperation(
  processing: BurikoDistributedProcessing | null,
  bitmaps: readonly BurikoBitmap[],
  reference: BurikoBitmap,
  axis: 0 | 1,
  callback: (bitmaps: readonly BurikoBitmap[], scalar: number | null) => void,
  initial: number,
): boolean {
  return runBitmapOperation(processing, bitmaps, reference, axis, callback, (plan) =>
    burikoBitmapOperationScalars(initial, plan),
  );
}

/** 052D10 mode one: source bounds follow each completed signed Q16 row extent. */
export function runBurikoBitmapRectangleOperation(
  processing: BurikoDistributedProcessing | null,
  bitmaps: readonly BurikoBitmap[],
  reference: BurikoBitmap,
  rectangle: import('./bitmap.js').BurikoBitmapRectangle,
  callback: (
    bitmaps: readonly BurikoBitmap[],
    bounds: import('./bitmap.js').BurikoBitmapRectangle,
  ) => void,
): boolean {
  return runBitmapOperation<import('./bitmap.js').BurikoBitmapRectangle>(
    processing,
    bitmaps,
    reference,
    0,
    (parts, bounds) => {
      if (bounds === null) throw new Error('Buriko vector worker consumes missing source bounds');
      callback(parts, bounds);
    },
    (plan) => {
      const bounds = {...rectangle},
        result = [];
      let fraction = 0;
      for (let index = 0; index < plan.count; index++) {
        result.push({...bounds});
        const next = (fraction + plan.increment) | 0,
          rows = next >> 16;
        bounds.top = (bounds.top - rows) | 0;
        bounds.bottom = (bounds.bottom - rows) | 0;
        fraction = next & 0xffff;
      }
      return result;
    },
  );
}

/** 052C60/0541E0 mode three carries float pivots and partitions only the destination. */
export function runBurikoBitmapFloatPointOperation(
  processing: BurikoDistributedProcessing | null,
  destination: BurikoBitmap,
  point: readonly [number, number],
  callback: (destination: BurikoBitmap, point: readonly [number, number]) => void,
): boolean {
  return runBitmapOperation<readonly [number, number]>(
    processing,
    [destination],
    destination,
    0,
    (parts, pivot) => {
      if (pivot === null) throw new Error('Buriko float worker consumes missing pivot storage');
      callback(parts[0]!, pivot);
    },
    (plan) => {
      const result: (readonly [number, number])[] = [];
      let y = Math.fround(point[1]),
        fraction = 0;
      for (let index = 0; index < plan.count; index++) {
        const next = (fraction + plan.increment) >>> 0;
        result.push([Math.fround(point[0]), y]);
        y = Math.fround(y - Math.fround(next >>> 16));
        fraction = next & 0xffff;
      }
      return result;
    },
  );
}
