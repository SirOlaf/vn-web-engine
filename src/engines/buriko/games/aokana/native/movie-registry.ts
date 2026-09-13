import {AokanaMovieRenderer} from './movie-renderer.js';
import type {AokanaSurfaces} from './surfaces.js';

interface AokanaMovieRecord {readonly id: number; readonly renderer: AokanaMovieRenderer; next: AokanaMovieRecord | null;}

/** 03fc30/03fc60 registry. IDs wrap independently of newest-first ownership order. */
export class AokanaMovieRegistry {
  private head: AokanaMovieRecord | null = null;
  private nextId = 0;
  /** 03fd00 links before renderer initialization, including later failed-initialization IDs. */
  append(renderer: AokanaMovieRenderer): number {
    const id = this.nextId; this.nextId = (id + 1) | 0;
    this.head = {id, renderer, next: this.head};
    return id;
  }
  find(id: number): AokanaMovieRenderer | null {
    for (let node = this.head; node !== null; node = node.next) if (node.id === (id | 0)) return node.renderer;
    return null;
  }
  remove(id: number): 0 | 1 {
    let previous: AokanaMovieRecord | null = null;
    for (let node = this.head; node !== null; node = node.next) {
      if (node.id === (id | 0)) {
        if (previous === null) this.head = node.next; else previous.next = node.next;
        node.renderer.dispose();
        return 1;
      }
      previous = node;
    }
    return 0;
  }
  clear(): void {while (this.head !== null) this.remove(this.head.id);}
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
    this.remove(record.movieId); record.movieId = -1;
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
  suspendAll(): void {for (let node = this.head; node !== null; node = node.next) node.renderer.suspend();}
  async resumeAll(): Promise<void> {for (let node = this.head; node !== null; node = node.next) await node.renderer.resume();}
  async serviceRepeat(): Promise<void> {for (let node = this.head; node !== null; node = node.next) await node.renderer.serviceRepeat();}
}
