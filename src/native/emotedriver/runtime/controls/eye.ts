import {emoteBuild, EMOTEDRIVER_X64_SHA256, type EmoteBuild} from '../../build.js';

import type {EmoteEyeControl} from '../../../../formats/kirikiri/emote-metadata.js';
import {f32, ftol} from './common.js';
import {EmoteGraph, EmoteGraphFollower} from './graph.js';

/** Blink phases of `EPEyeControl` (+0x88). */
export const EmoteBlinkState = {
  /** Open; counts the interval down while the blink value is at `beginFrame`. */
  open: 0,
  closing: 10,
  /** Closed for blinkFrameCount / 5 frames. */
  closed: 11,
  opening: 12,
} as const;

/**
 * `emote::EPEyeControl` (vtable 0x100718dc, constructor 0x10005220, update 0x10005520).
 *
 * The eye variable follows its frame graph like an eyebrow, and an automatic blink is laid
 * over it: the blink value runs from `beginFrame` (open) to `endFrame` (closed) and back in
 * blinkFrameCount / 2.5 frames each way, holding closed for blinkFrameCount / 5 frames;
 * open intervals are uniform in [blinkIntervalMin, blinkIntervalMax). The output pulls the
 * graph value towards `endFrame` in proportion to the blink when the graph value lies in
 * [beginFrame, endFrame].
 */
export class EmoteEye {
  readonly driverSha256: EmoteBuild;
  private readonly x64: boolean;
  readonly label: string;
  /** +0x4, +0xc. */
  readonly beginFrame: number;
  readonly endFrame: number;
  /** +0x10, +0x14, +0x18. */
  readonly intervalMin: number;
  readonly intervalMax: number;
  readonly blinkFrameCount: number;
  /** +0x94: `blinkEnabled` stored as 0 or 1. */
  blinkEnabled: number;
  readonly motion: EmoteGraphFollower;
  /** +0x88, +0x8c, +0x90. */
  blinkState: number = EmoteBlinkState.open;
  blinkValue: number;
  blinkTimer: number;

  /** `random` is the shared generator (0x10005190); the constructor draws one interval. */
  constructor(
    control: Omit<EmoteEyeControl, 'enabled' | 'unread'>,
    private readonly random: () => number,
    driverSha256?: string,
  ) {
    this.driverSha256 = emoteBuild(driverSha256);
    this.x64 = this.driverSha256 === EMOTEDRIVER_X64_SHA256;
    this.label = control.label;
    this.beginFrame = this.x64 ? f32(control.beginFrame) : ftol(control.beginFrame);
    this.endFrame = this.x64 ? f32(control.endFrame) : ftol(control.endFrame);
    this.intervalMin = f32(control.blinkIntervalMin);
    this.intervalMax = f32(control.blinkIntervalMax);
    this.blinkFrameCount = f32(control.blinkFrameCount);
    this.blinkEnabled = control.blinkEnabled ? 1 : 0;
    this.motion = new EmoteGraphFollower(
      new EmoteGraph(control.edge, control.node, this.driverSha256),
      f32(this.beginFrame),
    );
    this.blinkValue = f32(this.beginFrame);
    this.blinkTimer = this.interval(random);
  }

  /** 0x10005a10: rand · (max − min) + min. */
  setBlinkEnabled(enabled: boolean): void {
    if (!this.x64) throw Error('emotedriver: blink API requires the x64 DLL build');
    const value = enabled ? 1 : 0;
    if (value === this.blinkEnabled) return;
    this.blinkEnabled = value;
    if (value === 0) {
      this.blinkState = EmoteBlinkState.open;
      this.blinkValue = this.beginFrame;
      this.blinkTimer = this.interval(this.random);
    }
  }

  private interval(random: () => number): number {
    if (this.x64)
      return f32(f32(random() * f32(this.intervalMax - this.intervalMin)) + this.intervalMin);
    return f32(random() * (this.intervalMax - this.intervalMin) + this.intervalMin);
  }

  /** `SetVariable` on the label (0x10005460). */
  set(value: number, frames: number, weight: number, queued: boolean): void {
    this.motion.set(value, frames, weight, queued);
  }

