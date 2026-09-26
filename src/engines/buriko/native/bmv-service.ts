import {pointerView} from '../bp/memory.js';
import type {BurikoBitmap} from './bitmap.js';
import {
  decodeBurikoBmvFrameData,
  decodeBurikoBmvIndexedFrame,
  validateBurikoBmvHeader,
} from './bmv-frame.js';
import {decodeBurikoLegacyBfFrame} from './bf-legacy-frame.js';
import type {BurikoBmvEntry, BurikoBmvRegistry} from './bmv-registry.js';
import type {BurikoDistributedProcessing} from './distributed-processing.js';
import type {BurikoResourceRanges} from './resource-ranges.js';
import type {BurikoSurfaces} from './surfaces.js';

export interface BurikoBmvWorker {
  readonly actor: object;
  readonly surface: number;
  readonly entry: BurikoBmvEntry;
  readonly destination: BurikoBitmap;
  readonly frame: number;
  readonly modern: boolean;
  readonly started: true;
  done: boolean;
  success: boolean;
}
const word = (bytes: Uint8Array, offset: number): number =>
  pointerView({bytes, offset}, 4).getUint32(0, true);

/** 038190/037C00/037D80. Host awaits pump slices; arbitrary native lock blocking is unsupported. */
export class BurikoBmvService {
  private active = 0;
  private readonly admission: number[] = [];
  private readonly workers: BurikoBmvWorker[] = [];
  private pending: Promise<boolean> | null = null;
  private closed = false;
  private workerReady: (() => void) | null = null;
  constructor(
    readonly registry: BurikoBmvRegistry,
    readonly surfaces: BurikoSurfaces,
    readonly ranges: BurikoResourceRanges,
    readonly synchronous: BurikoDistributedProcessing,
    readonly asynchronous: BurikoDistributedProcessing | null,
  ) {
    if (
      surfaces.allocator !== registry.allocator ||
      synchronous.allocator !== registry.allocator ||
      (asynchronous !== null && asynchronous.allocator !== registry.allocator)
    )
      throw new Error('Buriko BMV owners must share the actual actor allocator');
  }
  bindWorkerReady(callback: () => void): void {
    if (this.workerReady !== null) throw new Error('Buriko BMV worker pump is already bound');
    this.workerReady = callback;
  }
  get hasQueuedWorkers(): boolean {
    return this.workers.length !== 0;
  }
  closeAdmission(): void {
    this.closed = true;
    this.admission.length = 0;
  }
  private asActor<T>(actor: object, action: () => T): T {
    const previous = this.registry.allocator.currentActor;
    this.registry.allocator.currentActor = actor;
    try {
      return action();
    } finally {
      this.registry.allocator.currentActor = previous;
    }
  }
  /** 038190/038360 validation order, under the actual global registry lock. */
  preflight(surface: number, movie: number, frame: number): number {
    return this.registry.lock.run(() => {
      const entry = this.registry.find(movie);
      if (entry === null) return 0x80000003;
      const bytes = entry.resource.bytes;
      if (frame >>> 0 >= word(bytes, 0x28)) return 0x80000004;
      const destination = this.surfaces.snapshot(surface);
      return destination === null ||
        destination.width >>> 0 !== word(bytes, 0x14) ||
        destination.height >>> 0 !== word(bytes, 0x18) ||
        destination.format >>> 0 !== word(bytes, 0x20)
        ? 0x80000005
        : 0;
    });
  }
  private admit(movie: number): boolean {
    if (this.asynchronous === null) return false;
    if (this.active === 0 && (this.admission.length === 0 || this.admission[0] === movie)) {
      if (this.admission.length !== 0) this.admission.shift();
      this.active = movie;
      return true;
    }
    if (!this.admission.includes(movie)) this.admission.push(movie);
    return false;
  }
  /** Startup runs through the real lock/descriptor handshake, leaving pixels undecoded. */
  start(
    surface: number,
    movie: number,
    frame: number,
  ): {status: number; worker: BurikoBmvWorker | null} {
    if (this.closed) throw new Error('Buriko BMV worker admission is closed');
    movie >>>= 0;
    if (this.surfaces.snapshot(surface) === null) return {status: 0x80000005, worker: null};
    const initial = this.registry.lock.run(() => {
      const entry = this.registry.find(movie);
      if (entry === null) return {status: 0x80000003, modern: false};
      const modern = validateBurikoBmvHeader(entry.resource.bytes) === 0;
      return {status: modern && !this.admit(movie) ? 0x80000009 : 0, modern};
    });
    if (initial.status !== 0) return {status: initial.status, worker: null};
    const actor = {};
    const worker = this.asActor(actor, (): BurikoBmvWorker => {
      if (!this.surfaces.lock(surface))
        throw new Error('Buriko BMV worker cannot signal startup without a live surface');
      this.registry.lock.run(() => {
        const entry = this.registry.find(movie);
        if (entry === null)
          throw new Error('Buriko BMV worker cannot signal startup without its movie');
        entry.lock.enter();
      });
      const destination = this.surfaces.snapshot(surface);
      if (destination === null)
        throw new Error('Buriko BMV worker cannot signal startup without its descriptor');
      const entry = this.registry.find(movie);
      if (entry === null)
        throw new Error('Buriko BMV worker cannot signal startup without its locked movie');
      return {
        actor,
        surface,
        entry,
        destination,
        frame: frame >>> 0,
        modern: initial.modern,
        started: true,
        done: false,
        success: false,
      };
    });
    this.workers.push(worker);
    this.workerReady?.();
    return {status: 0, worker};
  }
  private async decode(
    entry: BurikoBmvEntry,
    destination: BurikoBitmap,
    frame: number,
    processing: BurikoDistributedProcessing,
    actor: object,
  ): Promise<number> {
    const bytes = entry.resource.bytes;
    if (validateBurikoBmvHeader(bytes) !== 0) {
      if (word(bytes, 0x10) !== 0) return 0x8000000a;
      this.asActor(actor, () => decodeBurikoLegacyBfFrame(bytes, frame, destination));
      return 0;
    }
    const provenance = entry.resource.provenance;
    if (provenance === null) {
      this.asActor(actor, () => decodeBurikoBmvIndexedFrame(bytes, frame, destination, processing));
      return 0;
    }
    if (frame >>> 0 >= word(bytes, 0x28)) return 0x8000000b;
    const offset = word(bytes, 0xc0 + frame * 4),
      end = frame + 1 < word(bytes, 0x28) ? word(bytes, 0xc0 + (frame + 1) * 4) : provenance.length,
      length = (end - offset) >>> 0,
      encoded = new Uint8Array(length);
    // Raw range I/O does not access allocator actors. Restore caller identity while awaiting it.
    const read = await this.ranges.read(
      {bytes: encoded, offset: 0},
      provenance.archive,
      provenance.name,
      offset,
      length,
    );
    if (read.result === 0)
      this.asActor(actor, () => decodeBurikoBmvFrameData(bytes, encoded, destination, processing));
    return 0;
  }
  async decodeSynchronously(
    surface: number,
    movie: number,
    frame: number,
    actor = this.registry.allocator.currentActor,
  ): Promise<number> {
    // A previously admitted BF worker can retain the same surface and entry
    // through raw range I/O. Let its serialized host slices finish first.
    while (this.pending !== null || this.workers.length !== 0) await this.processNext();
    const status = this.asActor(actor, () => this.preflight(surface, movie, frame));
    if (status !== 0) return status;
    this.asActor(actor, () => this.registry.lock.enter());
    try {
      const entry = this.registry.find(movie)!;
      return await this.decode(
        entry,
        this.surfaces.snapshot(surface)!,
        frame >>> 0,
        this.synchronous,
        actor,
      );
    } finally {
      this.asActor(actor, () => this.registry.lock.leave());
    }
  }
  /** Concrete BMV worker pump; the host serializes potentially contending work around this boundary. */
  processNext(): Promise<boolean> {
    if (this.pending !== null) return this.pending;
    const worker = this.workers.shift();
    if (worker === undefined) return Promise.resolve(false);
    const run = async (): Promise<boolean> => {
      try {
        await this.decode(
          worker.entry,
          worker.destination,
          worker.frame,
          this.asynchronous ?? this.synchronous,
          worker.actor,
        );
        worker.success = true;
        return true;
      } finally {
        this.asActor(worker.actor, () => {
          if (worker.modern)
            this.registry.lock.run(() => {
              this.active = 0;
            });
          worker.entry.lock.leave();
          this.surfaces.unlock(worker.surface);
          worker.done = true;
        });
      }
    };
    this.pending = run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}
