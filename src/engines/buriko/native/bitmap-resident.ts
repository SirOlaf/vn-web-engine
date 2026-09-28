import {instantiateEmbeddedWasm} from '../../../core/wasm.js';
import {WasmResidentHeap} from '../../../graphics/wasm-resident-heap.js';
import {recordRuntimeMetric} from '../../../platform/runtime-performance.js';
import type {BurikoBitmapExports} from './bitmap-alpha-wasm.js';
import {BURIKO_BITMAP_WASM_BINARY} from './bitmap-alpha-wasm-binary.js';

const MIB = 1024 * 1024;

/**
 * Linear memory reserved for resident bitmap storage when the first resident allocation
 * creates the instance; halves are tried down to 64 MiB when the reservation fails.
 * Allocations that do not fit keep ordinary buffers, so the budget bounds memory and speed,
 * not correctness. Wasm memory never shrinks: pages dirtied at the peak stay committed for
 * the tab's lifetime, where collected buffers would be returned. Aokana's first scenes peak
 * at 345–375 MiB of live bitmap storage, so smaller devices trade some in-place kernels for
 * a bounded footprint. `navigator.deviceMemory` (GiB, Chromium only) selects the budget;
 * browsers without it get the middle one.
 */
export function burikoResidentBitmapBudget(): number {
  const deviceMemory = (globalThis.navigator as {deviceMemory?: number} | undefined)?.deviceMemory;
  if (deviceMemory === undefined) return 256 * MIB;
  return deviceMemory >= 8 ? 384 * MIB : deviceMemory >= 4 ? 256 * MIB : 128 * MIB;
}

/** Smaller storage (glyphs, masks, scratch rows) stays in ordinary buffers. */
export const BURIKO_RESIDENT_BITMAP_MIN_BYTES = 16 * 1024;

interface ResidentKernel {
  readonly exports: BurikoBitmapExports;
  readonly heap: WasmResidentHeap;
}

let enabled = true;
let budgetOverride: number | null = null;
let resident: ResidentKernel | null | undefined;

/**
 * Replaces the automatic budget with `bytes`, or restores it with null. The budget is
 * reserved once, so this returns false when the resident instance already exists and the
 * change can only apply to a later page load.
 */
export function setBurikoResidentBitmapBudget(bytes: number | null): boolean {
  budgetOverride = bytes;
  return resident === undefined;
}

/** Disables resident storage for bitmaps allocated afterwards (A/B and fallback testing). */
export function setBurikoBitmapResidencyEnabled(value: boolean): void {
  enabled = value;
}

/**
 * A kernel instance of its own whose memory hosts resident bitmaps. It is separate from the
 * shared staging instance, whose scratch area from `__heap_base` DSC and staged kernels reuse.
 * Created (and its budget reserved) on first use while residency is enabled.
 */
export function getBurikoResidentKernel(): ResidentKernel | null {
  if (resident === undefined) {
    if (!enabled) return null;
    const instance = instantiateEmbeddedWasm(BURIKO_BITMAP_WASM_BINARY);
    const exports = instance === null ? null : (instance.exports as BurikoBitmapExports);
    const heap =
      exports === null
        ? null
        : WasmResidentHeap.create(exports, budgetOverride ?? burikoResidentBitmapBudget());
    resident = exports === null || heap === null ? null : {exports, heap};
  }
  return resident;
}

/** Zeroed resident bytes for a new bitmap storage, or null to use an ordinary buffer. */
export function allocateBurikoResidentBytes(length: number): Uint8Array | null {
  if (!enabled || length < BURIKO_RESIDENT_BITMAP_MIN_BYTES) return null;
  const heap = getBurikoResidentKernel()?.heap;
  if (heap === undefined) return null;
  const bytes = heap.allocate(length);
  recordRuntimeMetric('buriko.bitmap.resident-applied', Number(bytes !== null));
  if (bytes !== null) recordRuntimeMetric('buriko.bitmap.resident-live-bytes', heap.liveBytes);
  return bytes;
}

/** The resident kernel if an allocation has created it; never creates or reserves one. */
export function existingBurikoResidentKernel(): ResidentKernel | null {
  return resident ?? null;
}

/** Returns resident bytes to the heap; ordinary buffers are left to the garbage collector. */
export function releaseBurikoResidentBytes(bytes: Uint8Array): void {
  const heap = resident?.heap;
  if (heap !== undefined && heap.contains(bytes)) heap.release(bytes);
}

/** The resident heap's buffer, when residency exists; views on it are resident. */
export function burikoResidentBuffer(): ArrayBuffer | null {
  return resident?.heap.buffer ?? null;
}
