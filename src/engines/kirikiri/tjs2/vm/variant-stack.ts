import {VariantSlot} from '../runtime/slot.js';

const ONE_ALLOC_MAX = 1024;

/**
 * `tTJSVariantArrayStack` (krkrz `tjsInterCodeExec.cpp`): the register files of running
 * functions, carved from blocks of 1,024 variants in call order. Registers are not cleared
 * when a function returns, so the values a function left behind keep their objects alive
 * until a later call reuses the slots or the stack is compacted, as natively. Allocation is
 * last-in first-out; a suspended call keeps its registers while the calls it waits for run
 * above it.
 */
export class VariantArrayStack {
  readonly #arrays: {array: VariantSlot[]; using: number}[] = [];
  #using = 0;
  #compactRequested = false;

  /** Returns the block and the index of the first of `count` registers. */
  allocate(count: number): {array: VariantSlot[]; base: number} {
    if (count >= ONE_ALLOC_MAX) return {array: newSlots(count), base: 0};
    let current = this.#using ? this.#arrays[this.#using - 1]! : null;
    if (!current || current.using + count > ONE_ALLOC_MAX) {
      this.#using++;
      if (this.#using > this.#arrays.length)
        this.#arrays.push({array: newSlots(ONE_ALLOC_MAX), using: 0});
      current = this.#arrays[this.#using - 1]!;
      current.using = 0;
    }
    const base = current.using;
    current.using += count;
    return {array: current.array, base};
  }

  /** Releases the most recent allocation of `count` registers. */
  deallocate(count: number, array: VariantSlot[]): void {
    if (count >= ONE_ALLOC_MAX) {
      for (const s of array) s.clear();
    } else {
      const current = this.#arrays[this.#using - 1]!;
      current.using -= count;
      if (current.using === 0) this.#using--;
    }
    if (this.#compactRequested) {
      this.#compactRequested = false;
      this.compact();
    }
  }

  /** `TJSVariantArrayStackCompact`: compacts at the next deallocation. */
  requestCompact(): void {
    this.#compactRequested = true;
  }

  /** `InternalCompact`: frees unused blocks and clears the unused part of the current one. */
  compact(): void {
    while (this.#arrays.length > this.#using) {
      for (const s of this.#arrays.pop()!.array) s.clear();
    }
    const current = this.#using ? this.#arrays[this.#using - 1]! : null;
    if (current) for (let i = current.using; i < ONE_ALLOC_MAX; i++) current.array[i]!.clear();
  }
}

function newSlots(n: number): VariantSlot[] {
  const a = new Array<VariantSlot>(n);
  for (let i = 0; i < n; i++) a[i] = new VariantSlot();
  return a;
}
