import type {ArtemisImageSource, ArtemisLoadedImage} from './image-loader.js';
import {artemisRevision} from './revision.js';

/** A prepared native surface has an identity before decoding fills its image.
 * Decode must use actual pixels and perform required renderer preparation. */
export interface ArtemisSurfaceManagerHost<S extends object> {
  createSurface(): S;
  decodeSurface(surface: S, name: string): Promise<ArtemisLoadedImage | null>;
  storageBytes(surface: S, resource: ArtemisLoadedImage): number;
  disposeSurface(surface: S, resource: ArtemisLoadedImage | null): void;
}
interface Job<S> {
  readonly name: string;
  readonly surface: S;
  readonly conditional: boolean;
  queued: boolean;
  busy: boolean;
  adopted: boolean;
  disposed: boolean;
  resource: ArtemisLoadedImage | null;
}
interface Entry<S> {
  readonly name: string;
  readonly surface: S;
  readonly resource: ArtemisLoadedImage;
  readonly bytes: bigint;
  loans: number;
  bindings: number;
}
function surfaceName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)
  )
    throw Error('Unsupported Artemis surface name');
}
/** 011a90/0128b0: serialized preload FIFO, ordinary foreground loads and explicit
 * script bindings. Browser cancellation wakes pending callers instead of leaving
 * native condition-variable waiters blocked after their queue was cleared.
 * Native decoder failures return null; unsupported/host errors remain observable.
 */
