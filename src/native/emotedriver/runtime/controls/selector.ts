import type {EmoteSelectorControl} from '../../../../formats/kirikiri/emote-metadata.js';
import {type EmoteControlRequest, f32, ftol} from './common.js';

/**
 * The part of an `EPTransitionControl` (0x1000c220, 0x1000c300) a selector drives;
 * `EmoteTween` (`transition.ts`) provides it.
 */
export interface EmoteSelectorTransition {
  /**
   * 0x1000c300: with 0 frames it advances the state machine without time (starting a queued
   * request); the selector reads the first value.
   */
  step(frames: number): ArrayLike<number>;
  /** Running (+0x20 ≠ 0) or holding queued requests (+0x14 ≠ 0). */
  readonly busy: boolean;
  /** 0x1000c220. */
  set(values: ArrayLike<number>, frames: number, power: number, queue: boolean): void;
}

/** Ratios below this skip an idle option (float at 0x10072840, FLT_EPSILON). */
const SELECTOR_EPSILON = f32(1.1920928955078125e-7);

/**
 * `emote::EPSelectorControl` (vtable 0x10071914, constructor 0x1000b540, update 0x1000b870):
 * a selected option index; selecting drives each option's transition control to its
 * `onValue` (selected) or `offValue`, over frames scaled by the remaining distance.
 * `optionList[].label` names a transition control, resolved by label when loading
 * (0x10019a50); an unknown label leaves the option without one.
 */
export class EmoteSelector {
  readonly label: string;
  readonly options: readonly {
    readonly transition: EmoteSelectorTransition | null;
    readonly offValue: number;
    readonly onValue: number;
  }[];
  /** +0x4 requests, +0x1c selected index, +0x20 state, +0x24 rate, +0x28 progress. */
  requests: EmoteControlRequest[] = [];
  selected = 0;
  state = 0;
  rate = 0;
  progress = 0;

  constructor(
    control: EmoteSelectorControl,
    transition: (label: string) => EmoteSelectorTransition | null,
  ) {
    this.label = control.label;
    this.options = control.optionList.map((o) => ({
      transition: transition(o.label),
      offValue: f32(o.offValue),
      onValue: f32(o.onValue),
    }));
    this.select(0, 0, 0);
  }

  /** 0x1000b6a0: selects option `index` and retargets every option's transition. */
  private select(index: number, frames: number, weight: number): void {
    this.selected = index;
    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i]!;
      if (!option.transition) continue;
      const target = i === this.selected ? option.onValue : option.offValue;
      const current = option.transition.step(0)[0]!;
      const ratio = f32(Math.abs(f32((current - target) / (option.onValue - option.offValue))));
      if (!option.transition.busy && Math.abs(ratio) < SELECTOR_EPSILON) continue;
      option.transition.set([target], f32(ratio * frames), weight, false);
    }
  }

  /** `SetVariable` on the label (0x1000b7d0). */
  set(value: number, frames: number, weight: number, queued: boolean): void {
    if (!(frames > 0)) {
      this.requests = [];
      this.state = 0;
      this.select(ftol(f32(value)), 0, 0);
      return;
    }
    if (!queued) {
      this.requests = [];
      this.state = 0;
    }
    this.requests.push({value: f32(value), frames: f32(frames), weight: f32(weight)});
  }

  /** 0x1000b870: one sub-step; returns the selected index. */
  update(frames: number): number {
    if (this.state === 1) {
      const t = f32(this.rate * frames + this.progress);
      this.progress = t;
      if (1 <= t) {
        this.progress = 1;
        this.state = 0;
      }
    } else if (this.state === 0) {
      const request = this.requests.shift();
      if (request) {
        this.select(ftol(request.value), request.frames, request.weight);
        this.state++;
        this.rate = f32(1 / request.frames);
        this.progress = 0;
      }
    }
    return f32(this.selected);
  }

  /** Selector part of `Skip` (0x1001a680). */
  skip(): void {
    const last = this.requests[this.requests.length - 1];
    if (!last) {
      if (this.state !== 0) {
        this.state = 0;
        this.select(this.selected, 0, 0);
      }
      return;
    }
    this.state = 0;
    this.select(ftol(last.value), 0, 0);
    this.requests = [];
  }

  /** Running or queued (`IsAnimating` 0x100108f0). */
  get busy(): boolean {
    return this.state !== 0 || this.requests.length !== 0;
  }

  assign(source: EmoteSelector): void {
    this.requests = source.requests.slice();
    this.selected = source.selected;
    this.state = source.state;
    this.rate = source.rate;
    this.progress = source.progress;
  }
}
