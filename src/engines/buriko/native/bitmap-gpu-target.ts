import {BurikoBitmapStorage, type BurikoBitmap} from './bitmap.js';

/**
 * Kernels a GPU display target may execute in place of the software kernel. Each id names one
 * `withBurikoBitmapText` kernel; its GPU implementation receives that kernel's arguments.
 */
export type BurikoGpuKernel =
  | 'alpha-into-rgb'
  | 'alpha-into-rgb-transparency'
  | 'mix-all-channels'
  | 'dim-rgb'
  | 'copy-rows'
  | 'clear'
  | 'affine-blend'
  | 'mix'
  | 'mixed-into-rgb'
  | 'transition';

/** Receives kernels whose destination is the display during a browser-optimized GPU frame. */
export interface BurikoGpuKernelTarget {
  /** Execute a kernel on the GPU. Unsupported arguments mark the frame failed instead. */
  dispatch(kernel: BurikoGpuKernel | undefined, args: readonly unknown[], name: string): unknown;
  /** Any direct access to display pixels fails the frame; software then redraws it. */
  fail(reason: string): void;
}

/**
 * Stand-in display storage for a GPU frame. Kernels with a GPU implementation never touch its
 * bytes. Every other access fails the frame and is directed at the real, stale software
 * texture, which the software redraw of the same frame then replaces. Nothing throws, so
 * worker pools, locks and notification order stay exactly as in a software frame.
 */
export class BurikoGpuTargetStorage extends BurikoBitmapStorage {
  constructor(
    readonly target: BurikoGpuKernelTarget,
    readonly software: BurikoBitmapStorage,
  ) {
    super(software.bytes, true);
    Object.defineProperty(this, 'bytes', {
      get: () => {
        target.fail('bytes');
        return software.bytes;
      },
    });
    Object.defineProperty(this, 'view', {
      get: () => {
        target.fail('view');
        return software.view;
      },
    });
  }
  override range(offset: number, length: number, read: boolean): void {
    this.target.fail('range');
    this.software.range(offset, length, read);
  }
  override written(offset: number, length: number): void {
    this.target.fail('written');
    this.software.written(offset, length);
  }
  override initializedView(offset: number, length: number): DataView | null {
    this.target.fail('initializedView');
    return this.software.initializedView(offset, length);
  }
  override initializedRange(offset: number, length: number): Uint8Array {
    this.target.fail('initializedRange');
    return this.software.initializedRange(offset, length);
  }
  override cloneRange(offset: number, length: number): BurikoBitmapStorage {
    this.target.fail('cloneRange');
    return this.software.cloneRange(offset, length);
  }
  override release(): void {
    this.target.fail('release');
  }
}

/**
 * Accepts kernels whose result the GPU can produce when it first needs it. A deferred call is
 * recorded as its destination's pending write; `run` is the software kernel that settles it.
 */
export interface BurikoGpuDeferrer {
  /** `run` executes the software kernel with the given arguments, never deferring again. */
  defer(
    kernel: BurikoGpuKernel,
    args: readonly unknown[],
    run: (args: readonly unknown[]) => unknown,
  ): boolean;
}
let deferrer: BurikoGpuDeferrer | null = null;

/** Installed while browser-optimized GPU compositing is active. */
export function setBurikoGpuDeferrer(value: BurikoGpuDeferrer | null): void {
  deferrer = value;
}
export function burikoGpuDeferrer(): BurikoGpuDeferrer | null {
  return deferrer;
}

/** The GPU target a kernel's destination belongs to, if any. */
export function burikoGpuTarget(bitmap: unknown): BurikoGpuKernelTarget | null {
  const storage = (bitmap as BurikoBitmap | null | undefined)?.storage;
  return storage instanceof BurikoGpuTargetStorage ? storage.target : null;
}
