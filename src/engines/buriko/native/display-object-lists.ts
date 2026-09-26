import {BurikoDisplayObject} from './display-object.js';
import type {BurikoDisplayCriticalSection} from './display-critical-section.js';

export class BurikoDisplayListEntry {
  private removed = false;
  private following: BurikoDisplayListEntry | null;
  constructor(
    private keyValue: number,
    private objectValue: BurikoDisplayObject,
    next: BurikoDisplayListEntry | null,
  ) {
    this.following = next;
  }
  get key(): number {
    if (this.removed) throw new Error('Buriko display traversal reads a released list node');
    return this.keyValue;
  }
  get object(): BurikoDisplayObject {
    if (this.removed) throw new Error('Buriko display traversal reads a released list node');
    return this.objectValue;
  }
  get next(): BurikoDisplayListEntry | null {
    if (this.removed) throw new Error('Buriko display traversal reads a released list node');
    return this.following;
  }
  set next(value: BurikoDisplayListEntry | null) {
    if (this.removed) throw new Error('Buriko display traversal writes a released list node');
    this.following = value;
  }
  release(): void {
    this.removed = true;
  }
}
type OrderedNode = BurikoDisplayListEntry;
interface ExpandedRoot {
  object: BurikoDisplayObject;
  next: ExpandedRoot | null;
}

/** Complete ordinary and expanded CObjectManager lists (+08..+48), independent of pool ownership. */
export class BurikoDisplayObjectLists {
  private ordinary: OrderedNode | null = null;
  private roots: ExpandedRoot | null = null;
  private expanded: OrderedNode | null = null;

  constructor(
    private readonly criticalSection: BurikoDisplayCriticalSection | null = null,
    private readonly clearDamage: (() => void) | null = null,
  ) {}

  private locked<T>(body: () => T): T {
    return this.criticalSection === null ? body() : this.criticalSection.run(body);
  }

  snapshot(expanded: boolean): {key: number; object: BurikoDisplayObject}[] {
    const result = [];
    for (let node = expanded ? this.expanded : this.ordinary; node !== null; node = node.next)
      result.push({key: node.key, object: node.object});
    return result;
  }
  *entries(expanded: boolean): IterableIterator<BurikoDisplayListEntry> {
    for (let node = expanded ? this.expanded : this.ordinary; node !== null; node = node.next)
      yield node;
  }
  *expandedRoots(): IterableIterator<BurikoDisplayObject> {
    for (let root = this.roots; root !== null; root = root.next) yield root.object;
  }
  /** 06e740 keeps its insertion cursor between keys of one root, even if those keys descend. */
  private rebuildExpanded(): void {
    for (let node = this.expanded; node !== null;) {
      const next = node.next;
      node.release();
      node = next;
    }
    this.expanded = null;
    let count = 0;
    for (let root = this.roots; root !== null; root = root.next)
      count =
        (count + BurikoDisplayObject.prototype.copyExpandedSortKeys.call(root.object, null)) >>> 0;
    if (count === 0) return;
    const keys = new Uint32Array(count);
    for (let root = this.roots; root !== null; root = root.next) {
      let next: OrderedNode | null = this.expanded;
      let previous: OrderedNode | null = null;
      const length = BurikoDisplayObject.prototype.copyExpandedSortKeys.call(root.object, keys);
      for (let index = 0; index < length; index++) {
        const key = keys[index]!;
        while (next !== null && next.key <= key) {
          previous = next;
          next = next.next;
        }
        const inserted: OrderedNode = new BurikoDisplayListEntry(key, root.object, next);
        if (previous === null) this.expanded = inserted;
        else previous.next = inserted;
        previous = inserted;
      }
    }
  }
  /** 06f990 permits duplicate pointers and places ordinary equal keys after existing equals. */
  insert(object: BurikoDisplayObject): void {
    this.locked(() => this.insertLocked(object));
  }
  private insertLocked(object: BurikoDisplayObject): void {
    if (object.hasExpandedSortKeys() !== 0) {
      this.roots = {object, next: this.roots};
      this.rebuildExpanded();
      return;
    }
    const key = object.sortKey() >>> 0;
    let next = this.ordinary,
      previous: OrderedNode | null = null;
    while (next !== null && next.key <= key) {
      previous = next;
      next = next.next;
    }
    const inserted = new BurikoDisplayListEntry(key, object, next);
    if (previous === null) this.ordinary = inserted;
    else previous.next = inserted;
  }
  private removeExpanded(object: BurikoDisplayObject): 0 | 1 {
    let previous: ExpandedRoot | null = null;
    for (let node = this.roots; node !== null; node = node.next) {
      if (node.object === object) {
        if (previous === null) this.roots = node.next;
        else previous.next = node.next;
        this.rebuildExpanded();
        return 1;
      }
      previous = node;
    }
    return 0;
  }
  /** 06f8f0 selects the removal list using the object's current virtual20 result. */
  remove(object: BurikoDisplayObject | null): 0 | 1 {
    return this.locked(() => this.removeLocked(object));
  }
  private removeLocked(object: BurikoDisplayObject | null): 0 | 1 {
    if (object === null) return 0;
    if (object.hasExpandedSortKeys() !== 0) return this.removeExpanded(object);
    let previous: OrderedNode | null = null;
    for (let node = this.ordinary; node !== null; node = node.next) {
      if (node.object === object) {
        if (previous === null) this.ordinary = node.next;
        else previous.next = node.next;
        node.release();
        return 1;
      }
      previous = node;
    }
    return 0;
  }
  /** 06f880 invokes 0550b0/06e460 on children after reinsertion and returns its last result. */
  resort(object: BurikoDisplayObject | null): 0 | 1 {
    return this.locked(() => this.resortLocked(object));
  }
  private resortLocked(object: BurikoDisplayObject | null): 0 | 1 {
    if (this.remove(object) === 0) return 0;
    this.insert(object!);
    for (const child of object!.children()) if (this.resort(child) === 0) return 0;
    return 1;
  }
  /** 06ef20 clears nodes and the bound manager's damage without deleting any object. */
  clear(): void {
    this.locked(() => this.clearLocked());
  }
  private clearLocked(): void {
    while (this.ordinary !== null) {
      // A changed virtual20 can make native clear spin forever without removing this head.
      const head = this.ordinary;
      this.remove(head.object);
      if (this.ordinary === head)
        throw new Error('Buriko object-list clear cannot advance its native head');
    }
    while (this.roots !== null) this.removeExpanded(this.roots.object);
    this.clearDamage?.();
  }
}
