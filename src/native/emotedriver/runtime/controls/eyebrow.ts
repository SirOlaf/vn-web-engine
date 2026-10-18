import type {EmoteEyebrowControl} from '../../../../formats/kirikiri/emote-metadata.js';
import {f32, ftol} from './common.js';
import {EmoteGraph, EmoteGraphFollower} from './graph.js';

/**
 * `emote::EPEyebrowControl` (vtable 0x100718e4, constructor 0x10007b00, update 0x10007da0):
 * the variable follows `SetVariable` requests along the eyebrow frame graph, starting at
 * `beginFrame`.
 */
export class EmoteEyebrow {
  readonly label: string;
  readonly motion: EmoteGraphFollower;

  constructor(control: EmoteEyebrowControl) {
    this.label = control.label;
    this.motion = new EmoteGraphFollower(
      new EmoteGraph(control.edge, control.node),
      f32(ftol(control.beginFrame)),
    );
  }

  /** `SetVariable` on the label (0x10007ce0). */
  set(value: number, frames: number, weight: number, queued: boolean): void {
    this.motion.set(value, frames, weight, queued);
  }

  /** 0x10007da0: one sub-step of `frames`; returns the variable value (+0x58). */
  update(frames: number): number {
    this.motion.advance(frames);
    return this.motion.value;
  }

  assign(source: EmoteEyebrow): void {
    this.motion.assign(source.motion);
  }
}
