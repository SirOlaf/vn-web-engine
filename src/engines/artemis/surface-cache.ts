import type {ArtemisImageSource, ArtemisLoadedImage} from './image-loader.js';
import {artemisRevision} from './revision.js';
import type {TriangleImage} from '../../graphics/triangle-draw.js';

export interface ArtemisSurfaceOwner {
  /** Native surface virtual +0x50; do not infer GPU storage from decoded RGBA length. */
  storageBytes(resource: ArtemisLoadedImage): number;
  /** Prepare the actual surface, retaining its renderer binding through idle periods. */
  prepare(resource: ArtemisLoadedImage): void;
  /** Dispose the surface/binding, including a partially failed prepare operation. */
  dispose(resource: ArtemisLoadedImage): void;
}
interface Entry {
  readonly name: string;
  readonly resource: ArtemisLoadedImage;
  readonly bytes: bigint;
  loans: number;
}

/** Native ordinary synchronous-load policy, adapted to asynchronous browser decoding.
 * 011a90 active/idle lookup, 012200 loan release, 0116b0 FIFO trimming.
 * Worker preload requests and overlapping native load modes are not emulated.
 */
export class ArtemisSurfaceCache implements ArtemisImageSource {
  private readonly active = new Map<string, Entry>();
  // Map insertion order is the native idle FIFO; promotion removes its position.
  private readonly idle = new Map<string, Entry>();
  private readonly surfaces = new Set<TriangleImage>();
  private total = 0n;
  private pending = false;
  private closed = false;
  constructor(
    executableSha256: string,
    readonly budgetBytes: bigint,
    private readonly source: ArtemisImageSource,
    private readonly owner: ArtemisSurfaceOwner,
  ) {
    artemisRevision(executableSha256);
    if (typeof budgetBytes !== 'bigint' || budgetBytes < 0n || budgetBytes > 0xffffffffffffffffn)
      throw new Error('Invalid Artemis uint64 surface budget');
  }
  get bytesUsed(): bigint {
    return this.total;
  }
  private discard(entry: Entry): void {
    this.total -= entry.bytes;
    this.surfaces.delete(entry.resource.image);
    this.owner.dispose(entry.resource);
  }
  /** Native trim uses the current total, without reserving room for the next surface. */
  trim(): void {
    while (this.total > this.budgetBytes && this.idle.size) {
      const entry = this.idle.values().next().value!;
      this.idle.delete(entry.name);
      this.discard(entry);
    }
  }
  private loan(entry: Entry): ArtemisLoadedImage {
    if (entry.loans === 0x7fffffff) throw new Error('Artemis surface loan count overflow');
    entry.loans++;
    let released = false;
    return {
      ...entry.resource,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          if (--entry.loans !== 0) return;
          this.active.delete(entry.name);
          if (this.closed || this.total > this.budgetBytes) this.discard(entry);
          else this.idle.set(entry.name, entry);
        },
      },
    };
  }
  async load(name: string): Promise<ArtemisLoadedImage | null> {
    if (this.closed) throw new Error('Artemis surface cache closed');
    if (this.pending) throw new Error('Unsupported overlapping Artemis surface load');
    if (
      name.includes('\0') ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)
    )
      throw new Error('Unsupported Artemis surface name');
    let entry = this.active.get(name);
    if (entry) return this.loan(entry);
    entry = this.idle.get(name);
    if (entry) {
      this.idle.delete(name);
      this.active.set(name, entry);
      return this.loan(entry);
    }
    this.trim();
    this.pending = true;
    try {
      const resource = await this.source.load(name);
      if (!resource) return null;
      if (resource.lease) {
        resource.lease.release();
        throw new Error('Unsupported nested Artemis surface cache');
      }
      if (this.surfaces.has(resource.image))
        throw new Error(
          'Artemis surface decoder must allocate a fresh surface for each cache miss',
        );
      try {
        if (this.closed) throw new Error('Artemis surface cache closed during load');
        const bytes = this.owner.storageBytes(resource);
        if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0x7fffffff)
          throw new Error('Unsupported Artemis signed surface storage size');
        if (this.total + BigInt(bytes) > 0xffffffffffffffffn)
          throw new Error('Artemis surface accounting overflow');
        this.owner.prepare(resource);
        entry = {name, resource, bytes: BigInt(bytes), loans: 0};
      } catch (error) {
        this.owner.dispose(resource);
        throw error;
      }
      this.total += entry.bytes;
      this.surfaces.add(resource.image);
      this.active.set(name, entry);
      return this.loan(entry);
    } finally {
      this.pending = false;
    }
  }
  /** Shutdown drops idle surfaces; active loans remain valid until their owners release. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const idle = [...this.idle.values()];
    this.idle.clear();
    for (const entry of idle) this.discard(entry);
  }
}
