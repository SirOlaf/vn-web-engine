import {fixedResult} from '../bp/opcodes/fixed.js';
import {pointerView} from '../bp/memory.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {aokanaRosettaSseReciprocal} from './cpu-numerical-profile.js';
import type {AokanaLogicalSpatialManager} from './logical-spatial.js';

const f32 = Math.fround;
const emptyRecord = new DataView(new ArrayBuffer(0x80));

function reciprocal(value: number): number {
  const seed = value === 0 ? Infinity : aokanaRosettaSseReciprocal(value);
  return f32(f32(seed + seed) - f32(f32(seed * seed) * value));
}

function truncate(value: number): number {
  const result = Math.trunc(value);
  return !Number.isFinite(result) || result < -0x80000000 || result > 0x7fffffff
    ? -0x80000000
    : result;
}

/** Native 1400314f0 / 140031570 with their shared 2^-14 tolerance. */
function snap(value: number, single: boolean): number {
  const floor = Math.floor(value),
    fraction = single ? f32(value - floor) : value - floor;
  if (fraction >= 1 - 2 ** -14) return Math.ceil(value);
  return fraction <= 2 ** -14 ? floor : value;
}

function read(values: Float64Array, index: number): number {
  if (index < 0 || index >= values.length)
    throw new Error('Aokana native spatial-density array access is outside its allocation');
  return values[index]!;
}

/** 1400a33b0 uses signed coordinates/dimensions and signed32 row-major arithmetic. */
function neighbor(
  values: Float64Array,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  if (x < 0 || y < 0 || x >= (width | 0) || y >= (height | 0)) return 0;
  return read(values, (Math.imul(y, width) + x) | 0);
}

function select(values: Float64Array, width: number, height: number): [number, number] | null {
  let found: [number, number] | null = null,
    best = 0,
    bestNeighbors = 0;
  for (let y = 0; y < (height | 0); y++) {
    for (let x = 0; x < (width | 0); x++) {
      const current = snap(read(values, (Math.imul(y, width) + x) >>> 0), false);
      if (!(current > 0) || current < best) continue;
      // Native arguments use x=0 for vertical samples and y=0 for horizontal
      // samples. These are not the four neighbors of the candidate cell.
      const verticalBefore = neighbor(values, 0, y - 1, width, height),
        horizontalBefore = neighbor(values, x - 1, 0, width, height),
        horizontalAfter = neighbor(values, x + 1, 0, width, height),
        verticalAfter = neighbor(values, 0, y + 1, width, height);
      const surrounding = snap(
        verticalAfter + (verticalBefore + horizontalBefore + horizontalAfter),
        false,
      );
      if (current > best || (current === best && surrounding > bestNeighbors)) {
        best = current;
        bestNeighbors = surrounding;
        found = [x, y];
      }
    }
  }
  return found;
}

/** D07B / 1400a33f0: coarse weighted cells followed by optional radial refinement. */
export class AokanaLogicalSpatialDensity {
  constructor(readonly manager: AokanaLogicalSpatialManager) {}

