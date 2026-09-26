import type {BurikoNativeClock} from './clock.js';
import {BurikoParticleDisplays, type BurikoParticleRefreshNode} from './particle-displays.js';

/** Main-loop particle update and linked refresh scheduling share the actual particle owner. */
export class BurikoParticleFrames {
  constructor(
    readonly particles: BurikoParticleDisplays,
    readonly clock: BurikoNativeClock,
  ) {}

  /** 082660 runs every current controller, independent of visibility and refresh scheduling. */
  updateAll(): void {
    for (let slot = 0; slot < 8; slot++) this.particles.find(0xc0000000 + slot)?.updateParticle();
  }

  /** 0f1e00 reads the live next pointer after each due node, including refresh callbacks. */
  pollRefresh(): void {
    const now = Number(BigInt.asUintN(32, this.clock.read()));
    const minimum = this.particles.manager.minimumKey >>> 0;
    let previous: BurikoParticleRefreshNode | null = null;
    let node = this.particles.scheduleHead;
    let refreshed = false;
    while (node !== null) {
      if (node.nextTick >>> 0 <= now) {
        const object = this.particles.find(node.handle);
        if (object === null) {
          if (previous === null) this.particles.scheduleHead = node.next;
          else previous.next = node.next;
          node = previous === null ? this.particles.scheduleHead : previous.next;
          continue;
        }
        if (object.inputActive() !== 0 && minimum <= object.sortKey() >>> 0) {
          this.particles.refresh(node.handle);
          refreshed = true;
        }
        const base = node.nextTick >>> 0 || now;
        const delta = (now - base) >>> 0;
        const interval = node.interval >>> 0;
        if (interval === 0) throw new RangeError('Buriko particle refresh interval is zero');
        node.nextTick = (delta - (delta % interval) + node.interval + base) >>> 0;
      }
      previous = node;
      node = node.next;
    }
    if (refreshed) this.particles.manager.redraw.request(0);
  }
}
