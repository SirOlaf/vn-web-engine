import {AokanaBpHeap} from './memory.js';

export interface AokanaBpModule {
  readonly name: Uint8Array;
  readonly base: number;
  readonly size: number;
}

interface Reservation {
  readonly borrower: AokanaBpThread;
  readonly offset: number;
  readonly size: number;
}

export interface AokanaBpThreadOptions {
  id: number;
  operandCapacity: number;
  moduleCapacity: number;
  frameCapacity: number;
  heapEnabled?: boolean;
  mode?: number;
}

/** Storage of the verified Aokana CThread, independent of scheduler list ownership. */
export class AokanaBpThread {
  readonly id: number;
  operandStack: Uint32Array;
  stackIndex = 0;
  moduleMemory: Uint8Array;
  frameMemory: Uint8Array;
  moduleCapacity: number;
  frameCapacity: number;
  moduleFloor = 0;
  frameFloor = 0;
  moduleUsableCapacity: number;
  frameUsableCapacity: number;
  moduleSize = 0;
  readonly modules: AokanaBpModule[] = [];
  pc = 0;
  instructionStart = 0;
  frameCursor = 0;
  readonly callSites: number[] = [];
  private readonly allocatedHeap: AokanaBpHeap | null;
  readonly mode: number;
  interpreterNumber = -1;
  retentionCount = 0;
  readonly moduleReservations: Reservation[] = [];
  readonly frameReservations: Reservation[] = [];
  disposed = false;

  constructor(options: AokanaBpThreadOptions) {
    for (const capacity of [
      options.operandCapacity,
      options.moduleCapacity,
      options.frameCapacity,
    ]) {
      if (!Number.isInteger(capacity) || capacity < 0 || capacity > 0xffffffff) {
        throw new RangeError('Invalid Aokana thread capacity');
      }
    }
    this.id = options.id >>> 0;
    this.operandStack = new Uint32Array(options.operandCapacity);
    this.moduleCapacity = options.moduleCapacity;
    this.frameCapacity = options.frameCapacity;
    this.moduleUsableCapacity = options.moduleCapacity;
    this.frameUsableCapacity = options.frameCapacity;
    this.moduleMemory = new Uint8Array(options.moduleCapacity);
    this.frameMemory = new Uint8Array(options.frameCapacity);
    this.allocatedHeap = options.heapEnabled === false ? null : new AokanaBpHeap();
    const mode = (options.mode ?? 0) >>> 0;
    this.mode = mode < 2 ? mode : 0;
  }

  get storageOwner(): AokanaBpThread {
    return this;
  }

  get heap(): AokanaBpHeap | null {
    return this.allocatedHeap;
  }

  get sharedInitialized(): boolean {
    return false;
  }

  get sharedOwner(): AokanaBpThread | null {
    return null;
  }

  get frameLimit(): number {
    return (this.frameFloor + this.frameUsableCapacity) >>> 0;
  }

  get moduleLimit(): number {
    return (this.moduleFloor + this.moduleUsableCapacity) >>> 0;
  }

  /** Native destruction releases storage before deleting its pending process and borrowers. */
  disposeStorage(): void {
    this.operandStack = new Uint32Array();
    this.moduleMemory = new Uint8Array();
    this.frameMemory = new Uint8Array();
    this.allocatedHeap?.dispose();
    this.modules.length = 0;
    this.moduleSize = 0;
    this.callSites.length = 0;
    this.disposed = true;
  }
}

/** DCTChildThread shares the owner's original bases and forwards its validation and heap methods. */
export class AokanaBpSharedThread extends AokanaBpThread {
  private owner: AokanaBpThread | null = null;
  private initialized = false;

  constructor(options: {id: number; operandCapacity: number; mode?: number}) {
    super({...options, moduleCapacity: 0, frameCapacity: 0, heapEnabled: false});
  }

  override get sharedInitialized(): boolean {
    return this.initialized;
  }
  override get sharedOwner(): AokanaBpThread | null {
    return this.owner;
  }
  override get storageOwner(): AokanaBpThread {
    if (!this.owner)
      throw new Error('Aokana shared thread has no storage owner before initialization');
    return this.owner;
  }
  override get heap(): AokanaBpHeap | null {
    return this.storageOwner.heap;
  }

  initialize(
    parent: AokanaBpThread,
    moduleSize: number,
    frameSize: number,
    entry: number,
    appendToRoot: (thread: AokanaBpSharedThread) => void,
  ): number {
    if (this.initialized) return 0x80000004;
    const reserved = reserveThreadRegions(parent, this, moduleSize, frameSize);
    if (reserved.result !== 0) return reserved.result;
    this.moduleFloor = this.moduleSize = reserved.moduleOffset!;
    this.moduleCapacity = this.moduleUsableCapacity = moduleSize >>> 0;
    this.moduleMemory = parent.moduleMemory;
    setPc(this, entry);
    this.frameFloor = this.frameCursor = reserved.frameOffset!;
    this.frameCapacity = this.frameUsableCapacity = frameSize >>> 0;
    this.frameMemory = parent.frameMemory;
    this.owner = parent.storageOwner;
    if (this.mode === 0) appendToRoot(this);
    this.initialized = true;
    return 0;
  }

