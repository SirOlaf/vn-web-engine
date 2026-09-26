import {AokanaProcedure, AokanaProcedureState} from './procedure.js';
import {AokanaNativeClock} from './clock.js';
import {AokanaResourceLoadingState, type AokanaResourceBuffer, type AokanaResourceResult} from './resource-loading.js';
import {terminatedNativeBytes} from './program-files.js';
import type {AokanaBpOpcodeContext} from './types.js';

export interface AokanaLoadProcedureOptions {
  readonly cacheEligible?: boolean;
  readonly deferCacheLookup?: boolean;
  readonly silentFailures?: boolean;
}

/** CProcLoad 07B030/07AEA0; bitmap subclasses provide the native pure virtual completion. */
export abstract class AokanaLoadProcedure extends AokanaProcedure {
  readonly output: AokanaResourceBuffer = {bytes: null};
  readonly result: AokanaResourceResult = {value: 0};
  readonly archive: Uint8Array;
  readonly name: Uint8Array;
  failure: number | null = null;
  protected cacheSelected = false;
  protected cacheMiss = false;
  private readonly silentFailures: boolean;

  protected constructor(
    readonly context: AokanaBpOpcodeContext, procedures: AokanaProcedureState, clock: AokanaNativeClock,
    readonly loading: AokanaResourceLoadingState, archive: Uint8Array | null, name: Uint8Array,
    options: AokanaLoadProcedureOptions = {},
  ) {
    super(context.thread, procedures, clock);
    loading.enterProcedure();
    this.archive = this.copyName(archive ?? Uint8Array.of(0));
    this.name = this.copyName(name);
    this.silentFailures = options.silentFailures === true;
    if (options.deferCacheLookup !== true) this.selectCache(options.cacheEligible ?? true);
  }

  /** 07ACD0 consults the optional whole-resource cache only for an eligible constructor. */
  protected selectCache(eligible: boolean): boolean {
    this.cacheSelected = eligible && this.loading.cache.enabled;
    const cached = this.cacheSelected ? this.loading.cache.read(this.archiveName, this.name) : null;
    this.cacheMiss = this.cacheSelected && cached === null;
    if (cached !== null) { this.output.bytes = cached; this.result.value = cached.length; }
    return cached !== null;
  }

  private copyName(bytes: Uint8Array): Uint8Array {
    const copy = terminatedNativeBytes(bytes).slice();
    if (copy.length > 0x30c) throw new RangeError('Aokana load procedure name exceeds its native field');
    this.loading.resources.files.text.lowercase({bytes: copy, offset: 0});
    return copy;
  }

  get archiveName(): Uint8Array | null { return this.archive[0] === 0 ? null : this.archive; }

  /** Base 07AE90 returns zero; derived 09B740 supplies the image-synthesis state machine. */
  protected advance(): number { return 0; }
  protected abstract complete(): number | Promise<number>;

  async poll(): Promise<number> {
    this.consumeMessages();
    const step = this.advance();
    if (step === 0) {
      if (this.result.value === 0) return 0;
      if (this.result.value >>> 0 === 0xffffffff) {
        this.failure = 3;
        return this.silentFailures ? 1 : -1;
      }
      if (this.cacheSelected && this.cacheMiss) {
        if (this.output.bytes === null) throw new Error('Aokana load procedure has no successful resource bytes');
        this.loading.cache.insert(this.archiveName, this.name, this.output.bytes.subarray(0, this.result.value >>> 0));
      }
      return Number(await this.complete() !== 0);
    }
    if (step === 1) return 0;
    this.failure = step;
    return this.silentFailures ? 1 : -1;
  }

  override dispose(): void {
    this.loading.leaveProcedure();
    this.output.bytes = null;
    this.output.initialized = undefined;
    super.dispose();
  }
}
