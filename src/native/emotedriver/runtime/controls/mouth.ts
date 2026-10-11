import type {EmoteMouthControl} from '../../../../formats/kirikiri/emote-metadata.js';
import {type EmoteControlRequest, crtPow, f32, ftol} from './common.js';

/**
 * `emote::EPMouthControl` (vtable 0x100718fc, constructed inline in 0x10018920, update
 * 0x1000a7a0). Two variables:
 *
 * - `label`: the mouth shape frame, an integer set directly by `SetVariable(label)`
 *   (truncated, 0x10012510 case 6) and initially `beginFrame`;
 * - `talkLabel`: the lip-sync level. The client feeds it with `SetVariable(talkLabel,
 *   level, frames, easing)` from the voice sample levels; each request eases the level from
 *   its current value to the target over `frames` with progress^weight.
 */
export class EmoteMouth {
  readonly label: string;
  readonly talkLabel: string;
  /** +0x4 request queue. */
  requests: EmoteControlRequest[] = [];
  /** +0x1c: 0 idle, 1 easing. */
  state = 0;
  /** +0x20: mouth frame (int). */
  frame: number;
  /** +0x24 current level, +0x28 from, +0x2c to, +0x30 weight, +0x34 progress, +0x38 rate. */
  level = 0;
  from = 0;
  to = 0;
  weight = 0;
  progress = 0;
  rate = 0;

  constructor(control: EmoteMouthControl) {
    this.label = control.label;
    this.talkLabel = control.talkLabel;
    this.frame = ftol(control.beginFrame);
  }

  /** `SetVariable(label)`: the frame, truncated (`_ftol`). */
  setFrame(value: number): void {
    this.frame = ftol(f32(value));
  }

  /** `SetVariable(talkLabel)` (0x1000a710). */
  set(value: number, frames: number, weight: number, queued: boolean): void {
    if (!(frames > 0)) {
      this.requests = [];
      this.level = f32(value);
      this.state = 0;
      return;
    }
    if (!queued) {
      this.requests = [];
      this.state = 0;
    }
    this.requests.push({value: f32(value), frames: f32(frames), weight: f32(weight)});
  }

  /** 0x1000a7a0: one sub-step; returns [label value, talkLabel value]. */
  update(frames: number): [frame: number, level: number] {
    if (this.state === 1) {
      const t = f32(this.rate * frames + this.progress);
      this.progress = t;
      if (1 <= t) {
        this.state = 0;
        this.progress = 1;
        this.level = this.to;
      } else this.level = f32(f32(crtPow(t, this.weight)) * (this.to - this.from) + this.from);
    } else if (this.state === 0) {
      const request = this.requests.shift();
      if (request) {
        this.from = this.level;
        this.state = 1;
        this.to = request.value;
        this.rate = f32(1 / request.frames);
        this.weight = request.weight;
        this.progress = 0;
      }
    }
    return [f32(this.frame), this.level];
  }

  /** Mouth part of `Skip` (0x10019220): the last queued level, or the running target. */
  skip(): void {
    const last = this.requests[this.requests.length - 1];
    if (!last) {
      if (this.state !== 0) {
        this.state = 0;
        this.level = this.to;
      }
      return;
    }
    this.state = 0;
    this.level = last.value;
    this.requests = [];
  }

  /** Running or queued (`IsAnimating` 0x100108f0). */
  get busy(): boolean {
    return this.state !== 0 || this.requests.length !== 0;
  }

  /** `AssignState` copies every field (0x1000f2a0). */
  assign(source: EmoteMouth): void {
    this.requests = source.requests.slice();
    this.state = source.state;
    this.frame = source.frame;
    this.level = source.level;
    this.from = source.from;
    this.to = source.to;
    this.weight = source.weight;
    this.progress = source.progress;
    this.rate = source.rate;
  }
}