export class ArtemisSurfaceManager<S extends object> implements ArtemisImageSource {
  private readonly active = new Map<string, Entry<S>>();
  private readonly idle = new Map<string, Entry<S>>();
  private readonly identities = new Set<S>();
  /** Entries the cache forgot while loaned; disposed when their last loan releases. */
  private readonly evicted = new Set<Entry<S>>();
  private readonly queue: Job<S>[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly failures: {name: string; error: unknown}[] = [];
  private worker: Promise<void> | null = null;
  private foreground = false;
  private closed = false;
  private total = 0n;
  constructor(
    hash: string,
    readonly budgetBytes: bigint,
    private readonly host: ArtemisSurfaceManagerHost<S>,
  ) {
    artemisRevision(hash);
    if (typeof budgetBytes !== 'bigint' || budgetBytes < 0n || budgetBytes > 0xffffffffffffffffn)
      throw Error('Invalid Artemis uint64 surface budget');
  }
  get bytesUsed(): bigint {
    return this.total;
  }
  get loadFailures(): readonly {name: string; error: unknown}[] {
    return this.failures.map((failure) => ({...failure}));
  }
  private open(): void {
    if (this.closed) throw Error('Artemis surface manager closed');
  }
  private signal(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
  private discard(entry: Entry<S>): void {
    this.total -= entry.bytes;
    this.identities.delete(entry.surface);
    this.host.disposeSurface(entry.surface, entry.resource);
  }
  trim(): void {
    while (this.total > this.budgetBytes && this.idle.size) {
      const entry = this.idle.values().next().value!;
      this.idle.delete(entry.name);
      this.discard(entry);
    }
  }
  private cached(name: string): Entry<S> | undefined {
    let entry = this.active.get(name);
    if (!entry) {
      entry = this.idle.get(name);
      if (entry) {
        this.idle.delete(name);
        this.active.set(name, entry);
      }
    }
    return entry;
  }
  private increment(entry: Entry<S>): void {
    if (entry.loans === 0x7fffffff) throw Error('Artemis surface loan count overflow');
    entry.loans++;
  }
  private release(entry: Entry<S>): void {
    if (this.active.get(entry.name) !== entry) {
      if (this.evicted.has(entry) && --entry.loans === 0) {
        this.evicted.delete(entry);
        this.identities.delete(entry.surface);
        this.host.disposeSurface(entry.surface, entry.resource);
      }
      return;
    }
    if (--entry.loans !== 0) return;
    this.active.delete(entry.name);
    if (this.closed || this.total > this.budgetBytes) this.discard(entry);
    else this.idle.set(entry.name, entry);
  }
  private loan(entry: Entry<S>): ArtemisLoadedImage {
    this.increment(entry);
    let released = false;
    return {
      ...entry.resource,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          this.release(entry);
        },
      },
    };
  }
  private create(name: string, conditional: boolean): Job<S> {
    const surface = this.host.createSurface();
    if (!surface || typeof surface !== 'object' || this.identities.has(surface))
      throw Error('Artemis surface owner must create a fresh identity');
    this.identities.add(surface);
    return {
      name,
      surface,
      conditional,
      queued: false,
      busy: false,
      adopted: false,
      disposed: false,
      resource: null,
    };
  }
  private retire(job: Job<S>): void {
    if (job.queued || job.busy || job.adopted || job.disposed) return;
    job.disposed = true;
    this.identities.delete(job.surface);
    this.host.disposeSurface(job.surface, job.resource);
  }
  private remove(index: number): Job<S> {
    const job = this.queue.splice(index, 1)[0]!;
    job.queued = false;
    this.retire(job);
    return job;
  }
  private adopt(job: Job<S>): Entry<S> {
    const resource = job.resource!;
    if (resource.lease) {
      resource.lease.release();
      throw Error('Unsupported nested Artemis surface manager');
    }
    const storage = this.host.storageBytes(job.surface, resource);
    if (!Number.isInteger(storage) || storage < 0 || storage > 0x7fffffff)
      throw Error('Unsupported Artemis signed surface storage size');
    const bytes = BigInt(storage);
    if (this.total + bytes > 0xffffffffffffffffn)
      throw Error('Artemis surface accounting overflow');
    if (this.active.has(job.name) || this.idle.has(job.name))
      throw Error('Unsupported concurrent Artemis surface publication');
    const entry = {name: job.name, surface: job.surface, resource, bytes, loans: 0, bindings: 0};
    this.total += bytes;
    this.active.set(job.name, entry);
    job.adopted = true;
    return entry;
  }
  /** Mode1 always queues; mode2 drops at execution when usage >= budget. A cached
   * hit reserves a binding, while a duplicate queued name reserves no extra loan. */
  bindSurfaceAsync(name: string, conditional = false): void {
    this.open();
    surfaceName(name);
    const entry = this.cached(name);
    if (entry) {
      this.increment(entry);
      entry.bindings++;
      return;
    }
    this.trim();
    if (this.queue.some((job) => job.name === name)) return;
    const job = this.create(name, conditional);
    job.queued = true;
    this.queue.push(job);
    this.startWorker();
  }
  private startWorker(): void {
    if (this.worker || this.closed) return;
    // Starting after the current Lua call allows real FIFO selection/promotion.
    this.worker = Promise.resolve()
      .then(() => this.pump())
      .finally(() => {
        this.worker = null;
        this.signal();
        if (!this.closed && this.queue.length) this.startWorker();
      });
  }
  private async pump(): Promise<void> {
    while (!this.closed && this.queue.length) {
      const job = this.queue[0]!;
      if (job.conditional && this.total >= this.budgetBytes) {
        this.remove(0);
        this.signal();
        continue;
      }
      job.busy = true;
      try {
        job.resource = await this.host.decodeSurface(job.surface, job.name);
        // Native checks the front NAME, not job identity. A clear/requeue with
        // the same front name can adopt the old result and retire the new job.
        if (!this.closed && this.queue[0]?.name === job.name) {
          this.remove(0);
          if (job.resource) {
            const entry = this.adopt(job);
            this.increment(entry);
            entry.bindings++;
          }
        }
      } catch (error) {
        if (this.queue[0]?.name === job.name) this.remove(0);
        this.failures.push({name: job.name, error});
      } finally {
        job.busy = false;
        this.retire(job);
        this.signal();
      }
    }
  }
  /** Diagnostic join; this is not the script-visible loading query. */
  async waitForLoads(): Promise<void> {
    while (this.worker) await this.worker;
    if (this.failures.length) throw this.failures[0]!.error;
  }
  isLoadingSurface(name?: string): boolean {
    this.open();
    if (name !== undefined) {
      surfaceName(name);
      return this.queue.some((job) => job.name === name);
    }
    return this.queue.length !== 0;
  }
  clearSurfaceLoadQueue(): void {
    this.open();
    while (this.queue.length) this.remove(this.queue.length - 1);
    this.signal();
  }
  unbindSurface(name: string): void {
    this.open();
    surfaceName(name);
    const index = this.queue.findIndex((job) => job.name === name);
    if (index >= 0) {
      this.remove(index);
      this.signal();
      return;
    }
    const entry = this.active.get(name);
    if (entry) {
      if (entry.bindings) entry.bindings--;
      this.release(entry);
    }
  }
  /** Slot +0x28 (0x140011080): the cache forgets `name` and its bytes leave the usage
   * total. An idle surface is disposed; loaned surfaces stay with their holders until
   * the last release. Queued loads are unaffected. */
  evict(name: string): void {
    this.open();
    surfaceName(name);
    const idle = this.idle.get(name);
    if (idle) {
      this.idle.delete(name);
      this.discard(idle);
      return;
    }
    const entry = this.active.get(name);
    if (!entry) return;
    this.active.delete(name);
    this.total -= entry.bytes;
    this.evicted.add(entry);
  }
  async load(name: string): Promise<ArtemisLoadedImage | null> {
    this.open();
    surfaceName(name);
    if (this.foreground) throw Error('Unsupported overlapping Artemis foreground load');
    this.foreground = true;
    try {
      for (;;) {
        this.open();
        const entry = this.cached(name);
        if (entry) return this.loan(entry);
        this.trim();
        const index = this.queue.findIndex((job) => job.name === name);
        if (index === 0) {
          await new Promise<void>((wake) => this.waiters.add(wake));
          continue;
        }
        if (index > 0) this.remove(index);
        const job = this.create(name, false);
        job.busy = true;
        try {
          job.resource = await this.host.decodeSurface(job.surface, name);
          this.open();
          return job.resource ? this.loan(this.adopt(job)) : null;
        } finally {
          job.busy = false;
          this.retire(job);
        }
      }
    } finally {
      this.foreground = false;
    }
  }
  /** Stop/clear and join background jobs; held foreground leases retain their
   * decoded resource until release. No new script/image operations are accepted. */
  async close(): Promise<void> {
    if (this.closed) {
      if (this.worker) await this.worker;
      return;
    }
    this.closed = true;
    while (this.queue.length) this.remove(this.queue.length - 1);
    this.signal();
    for (const entry of [...this.active.values()]) {
      while (entry.bindings && this.active.get(entry.name) === entry) {
        entry.bindings--;
        this.release(entry);
      }
    }
    const entries = [...this.idle.values()];
    this.idle.clear();
    for (const entry of entries) this.discard(entry);
    if (this.worker) await this.worker;
  }
}
