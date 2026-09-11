import type {NoahState} from './noah-state.js';
export interface ArchiveAssets {
  size(bank: number, id: number): number;
  read(bank: number, id: number): Promise<Uint8Array>;
}
/** Owned archive allocations, distinct from the image loader's shared scratch.
 * Addresses are guest identities. Transport completion is published between VM passes.
 */
const allocationCursors = new WeakMap<NoahState, {next: number}>();
export class RawAssets {
  private readonly allocation: {next: number};
  private readonly buffers = new Map<number, Uint8Array>();
  private job:
    | {
        address: number;
        size: number;
        promise: Promise<void>;
        bytes?: Uint8Array;
        error?: unknown;
        done: boolean;
      }
    | undefined;
  constructor(
    readonly state: NoahState,
    readonly archives: ArchiveAssets | undefined,
    readonly channel = 0,
  ) {
    let allocation = allocationCursors.get(state);
    if (!allocation) {
      allocation = {next: 0x700000000};
      allocationCursors.set(state, allocation);
    }
    this.allocation = allocation;
  }
  start(bank: number, id: number): number {
    const s = this.state;
    if (s.get(0x587270 + this.channel * 4) !== 0) return 0xf4236;
    let size: number;
    try {
      if (!this.archives) throw new Error('Archive provider unavailable');
      size = this.archives.size(bank >>> 0, id);
      if (!Number.isSafeInteger(size) || size < 1 || size > 0x7ffff800)
        throw new Error('Invalid archive allocation size');
    } catch {
      return 0xf4237;
    }
    const capacity = Math.ceil(size / 2048) * 2048,
      address = this.allocation.next;
    this.allocation.next += capacity;
    const job: NonNullable<RawAssets['job']> = {
      address,
      size,
      promise: Promise.resolve(),
      done: false,
    };
    this.job = job;
    job.promise = Promise.resolve()
      .then(() => this.archives!.read(bank >>> 0, id))
      .then((bytes) => {
        if (bytes.length !== size) throw new Error('Raw archive transport size mismatch');
        job.bytes = Uint8Array.from(bytes);
      })
      .catch((error) => {
        job.error = error ?? new Error('Raw archive transport failed');
      })
      .finally(() => {
        job.done = true;
      });
    s.put(0x5872c0 + this.channel * 8, address, 8);
    s.put(0x587230 + this.channel * 4, capacity);
    s.put(0x587270 + this.channel * 4, 1);
    return this.channel;
  }
  read(address: number, size: number): Uint8Array {
    const bytes = this.buffers.get(address);
    if (!bytes || size < 0 || size > bytes.length) throw new Error('Invalid owned archive span');
    return bytes.subarray(0, size);
  }
  release(address: number): void {
    this.buffers.delete(address);
  }
  byte(address: number): number | undefined {
    for (const [base, bytes] of this.buffers)
      if (address >= base && address < base + bytes.length) return bytes[address - base];
    return undefined;
  }
  async settle(): Promise<void> {
    await this.job?.promise;
  }
  publish(): void {
    const j = this.job,
      s = this.state;
    if (
      !j?.done ||
      s.get(0x587270 + this.channel * 4) !== 1 ||
      Number(s.view(0x5872c0 + this.channel * 8, 8).getBigUint64(0, true)) !== j.address
    )
      return;
    if (j.error !== undefined) {
      s.put(0x587270 + this.channel * 4, 2);
      return;
    }
    if (!j.bytes) throw new Error('Completed raw asset has no bytes');
    this.buffers.set(j.address, j.bytes);
    s.put(0x587230 + this.channel * 4, j.size);
    s.put(0x587270 + this.channel * 4, 0);
    this.job = undefined;
  }
  get errors(): readonly unknown[] {
    return this.job?.error === undefined ? [] : [this.job.error];
  }
}
