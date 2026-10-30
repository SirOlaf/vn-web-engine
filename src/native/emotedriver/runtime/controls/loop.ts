import type {EmoteLoopControl} from '../../../../formats/kirikiri/emote-metadata.js';
import {f32} from './common.js';

/**
 * `emote::EPLoopControl` (vtable 0x100718f4, constructed inline in 0x1001a7f0, update
 * 0x1000a580): cycles `var_loop` through `transitionList` entries [from, to, frames],
 * interpolating linearly within the current entry.
 */
export class EmoteLoop {
  readonly variable: string;
  readonly transitions: readonly (readonly [number, number, number])[];
  /** +0x4 entry index, +0x8 time within the entry. */
  index = 0;
  time = 0;

  constructor(control: EmoteLoopControl) {
    this.variable = control.var_loop;
    this.transitions = control.transitionList.map(([a, b, d]) => [f32(a), f32(b), f32(d)] as const);
  }

  /**
   * 0x1000a580: one sub-step; returns the variable value. The native loop never ends for
   * an entry of non-positive length (or an empty list); such an entry stops the carry here.
   */
  update(frames: number): number {
    const list = this.transitions;
    if (!list.length) return NaN;
    this.time = f32(frames + this.time);
    while (list[this.index]![2] <= this.time && list[this.index]![2] > 0) {
      this.time = f32(this.time - list[this.index]![2]);
      this.index = (this.index + 1) % list.length;
    }
    const [from, to, length] = list[this.index]!;
    const t = f32(this.time / length);
    return f32((1 - t) * from + t * to);
  }
}
