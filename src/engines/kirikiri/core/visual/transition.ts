/**
 * Transition handler interfaces and the provider registry (krkrz `visual/transhandler.h`,
 * `visual/TransIntf.cpp`). Providers (`crossfade`, `universal`, `scroll` in the core, more from
 * plugins such as `extrans.dll`) register by name; `Layer.beginTransition` finds one and drives
 * its handler from the layer drawing pipeline.
 */
import {throwTjsError} from '../../tjs2/runtime/errors.js';
import {failed, type Dispatch} from '../../tjs2/runtime/interface.js';
import {VariantSlot} from '../../tjs2/runtime/slot.js';
import {asInteger, asString, type ObjectVariant, type Variant} from '../../tjs2/runtime/variant.js';
import {closurePropGet} from '../../tjs2/runtime/dispatch.js';
import type {TvpBaseBitmap} from './base-bitmap.js';

/** `tTVPTransType`. */
export const ttSimple = 0;
export const ttExchange = 1;

/** `tTVPTransUpdateType`. */
export const tutDivisibleFade = 0;
export const tutDivisible = 1;
export const tutGiveUpdate = 2;

/** `iTVPScanLineProvider`: rows are byte addresses in the core memory. */
export interface TvpScanLineProvider {
  readonly width: number;
  readonly height: number;
  /** Bits per pixel. */
  readonly pixelFormat: number;
  readonly pitchBytes: number;
  scanLine(line: number): number;
  scanLineForWrite(line: number): number;
}

/** `tTVPScanLineProviderForBaseBitmap`. */
export class TvpBaseBitmapScanLineProvider implements TvpScanLineProvider {
  constructor(public bitmap: TvpBaseBitmap) {}
  attach(bitmap: TvpBaseBitmap): void {
    this.bitmap = bitmap;
  }
  get width(): number {
    return this.bitmap.width;
  }
  get height(): number {
    return this.bitmap.height;
  }
  get pixelFormat(): number {
    return this.bitmap.bpp;
  }
  get pitchBytes(): number {
    return this.bitmap.pitchBytes;
  }
  scanLine(line: number): number {
    return this.bitmap.scanLine(line);
  }
  scanLineForWrite(line: number): number {
    return this.bitmap.scanLineForWrite(line);
  }
}

/** `iTVPSimpleOptionProvider`. */
export interface TvpSimpleOptionProvider {
  /** The option as an integer, or null when absent. */
  getAsNumber(name: string): bigint | null;
  getAsString(name: string): string | null;
  /** Stores the option value to `dest`; false when absent. */
  getValue(name: string, dest: VariantSlot): boolean;
  getDispatchObject(): Dispatch | null;
}

/** `tTVPSimpleOptionProvider` over the options object of `beginTransition`. */
export class TvpObjectOptionProvider implements TvpSimpleOptionProvider {
  constructor(private readonly object: ObjectVariant) {}
  getValue(name: string, dest: VariantSlot): boolean {
    if (!this.object.object) return false;
    return !failed(closurePropGet(this.object, 0, name, dest, null));
  }
  #get<T>(name: string, convert: (v: Variant) => T): T | null {
    const slot = new VariantSlot();
    try {
      return this.getValue(name, slot) ? convert(slot.value) : null;
    } finally {
      slot.clear();
    }
  }
  getAsNumber(name: string): bigint | null {
    return this.#get(name, asInteger);
  }
  getAsString(name: string): string | null {
    return this.#get(name, asString);
  }
  getDispatchObject(): Dispatch | null {
    return this.object.object;
  }
}

/** `tTVPDivisibleData`. */
export interface TvpDivisibleData {
  left: number;
  top: number;
  width: number;
  height: number;
  dest: TvpScanLineProvider;
  destLeft: number;
  destTop: number;
  src1: TvpScanLineProvider;
  src1Left: number;
  src1Top: number;
  src2: TvpScanLineProvider | null;
  src2Left: number;
  src2Top: number;
}

/** `iTVPDivisibleTransHandler`. Results are `TJS_S_TRUE` to continue, `TJS_S_FALSE` at the end. */
export interface TvpDivisibleTransHandler {
  readonly kind: 'divisible';
  release(): void;
  startProcess(tick: bigint): number;
  endProcess(): number;
  process(data: TvpDivisibleData): number;
}

/** `iTVPGiveUpdateTransHandler` (not driven by the core: `tutGiveUpdate` is refused). */
export interface TvpGiveUpdateTransHandler {
  readonly kind: 'giveUpdate';
  release(): void;
}

export type TvpTransHandler = TvpDivisibleTransHandler | TvpGiveUpdateTransHandler;

/** The result of `iTVPTransHandlerProvider::StartTransition`. */
export interface TvpTransitionStart {
  readonly type: number;
  readonly updateType: number;
  readonly handler: TvpTransHandler;
}

/** `iTVPTransHandlerProvider`. Throws (or returns a failure code) when the start fails. */
export interface TvpTransHandlerProvider {
  readonly name: string;
  startTransition(
    options: TvpSimpleOptionProvider,
    layerType: number,
    src1w: number,
    src1h: number,
    src2w: number,
    src2h: number,
  ): TvpTransitionStart | number;
}

/** `TVPAddTransHandlerProvider`, `TVPRemoveTransHandlerProvider`, `TVPFindTransHandlerProvider`. */
export class TvpTransitionRegistry {
  readonly #providers: TvpTransHandlerProvider[] = [];

  add(provider: TvpTransHandlerProvider): void {
    this.#providers.push(provider);
  }

  remove(provider: TvpTransHandlerProvider): void {
    const i = this.#providers.indexOf(provider);
    if (i >= 0) this.#providers.splice(i, 1);
  }

  /** The provider registered last under `name`; throws `TVPCannotFindTransHander`. */
  find(name: string): TvpTransHandlerProvider {
    for (let i = this.#providers.length - 1; i >= 0; i--)
      if (this.#providers[i]!.name === name) return this.#providers[i]!;
    throwTjsError('TVPCannotFindTransHander', name);
  }
}
