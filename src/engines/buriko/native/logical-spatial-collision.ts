import {nativeSpatialAngle, nativeSpatialSineCosine} from '../bp/opcodes/native-math.js';
import {burikoRosettaSseReciprocal} from './cpu-numerical-profile.js';
import {pointerView} from '../bp/memory.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoLogicalSpatialManager} from './logical-spatial.js';

const f32 = Math.fround;
interface ProjectedSegment {
  origin: number[];
  delta: number[];
  square: number;
  inverse: number;
}

function segment(
  source: readonly number[],
  target: readonly number[],
  radius: number,
  angle: number,
  secondAxis: 1 | 2,
): ProjectedSegment {
  const trig = nativeSpatialSineCosine(angle);
  const offset =
    secondAxis === 1
      ? [f32(trig.cosine), f32(trig.sine), 0, 0]
      : [f32(trig.cosine), 0, f32(trig.sine), 0];
  const origin = source.map((value, lane) => f32(value + f32(offset[lane]! * radius)));
  const delta = target.map((value, lane) =>
    f32(f32(value + f32(offset[lane]! * radius)) - origin[lane]!),
  );
  const square = f32(f32(delta[0]! * delta[0]!) + f32(delta[secondAxis]! * delta[secondAxis]!));
  // A zero projected length reaches RCPSS here. Its +Infinity seed produces NaN
  // in the native Newton sequence; later COMISS branches retain that behavior.
  const seed = square === 0 ? Infinity : burikoRosettaSseReciprocal(square);
  const inverse = f32(f32(seed + seed) - f32(square * f32(seed * seed)));
  return {origin, delta, square, inverse};
}

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  const x = f32(a[0]! - b[0]!),
    y = f32(a[1]! - b[1]!),
    z = f32(a[2]! - b[2]!);
  return f32(f32(x * x) + f32(f32(y * y) + f32(z * z)));
}

function write(output: BurikoBpPointer, index: number, value: number): void {
  pointerView({bytes: output.bytes, offset: output.offset + index * 4}, 4).setUint32(
    0,
    value,
    true,
  );
}

/** The four stack scratch values are not initialized before the candidate loop. */
function scratchValue(values: (number | undefined)[], index: number): number {
  const value = values[index];
  if (value === undefined)
    throw new Error('Buriko native collision reads uninitialized projected-distance scratch');
  return value;
}

/** 1400a1ea0 retains the native two projected-plane checks and its null-count result bug. */
export class BurikoLogicalSpatialCollision {
  constructor(readonly manager: BurikoLogicalSpatialManager) {}

  collect(
    output: BurikoBpPointer | null,
    count: BurikoBpPointer | null,
    source: readonly number[],
    target: readonly number[],
    radius: number,
    priority: number,
    exclude: number,
    mask: number,
    checkSegment: number,
  ): 0 | 1 {
    if (source.every((value, lane) => value === target[lane])) return 1;
    if ((mask & 255) === 0) mask |= 255;
    const dx = f32(target[0]! - source[0]!);
    const angleXY = nativeSpatialAngle(f32(target[1]! - source[1]!), dx) + Math.PI / 2;
    const angleXZ = nativeSpatialAngle(f32(target[2]! - source[2]!), dx) + Math.PI / 2;
    const xy = [segment(source, target, radius, angleXY + 0, 1)];
    const xz = [segment(source, target, radius, angleXZ + 0, 2)];
    xy.push(segment(source, target, radius, angleXY + Math.PI, 1));
    xz.push(segment(source, target, radius, angleXZ + Math.PI, 2));
    const scratch: [(number | undefined)[], (number | undefined)[]] = [[], []];
    let hits = 0;
    for (let index = 0; index < this.manager.capacity; index++) {
      const record = this.manager.record(index);
      if (record === undefined || index === exclude >>> 0) continue;
      const recordMask = record.view.getUint32(16, true);
      if ((recordMask & mask & 255) === 0) continue;
      // Unlike sphere overlap, this collector requires both sides untagged
      // when neither 100 nor 200 matches.
      if ((recordMask & mask & 0x300) === 0 && ((recordMask | mask) & 0x300) !== 0) continue;
      const point = [0, 1, 2, 3].map((lane) => record.view.getFloat32(0x50 + lane * 4, true));
      const candidateRadius = record.view.getFloat32(4, true);
      const combined = f32(radius + candidateRadius),
        combinedSquare = f32(combined * combined);
      const sourceSquare = squaredDistance(source, point),
        targetSquare = squaredDistance(target, point);
      let collision = false;
      if (combinedSquare > targetSquare) {
        collision =
          combinedSquare <= sourceSquare || (priority | 0) <= record.view.getInt32(20, true);
      } else if (sourceSquare >= combinedSquare && (checkSegment | 0) !== 0) {
        const flags = [false, false];
        for (let side = 0; side < 2; side++) {
          for (let plane = 0; plane < 2; plane++) {
            if (flags[plane]) continue;
            const projected = (plane === 0 ? xy : xz)[side]!,
              other = plane + 1;
            const x = f32(point[0]! - projected.origin[0]!),
              y = f32(point[other]! - projected.origin[other]!);
            const dot = f32(f32(projected.delta[0]! * x) + f32(projected.delta[other]! * y));
            if (!(dot > 0 && projected.square > dot)) continue;
            const perpendicular = f32(
              f32(f32(x * x) + f32(y * y)) - f32(f32(dot * projected.inverse) * dot),
            );
            if (f32(candidateRadius * candidateRadius) > perpendicular) flags[plane] = true;
            else scratch[plane]![side] = perpendicular;
          }
          if (flags[0] && flags[1]) break;
        }
        if (!(flags[0] && flags[1])) {
          const diameter = f32(radius + radius),
            diameterSquare = f32(diameter * diameter);
          for (let plane = 0; plane < 2; plane++) {
            if (!flags[plane])
              flags[plane] =
                diameterSquare > scratchValue(scratch[plane]!, 0) &&
                diameterSquare > scratchValue(scratch[plane]!, 1);
          }
        }
        collision = flags[0]! && flags[1]!;
      }
      if (!collision) continue;
      // 247A jumps past INC R14D when count is null, so the return remains 1.
      if (count === null) break;
      if (output !== null) write(output, hits, index);
      hits++;
    }
    // A zero-hit result does not initialize the caller's count.
    if (hits !== 0 && count !== null) write(count, 0, hits);
    return hits === 0 ? 1 : 0;
  }

  queryRecord(
    output: BurikoBpPointer | null,
    count: BurikoBpPointer | null,
    index: number,
    x: number,
    y: number,
    z: number,
    mask: number,
    checkSegment: number,
    translateBoolean: boolean,
  ): number {
    const record = this.manager.record(index);
    if (record === undefined) return 0xa0000001;
    const source = [0, 1, 2, 3].map((lane) => record.view.getFloat32(0x50 + lane * 4, true));
    const result = this.collect(
      output,
      count,
      source,
      [x, y, z, 0],
      record.view.getFloat32(4, true),
      record.view.getInt32(20, true),
      index,
      mask,
      checkSegment,
    );
    return translateBoolean ? (result === 1 ? 0 : 0xa0000004) : result;
  }
}
