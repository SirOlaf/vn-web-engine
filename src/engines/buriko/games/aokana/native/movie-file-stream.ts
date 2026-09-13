import type {ByteSource} from '../../../../../core/source.js';
import {FileError} from '../../../../../platform/filesystem.js';
import {AokanaProgramFiles} from './program-files.js';

/** 129450/1292e0/129110 bounded, untransformed CAsyncStream file source. */
export class AokanaMovieFileStream {
  private source: ByteSource | null = null;
  private scratch: Uint8Array | null = null;
  private scratchDefined: Uint8Array | null = null;
  private scratchCapacity = 0n;
  private initialized = false;
  private disposed = false;
  private length: bigint | null = null;
  private base: bigint | null = null;
  private position = 0n;
  private path: string | null = null;
  private readonly createdAt: number;
  /** Constructor's rate is FFFFFFFF bytes/ms; no setter has been established in this executable. */
  private readonly bytesPerMillisecond = 0xffffffff;
  private owner: object | null = null;
  private lockDepth = 0;
  private readonly waiters: Array<{actor: object; resume: () => void}> = [];

  constructor(
    readonly files: AokanaProgramFiles,
    private readonly milliseconds: () => number,
  ) {
    this.createdAt = milliseconds() >>> 0;
  }
  private check(): void {
    if (this.disposed) throw new Error('Aokana movie uses a released file stream');
  }
  private regionLength(): bigint {
    if (this.length === null)
      throw new Error('Aokana movie reads an unwritten native region length');
    return this.length;
  }
  async lock(actor: object): Promise<void> {
    this.check();
    if (this.owner === null || this.owner === actor) {
      this.owner = actor;
      this.lockDepth++;
      return;
    }
    await new Promise<void>((resume) => this.waiters.push({actor, resume}));
    this.check();
  }
  unlock(actor: object): void {
    this.check();
    if (this.owner !== actor || this.lockDepth === 0)
      throw new Error("Aokana movie releases another worker's stream lock");
    if (--this.lockDepth !== 0) return;
    const next = this.waiters.shift();
    if (next === undefined) this.owner = null;
    else {
      this.owner = next.actor;
      this.lockDepth = 1;
      next.resume();
    }
  }
  private async readFile(at: bigint, length: number): Promise<Uint8Array> {
    const source = this.source;
    if (source === null) return new Uint8Array();
    if (at >= BigInt(source.size) || length === 0) return new Uint8Array();
    try {
      return await source.read(Number(at), Math.min(length, source.size - Number(at)));
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return new Uint8Array();
      throw error;
    }
  }
  private allocate(size: number): void {
    this.scratch = new Uint8Array(size);
    this.scratchDefined = new Uint8Array(size);
  }
  /** Caller 094dc0 zero-extends both arguments to DWORD before this signed64 initializer. */
  async initialize(path: string, length: number, offset: number): Promise<0 | 1> {
    this.check();
    this.initialized = false;
    const opened = await this.files.openWide(path);
    this.source = opened.source;
    if (opened.source === null || offset >>> 0 === 0xffffffff) return 1;
    this.scratchCapacity = 0x20000n;
    const count = Math.min(length >>> 0, 0x20000);
    this.allocate(count);
    const bytes = await this.readFile(BigInt(offset >>> 0), count);
    this.scratch!.set(bytes);
    this.scratchDefined!.fill(1, 0, bytes.length);
    if (bytes.length !== count) {
      this.scratch = null;
      this.scratchDefined = null;
      return 1;
    }
    this.path = path;
    this.length = BigInt(length >>> 0);
    this.base = BigInt(offset >>> 0);
    this.initialized = true;
    return 0;
  }
  setPointer(position: bigint): 0 | 1 {
    this.check();
    position = BigInt.asIntN(64, position);
    if (position < 0n || position > this.regionLength()) return 1;
    this.position = position;
    return 0;
  }
  get currentPosition(): bigint {
    this.check();
    return this.position;
  }
  get initializedPath(): string | null {
    this.check();
    return this.path;
  }
  size(): {total: bigint; available: bigint} {
    this.check();
    this.milliseconds();
    const length = this.regionLength();
    return {total: length, available: length};
  }
  alignment(): number {
    this.check();
    return 1;
  }
  /** The ignored aligned parameter has no effect in 129110. Output count is absent on status1. */
  async read(
    destination: Uint8Array,
    destinationOffset: number,
    requested: number,
    actor: object,
  ): Promise<{status: 0 | 1; count?: number}> {
    this.check();
    requested >>>= 0;
    if (!this.initialized) return {status: 1};
    await this.lock(actor);
    try {
      if (this.scratchCapacity < BigInt(requested)) {
        this.allocate(requested);
        this.scratchCapacity = BigInt(requested);
      }
      const now = this.milliseconds() >>> 0;
      const length = this.regionLength();
      const count =
        this.position + BigInt(requested) > length
          ? Number(BigInt.asUintN(32, length - this.position))
          : requested;
      const due = Math.floor(
        ((Number(BigInt.asUintN(32, this.position)) + count) >>> 0) / this.bytesPerMillisecond,
      );
      const elapsed = (now - this.createdAt) >>> 0;
      if (elapsed < due)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, (this.createdAt - now + due) >>> 0),
        );
      if (this.base === null) throw new Error('Aokana movie reads an unwritten native region base');
      const bytes = await this.readFile(this.base + this.position, count);
      const scratch = this.scratch,
        defined = this.scratchDefined;
      if (scratch === null || defined === null)
        throw new Error('Aokana movie reads an absent native scratch allocation');
      if (bytes.length > scratch.length)
        throw new RangeError('Aokana movie ReadFile writes beyond its native scratch allocation');
      scratch.set(bytes);
      defined.fill(1, 0, bytes.length);
      // ReadFile's actual count/status is deliberately ignored; old initialized tail bytes survive.
      if (count > scratch.length)
        throw new RangeError('Aokana movie memcpy reads beyond its native scratch allocation');
      for (let index = 0; index < count; index++)
        if (defined[index] === 0)
          throw new Error('Aokana movie memcpy reads unwritten native scratch bytes');
      if (count !== 0) {
        if (
          !Number.isSafeInteger(destinationOffset) ||
          destinationOffset < 0 ||
          destinationOffset + count > destination.length
        )
          throw new RangeError('Aokana movie memcpy writes beyond its destination');
        destination.set(scratch.subarray(0, count), destinationOffset);
      }
      this.position += BigInt(count);
      return {status: 0, count};
    } finally {
      this.unlock(actor);
    }
  }
  dispose(): void {
    this.check();
    if (this.lockDepth !== 0 || this.waiters.length !== 0)
      throw new Error('Aokana movie deletes a busy file-stream critical section');
    this.source = null;
    this.scratch = null;
    this.scratchDefined = null;
    this.path = null;
    this.initialized = false;
    this.disposed = true;
  }
}
