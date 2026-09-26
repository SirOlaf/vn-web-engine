import {fixedResult} from '../bp/opcodes/fixed.js';
import {pointerView} from '../bp/memory.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import {burikoRosettaSseReciprocalSqrt} from './cpu-numerical-profile.js';

const f32 = Math.fround;
export const burikoFixedToFloat = (value: number): number => f32(f32(value | 0) / 65536);

/** 1400314f0 with tolerance 0x38800000; scalar float operations precede inclusive tests. */
function snappedCoordinate(value: number): number {
  const floor = Math.floor(value),
    fraction = f32(value - floor);
  if (f32(1 - 2 ** -14) <= fraction) return Math.ceil(value);
  return fraction <= 2 ** -14 ? floor : value;
}

export class BurikoLogicalSpatialRecord {
  readonly bytes = new Uint8Array(0x80);
  readonly view = new DataView(this.bytes.buffer);
  readonly incoming: [Int32Array, Int32Array] = [new Int32Array(), new Int32Array()];
}

function outputWord(output: BurikoBpPointer | null, value: number): void {
  if (output === null) throw new Error('Buriko logical-space null DWORD output');
  pointerView(output, 4).setUint32(0, value, true);
}

/** D065/67 convert after releasing the manager and write only the first three lanes. */
export function writeBurikoSpatialVector(
  output: BurikoBpPointer | null,
  vector: Float32Array,
): void {
  const values = Array.from(vector, fixedResult);
  if (output === null) throw new Error('Buriko logical-space null vector output');
  const view = pointerView(output, 12);
  for (let lane = 0; lane < 3; lane++) view.setUint32(lane * 4, values[lane]!, true);
}

/** DCTELgclSpcMngr record storage and both native parent/child connection groups. */
export class BurikoLogicalSpatialManager {
  capacity = 64;
  readonly records = new Map<number, BurikoLogicalSpatialRecord>();

  record(index: number): BurikoLogicalSpatialRecord | undefined {
    return index >>> 0 < this.capacity ? this.records.get(index >>> 0) : undefined;
  }

  createRecord(index: number, values: readonly number[], mask: number, flags: number): number {
    index >>>= 0;
    if (index >= 0x1000) return 0xa0000001;
    while (this.capacity <= index) this.capacity *= 2;
    // The native table grows before these value checks.
    if (values[6]! < 1) return 0xa0000002;
    if ((mask & 255) === 0) return 0xa0000003;
    const record = new BurikoLogicalSpatialRecord(),
      view = record.view;
    this.records.set(index, record);
    view.setUint32(0, 1, true);
    view.setFloat32(4, values[6]!, true);
    view.setFloat32(8, values[7]!, true);
    view.setFloat32(12, values[8]!, true);
    view.setUint32(16, mask, true);
    view.setUint32(20, flags, true);
    view.setUint32(32, 0xffffffff, true);
    view.setUint32(36, 0xffffffff, true);
    this.setPosition(index, values[0]!, values[1]!, values[2]!);
    // Creation ignores a zero-direction failure and still returns success.
    this.setDirection(index, values[3]!, values[4]!, values[5]!);
    return 0;
  }

  removeRecord(index: number): number {
    const record = this.record(index);
    if (record === undefined) return 0xa0000001;
    for (let group = 0; group < 2; group++) {
      this.setParent(index, group, 0xffffffff);
      const incoming = record.incoming[group]!;
      for (let slot = 0; slot < incoming.length; slot++) {
        const child = incoming[slot]!;
        if (child !== -1) this.setParent(child, group, 0xffffffff);
      }
    }
    this.records.delete(index >>> 0);
    return 0;
  }

  setProperty(index: number, property: number, value: number): number {
    const record = this.record(index);
    if (record === undefined) return 0xa0000001;
    property >>>= 0;
    if (property > 6) return 0xa0000002;
    if (property === 3 || property === 4) record.view.setUint32(4 + property * 4, value, true);
    else record.view.setFloat32(4 + property * 4, burikoFixedToFloat(value), true);
    return 0;
  }

  getProperty(output: BurikoBpPointer | null, index: number, property: number): number {
    const record = this.record(index);
    if (record === undefined) return 0xa0000001;
    property >>>= 0;
    if (property > 6) return 0xa0000002;
    const value =
      property === 3 || property === 4
        ? record.view.getUint32(4 + property * 4, true)
        : fixedResult(record.view.getFloat32(4 + property * 4, true));
    outputWord(output, value);
    return 0;
  }

  setPosition(index: number, x: number, y: number, z: number): number {
    const record = this.record(index);
    if (record === undefined) return 0xa0000001;
    [x, y, z, 0].forEach((value, lane) =>
      record.view.setFloat32(0x50 + lane * 4, snappedCoordinate(value), true),
    );
    return 0;
  }

