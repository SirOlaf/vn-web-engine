import {pointerView} from '../bp/memory.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {nativeQuickSort} from './record-sort.js';

export function gridOutput(output: AokanaBpPointer | null, value: number, offset = 0): void {
  if (output === null) throw new Error('Aokana logical-grid null output');
  pointerView({bytes: output.bytes, offset: output.offset + offset}, 4).setInt32(0, value, true);
}

export function gridAllocation(
  width: number,
  height: number,
  stride: number,
  unsigned = false,
): Uint8Array {
  const count = unsigned ? Math.imul(width, height) >>> 0 : Math.imul(width, height);
  if (count < 0) throw new Error('Aokana logical-grid native allocation size overflow');
  return new Uint8Array(count * stride);
}

export function gridCopy(output: AokanaBpPointer | null, bytes: Uint8Array): void {
  if (bytes.length === 0) return;
  if (output === null) throw new Error('Aokana logical-grid null copy destination');
  pointerView(output, bytes.length);
  output.bytes.set(bytes, output.offset);
}

export function gridRead(source: AokanaBpPointer | null, size: number): Uint8Array {
  if (size === 0) return new Uint8Array();
  if (source === null) throw new Error('Aokana logical-grid null copy source');
  pointerView(source, size);
  return source.bytes.slice(source.offset, source.offset + size);
}

export function gridAbsolute(value: number): number {
  value |= 0;
  const sign = value >> 31;
  return ((value ^ sign) - sign) | 0;
}

type PathJob = {
  x: number;
  y: number;
  direction: number;
  height: number;
  steps: number;
  cost: number;
  climb: number;
  turns: number;
  remaining: number;
};

/** DCTELgclGrdFld (1400a0000), with the actual four-direction FIFO expansion. */
export class AokanaLogicalGridPath {
  readonly scale: number;
  width: number | undefined;
  height: number | undefined;
  cells: Uint8Array | null = null;
  results: Uint8Array | null = null;
  private queue: PathJob[] = [];

  constructor(divisor: number) {
    divisor >>>= 0;
    this.scale = Math.trunc(65536 / (divisor === 0 ? 1 : divisor));
  }

  dispose(): void {
    this.queue.length = 0;
    this.cells = this.results = null;
  }

  setCells(width: number, height: number, cells: Uint8Array): number {
    width |= 0;
    height |= 0;
    if (width === 0 || height === 0) return 0x80000001;
    this.cells = this.results = null;
    this.width = width;
    this.height = height;
    this.cells = gridAllocation(width, height, 16, true);
    this.cells.set(cells);
    return 0;
  }

  private index(x: number, y: number): number {
    if (this.width === undefined || this.height === undefined) {
      throw new Error('Aokana logical-grid path reads uninitialized dimensions');
    }
    return (Math.imul(this.width, y) + x) | 0;
  }

