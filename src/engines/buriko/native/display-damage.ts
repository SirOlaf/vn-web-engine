import {intersectBurikoBitmapRectangle, type BurikoBitmapRectangle} from './bitmap.js';
import type {BurikoDisplayCriticalSection} from './display-critical-section.js';

interface DamageNode {
  rectangle: BurikoBitmapRectangle;
  key: number;
  next: DamageNode | null;
  released: boolean;
}
const area = (r: BurikoBitmapRectangle): number =>
  Math.imul((r.right - r.left + 1) | 0, (r.bottom - r.top + 1) | 0) >>> 0;
const union = (a: BurikoBitmapRectangle, b: BurikoBitmapRectangle): BurikoBitmapRectangle => ({
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom),
});
export const burikoRectangleContained = (
  a: BurikoBitmapRectangle,
  b: BurikoBitmapRectangle,
): boolean => b.left <= a.left && b.top <= a.top && a.right <= b.right && a.bottom <= b.bottom;
const overlap = (a: BurikoBitmapRectangle, b: BurikoBitmapRectangle): boolean =>
  a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;

export class BurikoDisplayDamageLifetimeError extends Error {
  constructor(readonly nativeAddress: string) {
    super(`Buriko damage recorder reads a released node at ${nativeAddress}`);
  }
}
const alive = (node: DamageNode, address: string): void => {
  if (node.released) throw new BurikoDisplayDamageLifetimeError(address);
};

/** CObjectManager +50..+7C. RecordDamage is the complete 06f3e0 recursive rectangle algorithm. */
export class BurikoDisplayDamage {
  private head: DamageNode | null = null;
  private criticalSection: BurikoDisplayCriticalSection | null = null;
  count = 0;
  fullRedraw = 0;
  constructor(
    public capacity: number,
    public clip: BurikoBitmapRectangle,
  ) {}

  /** The display manager binds the same +B8 section used by lists and draw traversals. */
  bindCriticalSection(section: BurikoDisplayCriticalSection): void {
    if (this.criticalSection !== null && this.criticalSection !== section)
      throw new Error('Buriko damage belongs to a different object manager');
    this.criticalSection = section;
  }
  private locked<T>(body: () => T): T {
    return this.criticalSection === null ? body() : this.criticalSection.run(body);
  }

  snapshot(): {rectangle: BurikoBitmapRectangle; key: number}[] {
    const output = [];
    for (let node = this.head; node !== null; node = node.next)
      output.push({rectangle: {...node.rectangle}, key: node.key});
    return output;
  }
  clear(): void {
    this.locked(() => this.clearLocked());
  }
  private clearLocked(): void {
    for (let node = this.head; node !== null; node = node.next) node.released = true;
    this.head = null;
    this.count = 0;
    this.fullRedraw = 0;
  }
  force(): void {
    this.fullRedraw = 1;
  }

  /** The supplied rectangle is clipped in place. Recursive submissions use local native RECTs. */
  record(key: number, rectangle: BurikoBitmapRectangle): void {
    this.locked(() => this.recordLocked(key, rectangle));
  }
  private recordLocked(key: number, rectangle: BurikoBitmapRectangle): void {
    key >>>= 0;
    if ((this.count | 0) >= (this.capacity | 0)) {
      this.force();
      return;
    }
    if (!intersectBurikoBitmapRectangle(rectangle, this.clip)) return;
    const current = {...rectangle};
    let previous: DamageNode | null = null;
    let node = this.head;
    while (node !== null) {
      alive(node, '14006f454');
      const old = node.rectangle;
      const enclosing = union(current, old);
      const unlink = (): void => {
        if (previous === null) this.head = node!.next;
        else {
          alive(previous, '14006f50c');
          previous.next = node!.next;
        }
        this.count--;
      };
      if (!overlap(current, old)) {
        if ((area(old) + area(current)) >>> 0 === area(enclosing)) {
          unlink();
          this.record(Math.min(key, node.key), enclosing);
          node.released = true;
          return;
        }
      } else {
        if (burikoRectangleContained(current, old)) return;
        const oldArea = area(old),
          newArea = area(current);
        const threshold =
          oldArea <= newArea
            ? ((oldArea >>> 1) + newArea) >>> 0
            : ((newArea >>> 1) + oldArea) >>> 0;
        if (
          area(enclosing) <= threshold ||
          (current.top === old.top && current.bottom === old.bottom)
        ) {
          unlink();
          this.record(Math.min(key, node.key), enclosing);
          node.released = true;
          return;
        }
        if (current.top <= old.top && old.bottom <= current.bottom) {
          unlink();
          this.record(Math.min(key, node.key), {...enclosing, top: old.top, bottom: old.bottom});
          if (current.top < old.top) this.record(key, {...current, bottom: (old.top - 1) | 0});
          if (old.bottom < current.bottom)
            this.record(key, {...current, top: (old.bottom + 1) | 0});
          node.released = true;
          return;
        }
        if (old.top <= current.top && current.bottom <= old.bottom) {
          current.left = Math.min(current.left, old.left);
          current.right = Math.max(current.right, old.right);
          if (old.top < current.top && current.bottom < old.bottom) {
            const bottom = {...old, top: (current.bottom + 1) | 0};
            old.bottom = (current.top - 1) | 0;
            this.record(node.key, bottom);
          } else if (old.top === current.top) old.top = (current.bottom + 1) | 0;
          else old.bottom = (current.top - 1) | 0;
          alive(node, '14006f5a5');
          key = Math.min(key, node.key);
        } else if (
          current.left <= old.left &&
          old.right <= current.right &&
          (current.left < old.left || old.right < current.right)
        ) {
          if (current.top < old.top) old.top = (current.bottom + 1) | 0;
          else old.bottom = (current.top - 1) | 0;
          key = Math.min(key, node.key);
        } else if (old.left <= current.left && current.right <= old.right) {
          if (current.top < old.top) current.bottom = (old.top - 1) | 0;
          else current.top = (old.bottom + 1) | 0;
          key = Math.min(key, node.key);
        } else {
          if (current.top < old.top) {
            const oldTop = old.top;
            enclosing.top = oldTop;
            enclosing.bottom = current.bottom;
            old.top = (current.bottom + 1) | 0;
            current.bottom = (oldTop - 1) | 0;
          } else {
            enclosing.top = current.top;
            enclosing.bottom = old.bottom;
            current.top = (old.bottom + 1) | 0;
            old.bottom = (enclosing.top - 1) | 0;
          }
          this.record(key, current);
          alive(node, '14006f7f1');
          this.record(Math.min(key, node.key), enclosing);
          return;
        }
      }
      previous = node;
      alive(node, '14006f6e7');
      node = node.next;
    }
    this.head = {rectangle: current, key, next: this.head, released: false};
    this.count++;
  }
}
