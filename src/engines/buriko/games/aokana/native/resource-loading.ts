import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaProgramResources} from './program-resources.js';
import {terminatedNativeBytes} from './program-files.js';
import {AokanaResourceRanges} from './resource-ranges.js';
import {AokanaResourceCache} from './resource-cache.js';
import {AokanaBitmapPreloadCache} from './bitmap-preload-cache.js';
import {AokanaLoaderMetadata} from './loader-metadata.js';

export interface AokanaResourceBuffer {
  bytes: Uint8Array | null;
  /** Owned-private publication retains the native decoder's defined-byte mask. */
  initialized?: Uint8Array;
}
export interface AokanaResourceResult {
  value: number;
}
interface ResourceJob {
  readonly output: AokanaResourceBuffer | null;
  readonly direct: AokanaBpPointer | null;
  readonly result: AokanaResourceResult;
  readonly metadata: {value: bigint} | null;
  readonly archive: Uint8Array | null;
  readonly name: Uint8Array;
  readonly offset: number;
  readonly length: number;
}

/** 277798's FIFO, processed by the native loader actor before its other job families. */
export class AokanaResourceLoadingState {
  readonly metadata: AokanaLoaderMetadata;
  readonly ranges: AokanaResourceRanges;
  readonly cache: AokanaResourceCache;
  readonly preloaded: AokanaBitmapPreloadCache;
  /** 1D27D4 counts live load/encode procedures, not queue records. */
  activeProcedures = 0;
  private readonly jobs: ResourceJob[] = [];
  private pending: Promise<boolean> | null = null;

  constructor(readonly resources: AokanaProgramResources) {
    this.metadata = new AokanaLoaderMetadata(resources.mainProcessing.allocator);
    this.ranges = new AokanaResourceRanges(resources);
    this.cache = new AokanaResourceCache(resources.files.text);
    this.preloaded = new AokanaBitmapPreloadCache(resources.files.text);
  }

  /** 07E990 / 07E980 / 07E970 use wrapping DWORD arithmetic. */
  enterProcedure(): void {
    this.activeProcedures = (this.activeProcedures + 1) >>> 0;
  }
  leaveProcedure(): void {
    this.activeProcedures = (this.activeProcedures - 1) >>> 0;
  }
  get hasPending(): boolean {
    return this.metadata.run(this.metadata.allocator.currentActor, () => this.jobs.length !== 0);
  }

  /** FE160 copies names and clears the result before appending to the queue. */
  enqueue(
    output: AokanaResourceBuffer | null,
    direct: AokanaBpPointer | null,
    result: AokanaResourceResult,
    metadata: {value: bigint} | null,
    archive: Uint8Array | null,
    name: Uint8Array,
    offset = 0,
    length = 0,
    actor = this.metadata.allocator.currentActor,
  ): void {
    result.value = 0;
    const job: ResourceJob = {
      output,
      direct,
      result,
      metadata,
      archive: archive === null ? null : terminatedNativeBytes(archive).slice(),
      name: terminatedNativeBytes(name).slice(),
      offset: offset >>> 0,
      length: length >>> 0,
    };
    this.metadata.run(actor, () => {
      this.jobs.push(job);
    });
  }

  /** FE400 is the owned-buffer form used by CProcLoad and bitmap synthesis. */
  enqueueOwned(
    output: AokanaResourceBuffer,
    result: AokanaResourceResult,
    archive: Uint8Array | null,
    name: Uint8Array,
    offset = 0,
    length = 0,
    actor = this.metadata.allocator.currentActor,
  ): void {
    this.enqueue(output, null, result, null, archive, name, offset, length, actor);
  }

  /** FDBE0 retains the head through the asynchronous read; FDD A0 removes it afterward. */
  processNext(actor = this.resources.mainProcessing.allocator.currentActor): Promise<boolean> {
    if (this.pending !== null) return this.pending;
    const job = this.metadata.run(actor, () => this.jobs[0]);
    if (job === undefined) return Promise.resolve(false);
    this.pending = Promise.resolve()
      .then(() => this.process(job, actor))
      .then(() => {
        this.metadata.run(actor, () => {
          if (this.jobs[0] !== job)
            throw new Error('Aokana resource loader lost its borrowed head');
          this.jobs.shift();
        });
        return true;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** FDE10 removes remaining resource nodes after the loader worker has joined. */
  discardPendingResources(actor = this.metadata.allocator.currentActor): void {
    if (this.pending !== null)
      throw new Error('Aokana resource loader worker must join before queue shutdown');
    this.metadata.run(actor, () => {
      this.jobs.length = 0;
    });
  }

  private async process(job: ResourceJob, actor: object): Promise<void> {
    let length = job.length;
    if (length === 0 && job.metadata === null) {
      let count = 0;
      if (job.output !== null || job.direct !== null) {
        const read = await this.resources.load(
          job.archive,
          job.name,
          true,
          job.output === null ? undefined : null,
          actor,
        );
        count = read.result;
        if (count !== 0 && job.output !== null) {
          job.output.bytes = read.bytes;
          job.output.initialized = read.initialized;
        }
        // With only a direct buffer, native BD C30 replaces the job's local pointer.
        // That pointer is not an output cell and is not copied into the old direct buffer.
      }
      job.result.value = count === 0 ? 0xffffffff : count >>> 0;
      return;
    }
    if (length === 0) length = await this.ranges.size(job.archive, job.name);
    let destination = job.direct;
    if (job.output !== null) {
      if (length > 0x7fffffff) {
        job.result.value = 0xffffffff;
        return;
      }
      const bytes = new Uint8Array(length);
      job.output.bytes = bytes;
      destination = {bytes, offset: 0};
    }
    if (destination !== null) {
      const read = await this.ranges.read(destination, job.archive, job.name, job.offset, length);
      job.result.value = read.result === 0 ? length : 0xffffffff;
      if (read.result === 0 && job.metadata !== null)
        await this.ranges.metadata(job.archive, job.name, job.metadata);
    }
  }
}