  private inside(x: number, y: number): boolean {
    if (this.width === undefined || this.height === undefined) {
      throw new Error('Aokana logical-grid path reads uninitialized dimensions');
    }
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  private cell(index: number): DataView {
    if (this.cells === null) throw new Error('Aokana logical-grid path null cell allocation');
    return pointerView({bytes: this.cells, offset: index * 16}, 16);
  }

  private result(index: number): DataView {
    if (this.results === null) throw new Error('Aokana logical-grid path null result allocation');
    return pointerView({bytes: this.results, offset: index * 24}, 24);
  }

  private enqueue(job: PathJob): number {
    if (!this.inside(job.x, job.y)) return 0x80000005;
    const record = this.result(this.index(job.x, job.y)),
      nextCost = (job.cost + 1) | 0;
    if (
      record.getInt32(0, true) === 0 ||
      nextCost < record.getInt32(12, true) ||
      (nextCost === record.getInt32(12, true) && job.climb < record.getInt32(16, true))
    ) {
      this.queue.push(job);
      return 0;
    }
    return 0x80000006;
  }

  /** 14009fb00 orders up, down, left, right and suppresses immediate backtracking. */
  private expand(
    job: PathJob,
    height: number,
    cost: number,
    climb: number,
    remaining: number,
  ): void {
    const previous = this.result(this.index(job.x, job.y)).getInt32(4, true),
      steps = (job.steps + 1) | 0;
    for (const [dx, dy, direction, opposite] of [
      [0, -1, 3, 2],
      [0, 1, 2, 3],
      [-1, 0, 5, 4],
      [1, 0, 4, 5],
    ]) {
      if (previous === opposite) continue;
      this.enqueue({
        x: (job.x + dx!) | 0,
        y: (job.y + dy!) | 0,
        direction: direction!,
        height,
        steps,
        cost,
        climb,
        turns: (job.turns + Number(previous !== direction)) | 0,
        remaining,
      });
    }
  }

  /** 1400a4960. Candidate cost, accumulated climb and turn count form separate tie levels. */
  private process(
    job: PathJob,
    maximumClimb: number,
    flying: boolean,
    flatCost: boolean,
    stopMask: number,
  ): boolean {
    const index = this.index(job.x, job.y),
      result = this.result(index),
      visited = result.getInt32(0, true),
      oldCost = result.getInt32(12, true),
      oldClimb = result.getInt32(16, true),
      oldTurns = result.getInt32(20, true),
      nextCost = (job.cost + 1) | 0;
    if (visited !== 0 && oldCost <= nextCost) {
      if (nextCost !== oldCost) return false;
      if (oldClimb <= job.climb) {
        if (oldClimb !== job.climb || oldTurns <= job.turns) return false;
      }
    }
    const cell = this.cell(index),
      flags = cell.getUint32(8, true),
      first = job.direction === 1;
    if ((flags & 2) !== 0 || (!flying && ((flags & 12) !== 0 || (!first && (flags & 1) !== 0)))) {
      result.setInt32(0, 1, true);
      return false;
    }
    const surfaceHeight = (cell.getInt32(0, true) + (cell.getUint32(12, true) >>> 28)) | 0,
      previousHeight = first ? surfaceHeight : job.height,
      height = flying ? Math.max(previousHeight, surfaceHeight) : surfaceHeight,
      difference = gridAbsolute((height - previousHeight) | 0);
    if (!first && maximumClimb < difference) return false;
    let increment = 0;
    if (!first) {
      let terrainCost = cell.getInt32(4, true);
      increment = (terrainCost + 1) | 0;
      if (!flatCost && ((!flying && difference >= 2) || (flying && difference >= 4))) {
        if (flying) terrainCost = (terrainCost - 2) | 0;
        increment = (terrainCost + difference) | 0;
      }
    }
    const cost = (job.cost + increment) | 0,
      climb = (job.climb + difference) | 0;
    if (!(
      visited === 0 ||
      cost < oldCost ||
      (cost === oldCost && (climb < oldClimb || (climb === oldClimb && job.turns < oldTurns)))
    ))
      return false;
    const remaining = (job.remaining - increment) | 0;
    if (remaining < 0) return false;
    [1, job.direction, job.steps, cost, climb, job.turns].forEach((value, i) =>
      result.setInt32(i * 4, value, true),
    );
    if ((remaining > 0 && (stopMask & cell.getUint32(12, true)) === 0) || first) {
      this.expand(job, height, cost, climb, remaining);
    }
    return true;
  }

  search(
    x: number,
    y: number,
    masks: readonly number[],
    maximumClimb: number,
    budget: number,
    targetX: number,
    targetY: number,
  ): number {
    if (this.cells === null) return 0x80000002;
    this.results ??= gridAllocation(this.width!, this.height!, 24);
    this.results.fill(0);
    const flags = masks[0]! >>> 0,
      stopMask = (flags & 2) === 0 ? ~masks[1]! & 255 : 0;
    this.queue.length = 0;
    this.enqueue({
      x: x | 0,
      y: y | 0,
      direction: 1,
      height: 0,
      steps: 0,
      cost: 0,
      climb: 0,
      turns: 0,
      remaining: (budget | 0) > 0 ? budget | 0 : 0x7fffffff,
    });
    for (let cursor = 0; cursor < this.queue.length; cursor++) {
      const job = this.queue[cursor]!;
      if (
        this.process(job, maximumClimb | 0, (flags & 1) !== 0, (flags & 4) !== 0, stopMask) &&
        job.x === (targetX | 0) &&
        job.y === (targetY | 0)
      )
        break;
    }
    this.queue.length = 0;
    return 0;
  }

  copyResults(output: AokanaBpPointer | null): number {
    if (this.results === null) return 0x80000003;
    gridCopy(output, this.results);
    return 0;
  }

  copyRoute(
    output: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    x: number,
    y: number,
  ): number {
    if (this.results === null) return 0x80000003;
    x |= 0;
    y |= 0;
    if (!this.inside(x, y)) return 0x80000005;
    let record = this.result(this.index(x, y));
    if (record.getInt32(4, true) === 0) return 0x80000004;
    const steps = record.getInt32(8, true);
    gridOutput(count, steps);
    if (steps > 0 && output !== null) {
      for (let i = steps - 1; i >= 0; i--) {
        record = this.result(this.index(x, y));
        const direction = record.getInt32(4, true),
          reverse =
            direction === 2
              ? 3
              : direction === 3
                ? 2
                : direction === 4
                  ? 5
                  : direction === 5
                    ? 4
                    : direction;
        gridOutput(output, reverse, i * 4);
        if (direction === 2) y = (y - 1) | 0;
        else if (direction === 3) y = (y + 1) | 0;
        else if (direction === 4) x = (x - 1) | 0;
        else if (direction === 5) x = (x + 1) | 0;
        else return 0xfffffffe;
      }
    }
    return 0;
  }

  /** 1400a5090/1400a50f0 preserve the output when a cell has not been reached. */
  copyMetric(output: AokanaBpPointer | null, x: number, y: number, direction: boolean): number {
    if (this.results === null) return 0x80000003;
    if (!this.inside(x | 0, y | 0)) return 0x80000005;
    const record = this.result(this.index(x | 0, y | 0)),
      parent = record.getInt32(4, true);
    if (parent === 0) return 0x80000004;
    const reverse =
      parent === 2 ? 3 : parent === 3 ? 2 : parent === 4 ? 5 : parent === 5 ? 4 : parent;
    gridOutput(output, direction ? reverse : record.getInt32(12, true));
    return 0;
  }

  /** 14009fcc0 writes all six status slots, and only writes coordinates for accepted neighbors. */
  copyNeighbors(
    steps: AokanaBpPointer | null,
    coordinates: AokanaBpPointer | null,
    x: number,
    y: number,
    maximumClimb: number,
  ): number {
    if (this.results === null) return 0x80000003;
    x |= 0;
    y |= 0;
    for (let i = 0; i < 4; i++) {
      const dx = i === 2 ? -1 : i === 3 ? 1 : 0,
        dy = i === 0 ? -1 : i === 1 ? 1 : 0,
        nx = (x + dx) | 0,
        ny = (y + dy) | 0;
      gridOutput(steps, -1, i * 4);
      if (!this.inside(nx, ny)) continue;
      const index = this.index(nx, ny),
        record = this.result(index),
        cell = this.cell(index);
      if (record.getInt32(4, true) === 0 || (cell.getUint32(8, true) & 13) !== 0) continue;
      const difference = gridAbsolute(
        (cell.getInt32(0, true) - this.cell(this.index(x, y)).getInt32(0, true)) | 0,
      );
      if (difference > (maximumClimb | 0)) continue;
      gridOutput(steps, record.getInt32(8, true), i * 4);
      gridOutput(coordinates, nx, i * 8);
      gridOutput(coordinates, ny, i * 8 + 4);
    }
    gridOutput(steps, -1, 16);
    gridOutput(steps, -1, 20);
    return 0;
  }

  /** 1400a5170 applies a forward route's four native direction codes. */
  directionsToCoordinates(
    output: AokanaBpPointer | null,
    directions: AokanaBpPointer | null,
    count: number,
    x: number,
    y: number,
  ): number {
    for (let i = 0; i < (count | 0); i++) {
      if (directions === null) throw new Error('Aokana logical-grid null directions input');
      const direction = pointerView(
        {bytes: directions.bytes, offset: directions.offset + i * 4},
        4,
      ).getInt32(0, true);
      if (direction === 2) y = (y - 1) | 0;
      else if (direction === 3) y = (y + 1) | 0;
      else if (direction === 4) x = (x - 1) | 0;
      else if (direction === 5) x = (x + 1) | 0;
      else return 0x80000007;
      gridOutput(output, x, i * 8);
      gridOutput(output, y, i * 8 + 4);
    }
    return 0;
  }

  /** 1400a4e70: D023 selects row order; the evaluator selects CRT pointer sorting. */
  copyReachable(
    output: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    sort = false,
  ): number {
    if (this.results === null) return 0xffffffff;
    // Native allocates both temporary arrays even when sorting is disabled.
    const records = gridAllocation(this.width!, this.height!, 32);
    gridAllocation(this.width!, this.height!, 8);
    const indices: number[] = [];
    let length = 0;
    for (let y = 0; y < this.height!; y++)
      for (let x = 0; x < this.width!; x++) {
        const index = this.index(x, y);
        if (
          this.result(index).getInt32(12, true) > 0 &&
          (this.cell(index).getUint32(8, true) & 13) === 0
        ) {
          if (sort) {
            gridOutput({bytes: records, offset: length * 32}, x);
            gridOutput({bytes: records, offset: length * 32}, y, 4);
            records.set(this.results.subarray(index * 24, index * 24 + 24), length * 32 + 8);
            indices.push(length);
          } else {
            gridOutput(output, x, length * 8);
            gridOutput(output, y, length * 8 + 4);
          }
          length = (length + 1) | 0;
        }
      }
    if (sort && length !== 0) {
      const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
      nativeQuickSort(
        length,
        (a, b) =>
          (view.getInt32(indices[a]! * 32 + 20, true) -
            view.getInt32(indices[b]! * 32 + 20, true)) |
          0,
        (a, b) => {
          const old = indices[a]!;
          indices[a] = indices[b]!;
          indices[b] = old;
        },
      );
      for (let i = 0; i < length; i++) {
        const offset = indices[i]! * 32;
        gridOutput(output, view.getInt32(offset, true), i * 8);
        gridOutput(output, view.getInt32(offset + 4, true), i * 8 + 4);
      }
    }
    gridOutput(count, length);
    return 0;
  }
}
