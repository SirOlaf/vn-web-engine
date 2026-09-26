import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {applyBurikoBitmapColorEffect} from './bitmap-color-effects.js';

export interface BurikoSpriteEffect {
  selector: number;
  color: number;
  opacity: number;
}

/** The sixteen embedded CDspObjSprite records at +418, each three native DWORDs. */
export class BurikoSpriteEffects {
  private readonly records: BurikoSpriteEffect[] = Array.from({length: 16}, () => ({
    selector: 0,
    color: 0,
    opacity: 0,
  }));
  constructor(readonly compositor: BurikoBitmapCompositor) {}

  /** 060ef0 validates the slot before the selector and stores all three values. */
  set(
    index: number,
    selector: number,
    color: number,
    opacity: number,
  ): 0 | 0x8000000f | 0x80000010 {
    index >>>= 0;
    selector >>>= 0;
    if (index > 15) return 0x8000000f;
    if (selector > 5) return 0x80000010;
    this.records[index] = {selector, color: color >>> 0, opacity: opacity >>> 0};
    return 0;
  }

  /** 060e40 tests the sixteen selectors, without treating opacity zero as disabled. */
  get active(): boolean {
    return this.records.some((record) => record.selector !== 0);
  }

  /** 060db0 uses an optional first source, then the actual destination for subsequent effects. */
  apply(destination: BurikoBitmap, source: BurikoBitmap | null = null): 0 | 1 {
    if (!this.active) return 0;
    let input = source ?? destination;
    for (const record of this.records) {
      if (record.selector === 0) continue;
      applyBurikoBitmapColorEffect(
        this.compositor,
        destination,
        input,
        record.selector,
        record.color,
        record.opacity,
        true,
      );
      input = destination;
    }
    return 1;
  }
}
