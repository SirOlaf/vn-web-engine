import {ArtemisTween} from './tween.js';
function int32(value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw Error('Unsupported Artemis int32 tween value');
}
/** Default ed9d0/eccf0 audio tween: curve 0, no delay/repeat/yoyo. Interpolation is
 * float64, truncated toward zero before calling the integer setter. No timer is
 * invented here; the owner steps it. */
export class ArtemisLinearIntegerTween extends ArtemisTween {
  constructor(
    hash: string,
    from: number,
    to: number,
    milliseconds: number,
    apply: (value: number) => void,
    onComplete: () => void = () => {},
  ) {
    int32(from);
    int32(to);
    int32(milliseconds);
    super(hash, from, to, milliseconds, apply, onComplete);
  }
  /** TTween<int> setter conversion: truncation toward zero. */
  protected override convert(value: number): number {
    return Math.trunc(value) | 0;
  }
}

/** TTween<float> (0x1400ef000, vtable 0x140369b10: step 0x1400ee310, finish 0x1400ee280)
 * is the same template as TTween<int> except that interpolated values are rounded to
 * float32 instead of truncated. Endpoints are stored as float64 from float arguments. */
export class ArtemisLinearFloatTween extends ArtemisLinearIntegerTween {
  protected override convert(value: number): number {
    return Math.fround(value);
  }
}
