import {AokanaMovieRenderer} from './movie-renderer.js';
import type {AokanaSurfaces} from './surfaces.js';

interface AokanaMovieRecord {
  readonly id: number;
  readonly renderer: AokanaMovieRenderer;
  next: AokanaMovieRecord | null;
}
interface AokanaMovieRetirement {
  readonly id: number;
  readonly slot: number;
  readonly settled: Promise<{readonly ok: true} | {readonly ok: false; readonly error: unknown}>;
}

/** 03fc30/03fc60 registry. IDs wrap independently of newest-first ownership order. */
export class AokanaMovieRegistry {
  private head: AokanaMovieRecord | null = null;
  private nextId = 0;
  private nextNotificationId = 0;
  private readonly retirements = new Set<AokanaMovieRetirement>();
  /** 03fd00 links before renderer initialization, including later failed-initialization IDs. */
  append(renderer: AokanaMovieRenderer): number {
    const id = this.nextId;
    this.nextId = (id + 1) | 0;
    this.head = {id, renderer, next: this.head};
    return id;
  }
  /** 095780's successful graph initialization publishes an independent event ID. */
  allocateNotificationId(): number {
    const id = this.nextNotificationId;
    this.nextNotificationId = (id + 1) | 0;
    return id;
  }
  find(id: number): AokanaMovieRenderer | null {
    for (let node = this.head; node !== null; node = node.next)
      if (node.id === (id | 0)) return node.renderer;
    return null;
  }
  remove(id: number): 0 | 1 {
    let previous: AokanaMovieRecord | null = null;
    for (let node = this.head; node !== null; node = node.next) {
      if (node.id === (id | 0)) {
        if (previous === null) this.head = node.next;
        else previous.next = node.next;
        // Publish before callback-capable HTML cleanup. A synchronous pause/load
        // callback can reenter the registry and must see this pending ticket.
        let settle!: (
          result: {readonly ok: true} | {readonly ok: false; readonly error: unknown},
        ) => void;
        const settled = new Promise<
          {readonly ok: true} | {readonly ok: false; readonly error: unknown}
        >((resolve) => {
          settle = resolve;
        });
        this.retirements.add({
          id: node.id,
          slot: node.renderer.slot,
          settled,
        });
        try {
          // Both settlement branches are attached before returning to the host.
          void Promise.resolve(node.renderer.beginRetirement()).then(
            () => settle({ok: true}),
            (error: unknown) => settle({ok: false, error}),
          );
        } catch (error) {
          settle({ok: false, error});
        }
        return 1;
      }
      previous = node;
    }
    return 0;
  }
  /** Immediate visibility for the slot-scoped graph replacement boundary. */
  hasPendingRetirement(slot: number): boolean {
    return [...this.retirements].some((entry) => entry.slot === slot);
  }
  private async joinRetirements(slot: number | null): Promise<void> {
    let firstError: unknown;
    let failed = false;
    for (;;) {
      const selected = [...this.retirements].filter(
        (entry) => slot === null || entry.slot === slot,
      );
      if (selected.length === 0) break;
      const results = await Promise.all(selected.map((entry) => entry.settled));
      for (let index = 0; index < selected.length; index++) {
        this.retirements.delete(selected[index]!);
        const result = results[index]!;
        if (!result.ok && !failed) {
          firstError = result.error;
          failed = true;
        }
      }
    }
    if (failed) throw firstError;
  }
  /** 040430 must join the old controller for this slot before graph creation. */
  joinSlotRetirements(slot: number): Promise<void> {
    if (!Number.isInteger(slot) || slot < 0 || slot >= 0x4000)
      throw new RangeError('Aokana movie retirement slot is outside the surface table');
    return this.joinRetirements(slot);
  }
  /** Final display shutdown joins every renderer removed by a synchronous surface operation. */
  joinAllRetirements(): Promise<void> {
    return this.joinRetirements(null);
  }
  clear(): void {
    while (this.head !== null) this.remove(this.head.id);
  }
  /** 0402b0 preserves the last frame and bitmap while destroying its movie controller. */
  detachSlot(surfaces: AokanaSurfaces, slot: number): number {
    const record = surfaces.record(slot);
    if (record === null || record.movieId === -1) return 0x80000004;
    if (surfaces.descriptor(slot) === null) return 0x80000001;
    const renderer = this.find(record.movieId);
    let status = 0x80000001;
    if (renderer !== null) {
      const position = renderer.framePosition();
      if (position.status === 0) record.frame = position.value!;
      if (renderer.isPlaying() !== 0) renderer.stop();
      status = 0;
    }
    this.remove(record.movieId);
    record.movieId = -1;
    return status;
  }
  /** 040020 restarts at the head after each removal because callbacks can alter the list. */
  removeFinished(surfaces: AokanaSurfaces): void {
    let node = this.head;
    while (node !== null) {
      if (node.renderer.deliveredFrames !== 0 && node.renderer.isPlaying() === 0) {
        this.detachSlot(surfaces, node.renderer.slot);
        node = this.head;
      } else node = node.next;
    }
  }
  processNotification(id: number): number {
    for (let node = this.head; node !== null; node = node.next)
      if (node.renderer.notificationId === (id | 0)) return node.renderer.processEvents();
    return 0;
  }
  suspendAll(): void {
    for (let node = this.head; node !== null; node = node.next) node.renderer.suspend();
  }
  async resumeAll(): Promise<void> {
    for (let node = this.head; node !== null; node = node.next) await node.renderer.resume();
  }
  async serviceRepeat(): Promise<void> {
    for (let node = this.head; node !== null; node = node.next) await node.renderer.serviceRepeat();
  }
}