  override disposeStorage(): void {
    if (this.initialized) releaseThreadRegions(this.storageOwner, this);
    super.disposeStorage();
  }
}

export function push32(thread: AokanaBpThread, value: number): void {
  if (thread.stackIndex >= thread.operandStack.length)
    throw new RangeError('Aokana operand stack access outside storage');
  thread.operandStack[thread.stackIndex] = value >>> 0;
  const next = (thread.stackIndex + 1) >>> 0;
  thread.stackIndex = next >= thread.operandStack.length ? 0 : next;
}

export function pop32(thread: AokanaBpThread): number {
  thread.stackIndex =
    (thread.stackIndex === 0 ? thread.operandStack.length - 1 : thread.stackIndex - 1) >>> 0;
  const value = thread.operandStack[thread.stackIndex];
  if (value === undefined) throw new RangeError('Aokana operand stack access outside storage');
  return value;
}

export function setPc(thread: AokanaBpThread, address: number): void {
  thread.pc = thread.instructionStart = address >>> 0;
}

/** The native validator checks allocated code capacity, not attached module length. */
export function validCodeAddress(thread: AokanaBpThread, address: number): boolean {
  thread = thread.storageOwner;
  return address >>> 0 < (thread.moduleFloor + thread.moduleCapacity) >>> 0;
}

export function validFrameAddress(thread: AokanaBpThread, address: number): boolean {
  thread = thread.storageOwner;
  return address >>> 0 < (thread.frameFloor + thread.frameCapacity) >>> 0;
}

export function readFrame32(thread: AokanaBpThread, offset: number): number {
  return new DataView(
    thread.frameMemory.buffer,
    thread.frameMemory.byteOffset,
    thread.frameMemory.byteLength,
  ).getUint32(offset >>> 0, true);
}

export function writeFrame32(thread: AokanaBpThread, offset: number, value: number): void {
  new DataView(
    thread.frameMemory.buffer,
    thread.frameMemory.byteOffset,
    thread.frameMemory.byteLength,
  ).setUint32(offset >>> 0, value, true);
}

function reservationPosition(
  records: readonly Reservation[],
  capacity: number,
  size: number,
): {index: number; top: number} {
  let top = capacity;
  let index = 0;
  while (index < records.length) {
    const record = records[index]!;
    if (top >= (record.offset + record.size + size) >>> 0) break;
    top = record.offset;
    index++;
  }
  return {index, top};
}

/** CThread vtable +0x48: reserve paired regions, newest fitting gap first from the top. */
export function reserveThreadRegions(
  parent: AokanaBpThread,
  borrower: AokanaBpThread,
  moduleSize: number,
  frameSize: number,
): {result: number; moduleOffset?: number; frameOffset?: number} {
  parent = parent.storageOwner;
  moduleSize >>>= 0;
  frameSize >>>= 0;
  const module = reservationPosition(parent.moduleReservations, parent.moduleCapacity, moduleSize);
  const frame = reservationPosition(parent.frameReservations, parent.frameCapacity, frameSize);
  const moduleOffset = (module.top - moduleSize) >>> 0;
  if ((moduleOffset | 0) < (parent.moduleSize | 0)) return {result: 0x80000002};
  if (frame.top < frameSize) return {result: 0x80000003};
  const frameOffset = (frame.top - frameSize) >>> 0;
  parent.retentionCount = (parent.retentionCount + 1) >>> 0;
  parent.moduleReservations.splice(module.index, 0, {
    borrower,
    offset: moduleOffset,
    size: moduleSize,
  });
  parent.frameReservations.splice(frame.index, 0, {borrower, offset: frameOffset, size: frameSize});
  parent.moduleUsableCapacity = parent.moduleReservations.reduce(
    (value, record) => Math.min(value, record.offset),
    parent.moduleCapacity,
  );
  parent.frameUsableCapacity = parent.frameReservations.reduce(
    (value, record) => Math.min(value, record.offset),
    parent.frameCapacity,
  );
  return {result: 0, moduleOffset, frameOffset};
}

/** Native release intentionally does not recalculate the usable capacities. */
export function releaseThreadRegions(parent: AokanaBpThread, borrower: AokanaBpThread): boolean {
  parent = parent.storageOwner;
  let removed = false;
  for (const records of [parent.moduleReservations, parent.frameReservations]) {
    const index = records.findIndex((record) => record.borrower === borrower);
    if (index >= 0) {
      records.splice(index, 1);
      removed = true;
    }
  }
  if (removed) parent.retentionCount = (parent.retentionCount - 1) >>> 0;
  return removed;
}