  /** 0x10005520: one sub-step of `frames`; returns the variable value. */
  update(frames: number, random: () => number): number {
    if (this.x64) return this.updateX64(frames, random);
    this.motion.advance(frames);
    const span = this.endFrame - this.beginFrame;
    // Blink speed: frames · 2.5 / blinkFrameCount, times the frame span.
    const speed = () => (frames * 2.5) / this.blinkFrameCount;
    switch (this.blinkState) {
      case EmoteBlinkState.open:
        if (this.blinkEnabled !== 0 && ftol(this.blinkValue) === this.beginFrame) {
          this.blinkTimer = f32(this.blinkTimer - frames);
          if (this.blinkTimer <= 0) this.blinkState = EmoteBlinkState.closing;
        }
        break;
      case EmoteBlinkState.closing: {
        this.blinkValue = f32(span * speed() + this.blinkValue);
        const end = f32(this.endFrame);
        if (end <= this.blinkValue) {
          this.blinkValue = end;
          this.blinkState = EmoteBlinkState.closed;
          this.blinkTimer = f32(this.blinkFrameCount / 5);
        }
        break;
      }
      case EmoteBlinkState.closed:
        this.blinkTimer = f32(this.blinkTimer - frames);
        if (this.blinkTimer <= 0) {
          this.blinkState = EmoteBlinkState.opening;
          this.blinkTimer = this.interval(random);
        }
        break;
      case EmoteBlinkState.opening: {
        this.blinkValue = f32(this.blinkValue - speed() * span);
        const begin = f32(this.beginFrame);
        if (this.blinkValue <= begin) {
          this.blinkValue = begin;
          this.blinkState = EmoteBlinkState.open;
        }
        break;
      }
    }
    return this.output();
  }

  output(): number {
    const value = this.motion.value;
    const begin = f32(this.beginFrame),
      end = f32(this.endFrame);
    if (begin <= value && value <= end) {
      if (this.x64)
        return f32(
          f32(f32(f32(this.blinkValue - begin) * f32(end - value)) / f32(end - begin)) + value,
        );
      return f32(
        ((end - value) * (this.blinkValue - begin)) / (this.endFrame - this.beginFrame) + value,
      );
    }
    return value;
  }

  /** x64 0x180028ab0: same-call blink phase transitions and float stores. */
  private updateX64(frames: number, random: () => number): number {
    const dt = f32(frames);
    this.motion.advance(dt);
    const speed = f32(f32(dt * 2.5) / this.blinkFrameCount);
    const range = f32(this.endFrame - this.beginFrame);
    for (;;) {
      if (this.blinkState === 0) {
        if (this.blinkEnabled !== 0 && Math.trunc(this.blinkValue) === this.beginFrame) {
          this.blinkTimer = f32(this.blinkTimer - dt);
          if (this.blinkTimer <= 0) {
            this.blinkState = 10;
            continue;
          }
        }
        break;
      }
      if (this.blinkState === 10) {
        this.blinkValue = f32(this.blinkValue + f32(range * speed));
        if (this.blinkValue >= this.endFrame) {
          this.blinkState = 11;
          this.blinkValue = this.endFrame;
          this.blinkTimer = f32(this.blinkFrameCount / 5);
        }
        break;
      }
      if (this.blinkState === 11) {
        this.blinkTimer = f32(this.blinkTimer - dt);
        if (this.blinkTimer <= 0) {
          this.blinkState = 12;
          this.blinkTimer = this.interval(random);
        }
        break;
      }
      if (this.blinkState === 12) {
        this.blinkValue = f32(this.blinkValue - f32(speed * range));
        if (this.blinkValue <= this.beginFrame) {
          this.blinkValue = this.beginFrame;
          this.blinkState = 0;
          continue;
        }
        break;
      }
      break;
    }
    return this.output();
  }

  /** `AssignState` (0x1000f2a0) copies the graph motion, not the blink. */
  assign(source: EmoteEye): void {
    this.motion.assign(source.motion);
  }
}
