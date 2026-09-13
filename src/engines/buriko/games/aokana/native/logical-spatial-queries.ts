import {fixedResult} from '../bp/opcodes/fixed.js';
import {pointerView} from '../bp/memory.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {aokanaRosettaSseReciprocalSqrt} from './cpu-numerical-profile.js';
import type {AokanaLogicalSpatialManager, AokanaLogicalSpatialRecord} from './logical-spatial.js';

const f32 = Math.fround;

function word(output: AokanaBpPointer | null, offset: number, value: number): void {
  if (output === null) throw new Error('Aokana logical-space null query output');
  pointerView({bytes: output.bytes, offset: output.offset + offset}, 4).setUint32(0, value, true);
}

function position(record: AokanaLogicalSpatialRecord): number[] {
  return [0, 1, 2, 3].map((lane) => record.view.getFloat32(0x50 + lane * 4, true));
}

/** 140006950: three-component squared length, with the native SSE seed/refinement. */
function relativeVector(source: readonly number[], target: readonly number[]): number[] {
  const x = f32(target[0]! - source[0]!),
    y = f32(target[1]! - source[1]!),
    z = f32(target[2]! - source[2]!);
  const square = f32(f32(x * x) + f32(f32(y * y) + f32(z * z)));
  if (!(square > 0)) return [0, 0, 0, 0];
  const seed = aokanaRosettaSseReciprocalSqrt(square);
  const correction = f32(f32(f32(f32(square * seed) * seed) * seed) * -0.5);
  const inverse = f32(f32(seed * 1.5) + correction);
  return [f32(inverse * x), f32(inverse * y), f32(inverse * z), f32(square * inverse)];
}

function vectorOutput(output: AokanaBpPointer | null, offset: number, values: number[]): void {
  const fixed = values.map(fixedResult);
  if (output === null) throw new Error('Aokana logical-space null query output');
  const view = pointerView({bytes: output.bytes, offset: output.offset + offset}, 16);
  for (let lane = 0; lane < 4; lane++) view.setInt32(lane * 4, fixed[lane]!, true);
}

/** Complete direct spatial queries, separate from the native route-search machinery. */
export class AokanaLogicalSpatialQueries {
  constructor(readonly manager: AokanaLogicalSpatialManager) {}

  /** 1400a26e0: source validation precedes target validation and the first output store. */
  relativeToRecord(
    output: AokanaBpPointer | null,
    sourceIndex: number,
    targetIndex: number,
  ): number {
    const source = this.manager.record(sourceIndex);
    if (source === undefined) return 0xa0000001;
    const target = this.manager.record(targetIndex);
    if (target === undefined) return 0xa0000002;
    word(output, 0, targetIndex);
    vectorOutput(output, 4, relativeVector(position(source), position(target)));
    return 0;
  }

  /** 1400a2580 inlines the same arithmetic as 140006950. */
  relativeToPosition(
    output: AokanaBpPointer | null,
    sourceIndex: number,
    x: number,
    y: number,
    z: number,
  ): number {
    const source = this.manager.record(sourceIndex);
    if (source === undefined) return 0xa0000001;
    word(output, 0, 0xffffffff);
    vectorOutput(output, 4, relativeVector(position(source), [x, y, z, 0]));
    return 0;
  }

  /** 1400a27e0 inserts after every existing distance <= the new distance. */
  neighbors(
    output: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    sourceIndex: number,
    mask: number,
  ): number {
    const source = this.manager.record(sourceIndex);
    if (source === undefined) return 0xa0000001;
    mask = mask & 255 || 255;
    const entries: {index: number; vector: number[]}[] = [];
    for (let index = 0; index < this.manager.capacity; index++) {
      const record = this.manager.record(index);
      if (record === undefined || index === sourceIndex >>> 0) continue;
      if ((record.view.getUint8(16) & mask) === 0) continue;
      const vector = relativeVector(position(source), position(record));
      let insertion = 0;
      while (insertion < entries.length && entries[insertion]!.vector[3]! <= vector[3]!)
        insertion++;
      entries.splice(insertion, 0, {index, vector});
    }
    for (let entry = 0; entry < entries.length; entry++) {
      word(output, entry * 20, entries[entry]!.index);
      vectorOutput(output, entry * 20 + 4, entries[entry]!.vector);
    }
    word(count, 0, entries.length);
    return 0;
  }

  /** 1400a2ac0 uses position + derived offset and scalar +0C, not base radius +04. */
  overlapsAtRecord(
    output: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    sourceIndex: number,
    mask: number,
  ): number {
    const source = this.manager.record(sourceIndex);
    if (source === undefined) return 0xa0000001;
    const point = position(source).map((value, lane) =>
      f32(value + source.view.getFloat32(0x70 + lane * 4, true)),
    );
    return this.overlaps(output, count, point, source.view.getFloat32(12, true), sourceIndex, mask);
  }

  /** 1400a1d70: ascending IDs, strict sphere overlap and asymmetric category filtering. */
  overlaps(
    output: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    point: readonly number[],
    radius: number,
    exclude: number,
    mask: number,
  ): number {
    if ((mask & 255) === 0) mask |= 255;
    let copied = 0;
    for (let index = 0; index < this.manager.capacity; index++) {
      const record = this.manager.record(index);
      if (record === undefined || index === exclude >>> 0) continue;
      const recordMask = record.view.getUint32(16, true);
      if ((recordMask & mask & 255) === 0) continue;
      if ((recordMask & 0x300) !== 0 && (recordMask & mask & 0x300) === 0) continue;
      const x = f32(point[0]! - record.view.getFloat32(0x50, true)),
        y = f32(point[1]! - record.view.getFloat32(0x54, true)),
        z = f32(point[2]! - record.view.getFloat32(0x58, true));
      const sum = f32(radius + record.view.getFloat32(4, true));
      const square = f32(f32(x * x) + f32(f32(y * y) + f32(z * z)));
      if (f32(sum * sum) > square) word(output, copied++ * 4, index);
    }
    word(count, 0, copied);
    return 0;
  }
}
