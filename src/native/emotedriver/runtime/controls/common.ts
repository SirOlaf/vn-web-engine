/** Helpers shared by the `emote::EP*` controls. */

export const f32 = Math.fround;

/** One queued `SetVariable` request (12-byte deque entry: value, frames, weight). */
export interface EmoteControlRequest {
  readonly value: number;
  readonly frames: number;
  readonly weight: number;
}

/** 0x100051f0: 1 when the argument is positive, otherwise −1 (also for NaN and 0). */
export const emoteSign = (value: number): number => (value > 0 ? 1 : -1);

/**
 * `pow` as called through the CRT (`_CIpow` 0x100680b0). The native SSE2 `pow` and
 * `Math.pow` can differ in the last bit of the double result; the result is rounded to
 * float by every caller, so a difference shows only near float rounding boundaries.
 */
export const crtPow = Math.pow;

/** Conversion of the PSB loaders' integer reads (`_ftol` 0x10068690): truncation. */
export const ftol = (value: number): number => Math.trunc(value) | 0;
