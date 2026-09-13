import {pointerView} from '../bp/memory.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {gridAllocation, gridCopy, gridRead} from './logical-grid-path.js';
import {buildGridAbilityMaps} from './logical-grid-derived.js';
import {gridEvaluatorAbilityRequest} from './grid-evaluator-math.js';
import type {AokanaLogicalGridManager} from './logical-grid.js';

/** One native 0x968-byte actor: 0x834 script bytes, scalar caches, then 34 map pointers. */
export class AokanaGridEvaluatorRecord {
  readonly bytes = new Uint8Array(0x968);
  readonly maps: (Uint8Array | null)[] = Array(34).fill(null);
  private readonly view = new DataView(this.bytes.buffer);

  pointer(offset = 0): AokanaBpPointer {
    return {bytes: this.bytes, offset};
  }
  word(index: number): number {
    const offset = index * 4;
    if (offset >= 0x858 && offset < 0x968)
      throw new Error('Aokana grid evaluator reads a native map pointer as an integer');
    return this.view.getInt32(offset, true);
  }
  setWord(index: number, value: number): void {
    const offset = index * 4;
    if (offset >= 0x858 && offset < 0x968)
      throw new Error('Aokana grid evaluator overwrites a native map pointer as an integer');
    this.view.setInt32(offset, value, true);
  }
  get id(): number {
    return this.word(0) >>> 0;
  }
  get x(): number {
    return this.word(0x20d);
  }
  get y(): number {
    return this.word(0x20e);
  }
  copy(): AokanaGridEvaluatorRecord {
    const result = new AokanaGridEvaluatorRecord();
    result.bytes.set(this.bytes);
    result.maps.splice(0, result.maps.length, ...this.maps);
    return result;
  }
  disposeMaps(): void {
    this.maps.fill(null);
  }
  map(ability: number, extended: boolean): Uint8Array | null {
    const index = ability * 2 + Number(extended);
    if (index < 0 || index >= this.maps.length)
      throw new Error('Aokana grid evaluator map pointer address outside actor');
    return this.maps[index]!;
  }
}

/** 1400a8df0/1400a8d90/1400a8a70 own copied grid state and precomputed actor maps. */
export class AokanaGridEvaluatorRecords {
  grid: AokanaLogicalGridManager | null = null;
  readonly records: AokanaGridEvaluatorRecord[] = [];
  typeCount: number | undefined;
  readonly weights = [0x18000, 0x10000, 0xab85];
  facingMultiplier = 2;
  fallbackMovedPercent = 50;
  fallbackAttackPercent = 67;

  setTypeCount(value: number): number {
    if ((value | 0) <= 0) return 0x90000002;
    this.typeCount = value | 0;
    return 0;
  }
  requireGrid(): AokanaLogicalGridManager {
    if (this.grid === null) throw new Error('Aokana grid evaluator null copied grid');
    return this.grid;
  }
  record(index: number): AokanaGridEvaluatorRecord {
    const record = this.records[index];
    if (record === undefined)
      throw new Error('Aokana grid evaluator actor address outside allocation');
    return record;
  }
  replaceGrid(grid: AokanaLogicalGridManager | null): number {
    this.grid?.dispose();
    this.grid = grid?.clone() ?? null;
    return 0;
  }
  clear(): void {
    this.grid?.dispose();
    this.grid = null;
    for (const record of this.records) record.disposeMaps();
    this.records.length = 0;
  }
  initialize(
    grid: AokanaLogicalGridManager | null,
    count: number,
    input: AokanaBpPointer | null,
  ): number {
    if (grid === null) {
      this.clear();
      return 0;
    }
    count >>>= 0;
    if ((count - 1) >>> 0 >= 64) return 0x90000002;
    this.clear();
    this.replaceGrid(grid);
    for (let i = 0; i < count; i++) this.records.push(new AokanaGridEvaluatorRecord());
    for (let i = 0; i < count; i++)
      this.update(
        i,
        input === null ? null : {bytes: input.bytes, offset: input.offset + i * 0x834},
        1,
      );
    return 0;
  }
  copyRecord(output: AokanaBpPointer | null, index: number): number {
    if (index >>> 0 >= this.records.length) return 0x90000003;
    gridCopy(output, this.records[index >>> 0]!.bytes.subarray(0, 0x834));
    return 0;
  }
  update(index: number, input: AokanaBpPointer | null, recompute: number): number {
    index >>>= 0;
    if (index >= this.records.length) return 0x90000003;
    const record = this.records[index]!;
    record.bytes.set(gridRead(input, 0x834));
    if (input === null) throw new Error('Aokana grid evaluator null actor source');
    const id = pointerView(input, 4).getUint32(0, true);
    if (id === 0) {
      record.setWord(0x20d, -1);
      record.setWord(0x20e, -1);
      return 0;
    }
    const grid = this.requireGrid(),
      temporary = new Uint8Array(32),
      pointer = {bytes: temporary, offset: 0};
    grid.copyPosition(record.pointer(0x834), id);
    if (grid.copyDirection(pointer, id) !== 0)
      throw new Error('Aokana grid evaluator reads uninitialized agent direction');
    record.setWord(0x20f, new DataView(temporary.buffer).getInt32(0, true) - 2);
    if (recompute === 0) return 0;
    if (grid.cells === null)
      throw new Error('Aokana grid evaluator reads uninitialized grid dimensions');
    const {width, height} = grid.dimensions(),
      requests = new Uint8Array(352);
    let requestCount = 1;
    gridEvaluatorAbilityRequest({bytes: requests, offset: 0}, input, 0);
    for (let ability = 1; ability <= 16; ability++) {
      if (
        gridEvaluatorAbilityRequest(
          {bytes: requests, offset: requestCount * 20},
          input,
          ability,
        ) === 0
      )
        requestCount++;
    }
    buildGridAbilityMaps(
      grid,
      id,
      record.word(0x8d),
      record.word(0x8e),
      requestCount,
      {bytes: requests, offset: 0},
      0,
      1,
    );
    record.maps[0] = null;
    record.maps[0] = gridAllocation(width, height, 28);
    record.maps[1] = null;
    if (
      grid.copyAbilityMap(
        {bytes: record.maps[0], offset: 0},
        id,
        {bytes: requests, offset: 0},
        0,
      ) === 0
    ) {
      record.maps[1] = gridAllocation(width, height, 28);
      grid.copyAbilityMap({bytes: record.maps[1], offset: 0}, id, {bytes: requests, offset: 0}, 1);
    } else record.maps[0] = null;
    for (let ability = 1; ability <= 16; ability++) {
      record.maps[ability * 2] = record.maps[ability * 2 + 1] = null;
      if (gridEvaluatorAbilityRequest(pointer, input, ability) !== 0) continue;
      const ordinary = gridAllocation(width, height, 28);
      if (grid.copyAbilityMap({bytes: ordinary, offset: 0}, id, pointer, 0) !== 0) continue;
      record.maps[ability * 2] = ordinary;
      const extended = gridAllocation(width, height, 28);
      if (grid.copyAbilityMap({bytes: extended, offset: 0}, id, pointer, 1) === 0)
        record.maps[ability * 2 + 1] = extended;
    }
    return 0;
  }

  findId(record: AokanaGridEvaluatorRecord, records = this.records): number {
    return records.findIndex((entry) => entry.id !== 0 && entry.id === record.id);
  }
  findPosition(x: number, y: number, records = this.records): AokanaGridEvaluatorRecord | null {
    return records.find((entry) => entry.x === (x | 0) && entry.y === (y | 0)) ?? null;
  }
}
