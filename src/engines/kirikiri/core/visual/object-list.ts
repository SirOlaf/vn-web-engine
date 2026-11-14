/**
 * `tObjectList` (krkrz `base/ObjectList.h`): an array of object references in which removal
 * leaves a hole (null) until the next compaction, and a safe lock lets callers iterate the
 * array as it was when the lock was taken while the array changes. Layer children use it, so
 * child order and iteration during callbacks follow it.
 */
export class ObjectList<T extends object> {
  #objects: (T | null)[] = [];
  #backup: (T | null)[] | null = null;
  #safeLockCount = 0;

  /** The copy constructor (`tObjectList(const tObjectList &)`), holes included. */
  static from<T extends object>(ref: ObjectList<T>): ObjectList<T> {
    const list = new ObjectList<T>();
    list.#objects = ref.#objects.slice();
    return list;
  }

  #touch(): void {
    if (this.#safeLockCount && !this.#backup) this.#backup = this.#objects.slice();
  }

  safeLock(): void {
    if (this.#safeLockCount === 0) this.compact();
    this.#safeLockCount++;
  }

  safeUnlock(): void {
    this.#safeLockCount--;
    if (this.#safeLockCount === 0) this.#backup = null;
  }

  get safeLockedCount(): number {
    return (this.#backup ?? this.#objects).length;
  }

  safeLockedAt(index: number): T | null {
    return (this.#backup ?? this.#objects)[index] ?? null;
  }

  /** `GetCount`: the length including holes. */
  get count(): number {
    return this.#objects.length;
  }

  /** `GetActualCount`: compacts, then the length. */
  actualCount(): number {
    this.compact();
    return this.#objects.length;
  }

  compact(): void {
    this.#touch();
    this.#objects = this.#objects.filter((o) => o !== null);
  }

  at(index: number): T | null {
    return this.#objects[index] ?? null;
  }

  set(index: number, object: T | null): void {
    this.#touch();
    this.#objects[index] = object;
  }

  find(object: T | null): number {
    if (!object) return -1;
    return this.#objects.indexOf(object);
  }

  /** Adds `object` at the end unless present. */
  add(object: T | null): boolean {
    this.#touch();
    if (!object) return false;
    if (this.find(object) !== -1) return false;
    this.#objects.push(object);
    return true;
  }

  /** Leaves a hole where `object` was, in the array and in the safe-lock backup. */
  remove(object: T): boolean {
    this.#touch();
    const index = this.find(object);
    if (index !== -1) this.#objects[index] = null;
    if (this.#backup) {
      const b = this.#backup.indexOf(object);
      if (b !== -1) this.#backup[b] = null;
    }
    return index !== -1;
  }

  /**
   * Iterates the array as it is now, tolerating changes during the iteration (the
   * `tObjectListSafeLockHolder` loops of the native code).
   */
  safeForEach(fn: (object: T) => void): void {
    this.safeLock();
    try {
      const n = this.safeLockedCount;
      for (let i = 0; i < n; i++) {
        const o = this.safeLockedAt(i);
        if (o) fn(o);
      }
    } finally {
      this.safeUnlock();
    }
  }
}