  query(
    output: AokanaBpPointer | null,
    cellSize: number,
    width: number,
    height: number,
    subdivisions: number,
    axis: number,
    exclude: number,
    mask: number,
  ): number {
    cellSize >>>= 0;
    width >>>= 0;
    height >>>= 0;
    subdivisions >>>= 0;
    if ((axis | 0) !== 0) return 0xa0000007;
    if ((mask & 255) === 0) mask |= 255;
    if (cellSize === 0) return 0xa0000008;
    if (width === 0 || height === 0) return 0xa0000009;
    if (subdivisions === 0) return 0xa000000a;
    const coarse = new Float64Array(Math.imul(width, height) >>> 0);
    const size = f32(cellSize),
      halfWidth = f32(f32(f32(width) * size) * 0.5),
      halfHeight = f32(f32(f32(height) * size) * 0.5),
      inverse = reciprocal(size);
    const assignments = new Int32Array(this.manager.capacity).fill(-1);
    for (let index = 0; index < this.manager.capacity; index++) {
      const record = this.manager.record(index);
      if (
        record === undefined ||
        index === exclude >>> 0 ||
        (record.view.getUint8(16) & mask) === 0
      )
        continue;
      const x = truncate(f32(f32(record.view.getFloat32(0x50, true) + halfWidth) * inverse)),
        y = truncate(f32(f32(record.view.getFloat32(0x54, true) + halfHeight) * inverse));
      if (x < 0 || y < 0 || x >= (width | 0) || y >= (height | 0)) continue;
      // PACKSSDW saturates coordinates; PINSRW retains only the signed low word
      // of width before PMADDWD forms the native cell address.
      const cell = (Math.min(x, 32767) + Math.imul(Math.min(y, 32767), (width << 16) >> 16)) | 0;
      coarse[cell] = record.view.getFloat32(0x1c, true) + read(coarse, cell);
      assignments[index] = cell;
    }
    const selected = select(coarse, width, height);
    if (selected === null) return 0xa000000b;
    const step = f32(size / f32(subdivisions)),
      halfStep = f32(step * 0.5);
    const originX = f32(
        snap(f32(f32(Math.imul(selected[0], cellSize)) + halfStep), true) - halfWidth,
      ),
      originY = f32(snap(f32(f32(Math.imul(selected[1], cellSize)) + halfStep), true) - halfHeight);
    let resultX = originX,
      resultY = originY;
    if (subdivisions >= 2) {
      const refined = new Float64Array(Math.imul(subdivisions, subdivisions) >>> 0),
        coarseIndex = (Math.imul(selected[1], width) + selected[0]) | 0;
      for (let index = 0; index < this.manager.capacity; index++) {
        const assignment = assignments[index]!;
        if (
          ![
            coarseIndex,
            (coarseIndex - 1) | 0,
            (coarseIndex + 1) | 0,
            (coarseIndex - width) | 0,
            (coarseIndex + width) | 0,
          ].includes(assignment)
        )
          continue;
        // No activity/exclusion/mask check is repeated here. In particular, -1
        // assignments can match a neighbor of coarse cell0 and read zero records.
        const record = this.manager.record(index)?.view ?? emptyRecord;
        const radius = record.getFloat32(0x18, true),
          weight = record.getFloat32(0x1c, true);
        const bias = f32(weight * f32(0.666667)),
          slope = f32(f32(weight * f32(0.333333)) * reciprocal(radius));
        for (let y = 0; y < (subdivisions | 0); y++) {
          let sampleX = f32(originX + 0);
          const sampleY = f32(f32(f32(y) * step) + originY);
          for (let x = 0; x < (subdivisions | 0); x++) {
            const dx = f32(record.getFloat32(0x50, true) - sampleX),
              dy = f32(record.getFloat32(0x54, true) - sampleY),
              distance = f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));
            if (radius >= distance) {
              const cell = (Math.imul(y, subdivisions) + x) >>> 0;
              const contribution = f32(f32(f32(radius - distance) * slope) + bias);
              refined[cell] = contribution + read(refined, cell);
            }
            sampleX = f32(sampleX + step);
          }
        }
      }
      const refinedSelection = select(refined, subdivisions, subdivisions);
      if (refinedSelection === null) return 0xa000000b;
      resultX = snap(f32(f32(f32(refinedSelection[0]) * step) + originX), true);
      resultY = snap(f32(f32(f32(refinedSelection[1]) * step) + originY), true);
    }
    const values = [resultX, resultY, 0, 0].map(fixedResult);
    if (output === null) throw new Error('Aokana spatial-density null vector output');
    const view = pointerView(output, 16);
    for (let lane = 0; lane < 4; lane++) view.setInt32(lane * 4, values[lane]!, true);
    return 0;
  }
}