  setDirection(index: number, x: number, y: number, z: number): number {
    const record = this.record(index);
    if (record === undefined) return 0xa0000001;
    const values = [x, y, z].map(snappedCoordinate);
    const [a, b, c] = values as [number, number, number];
    const square = f32(f32(a * a) + f32(f32(b * b) + f32(c * c)));
    if (!(square > 0)) return 0xa0000002;
    const seed = burikoRosettaSseReciprocalSqrt(square);
    const inverse = f32(f32(seed * 1.5) + f32(f32(f32(f32(square * seed) * seed) * seed) * -0.5));
    const multiplier = record.view.getFloat32(8, true);
    [...values, 0].forEach((value, lane) => {
      const normal = f32(inverse * value);
      record.view.setFloat32(0x60 + lane * 4, normal, true);
      record.view.setFloat32(0x70 + lane * 4, f32(multiplier * normal), true);
    });
    return 0;
  }

  vector(index: number, direction: boolean): Float32Array | undefined {
    const record = this.record(index);
    if (record === undefined) return undefined;
    const offset = direction ? 0x60 : 0x50;
    return new Float32Array(
      [0, 1, 2, 3].map((lane) => record.view.getFloat32(offset + lane * 4, true)),
    );
  }

  setParent(index: number, group: number, target: number): number {
    index >>>= 0;
    group >>>= 0;
    target >>>= 0;
    const record = this.record(index);
    if (record === undefined) return 0xa0000001;
    if (group > 1) return 0xa0000005;
    const parentOffset = 0x20 + group * 4;
    if (target === 0xffffffff) {
      const old = record.view.getUint32(parentOffset, true);
      if (old < this.capacity) {
        // Native lookup is by table address, even if the old target has been replaced.
        const incoming = this.records.get(old)?.incoming[group];
        if (incoming !== undefined) {
          const slot = incoming.indexOf(index);
          if (slot !== -1) incoming[slot] = -1;
        }
        record.view.setUint32(parentOffset, 0xffffffff, true);
      }
      return 0;
    }
    const parent = this.record(target);
    if (target === index || parent === undefined) return 0xa0000002;
    this.setParent(index, group, 0xffffffff);
    let incoming = parent.incoming[group]!,
      slot = incoming.indexOf(-1);
    if (slot < 0) {
      slot = incoming.length;
      const grown = new Int32Array(incoming.length === 0 ? 64 : incoming.length * 2).fill(-1);
      grown.set(incoming);
      parent.incoming[group] = incoming = grown;
      parent.view.setUint32(0x28 + group * 16, incoming.length, true);
    }
    incoming[slot] = index;
    record.view.setUint32(parentOffset, target, true);
    return 0;
  }

  getParent(output: BurikoBpPointer | null, index: number, group: number): number {
    const record = this.record(index);
    if (record === undefined) return 0xa0000001;
    if (group >>> 0 > 1) return 0xa0000005;
    outputWord(output, record.view.getUint32(0x20 + group * 4, true));
    return 0;
  }

  copyChildren(
    output: BurikoBpPointer | null,
    count: BurikoBpPointer | null,
    index: number,
    group: number,
  ): number {
    const record = this.record(index);
    if (record === undefined) return 0xa0000001;
    if (group >>> 0 > 1) return 0xa0000005;
    let copied = 0;
    for (const child of record.incoming[group]!) {
      if (child === -1) continue;
      if (output !== null)
        outputWord({bytes: output.bytes, offset: output.offset + copied * 4}, child);
      copied++;
    }
    outputWord(count, copied);
    return 0;
  }
}

interface SpatialHandle {
  id: number;
  references: number;
  manager: BurikoLogicalSpatialManager;
}

/** Native 1400fa650/620 lifetime references and newest-first handle lookup. */
export class BurikoLogicalSpatialManagers {
  private nextId = 0;
  private readonly handles: SpatialHandle[] = [];

  create(output: BurikoBpPointer | null): number {
    this.nextId = (this.nextId + 1) >>> 0;
    this.handles.unshift({
      id: this.nextId,
      references: 0,
      manager: new BurikoLogicalSpatialManager(),
    });
    outputWord(output, this.nextId);
    return 0;
  }

  destroy(id: number): number {
    const index = this.handles.findIndex((handle) => handle.id === id >>> 0);
    if (index < 0) return 1;
    if (this.handles[index]!.references !== 0) return 0x17;
    this.handles.splice(index, 1);
    return 0;
  }

  /** Final registry cleanup through D0:41 semantics; referenced handles stay live. */
  disposeAll(): void {
    const referenced: number[] = [];
    for (const handle of [...this.handles]) {
      const status = this.destroy(handle.id);
      if (status === 0x17) referenced.push(handle.id);
      else if (status !== 0)
        throw new Error(`Buriko logical-space final disposal lost handle ${handle.id}`);
    }
    if (referenced.length !== 0)
      throw new Error(
        `Buriko logical-space final disposal retained referenced handles: ${referenced.join(', ')}`,
      );
  }

  use(id: number, operation: (manager: BurikoLogicalSpatialManager) => number): number {
    const handle = this.handles.find((handle) => handle.id === id >>> 0);
    if (handle === undefined) return 0xa0000000;
    handle.references++;
    // Native faults terminate this call before the explicit release; preserve that state.
    const result = operation(handle.manager);
    handle.references--;
    return result;
  }
}
