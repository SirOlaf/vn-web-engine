/**
 * Owning variant storage. A `VariantSlot` is what a native `tTJSVariant` object is: assigning
 * an object variant takes references on its object and context, replacing or clearing it
 * releases them. Result parameters, members, array elements and native fields are slots.
 */
import {VOID, type Variant} from './variant.js';

/** Takes the references an object variant carries; other variants own nothing. */
export function addRefVariant(v: Variant): void {
  if (v.type === 1) {
    v.object?.addRef();
    v.objthis?.addRef();
  }
}

/** Releases the references taken by `addRefVariant`. */
export function releaseVariant(v: Variant): void {
  if (v.type === 1) {
    // Clear order of tTJSVariant::ReleaseObject: object first, then objthis.
    v.object?.release();
    v.objthis?.release();
  }
}

/** Storage a default handler can assign to: a slot, an array element. */
export interface VariantCell {
  readonly value: Variant;
  set(value: Variant): void;
}

export class VariantSlot implements VariantCell {
  #value: Variant = VOID;

  constructor(value?: Variant) {
    if (value) this.set(value);
  }

  get value(): Variant {
    return this.#value;
  }

  /** `CopyRef`: takes the new references before releasing the old ones. */
  set(value: Variant): void {
    addRefVariant(value);
    const old = this.#value;
    this.#value = value;
    releaseVariant(old);
  }

  /** Stores a variant whose references the caller hands over (no extra addRef). */
  adopt(value: Variant): void {
    const old = this.#value;
    this.#value = value;
    releaseVariant(old);
  }

  /** Moves the value out; the caller now owns its references. */
  take(): Variant {
    const v = this.#value;
    this.#value = VOID;
    return v;
  }

  clear(): void {
    const old = this.#value;
    this.#value = VOID;
    releaseVariant(old);
  }
}
