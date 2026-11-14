import {emoteBuild, EMOTEDRIVER_X64_SHA256, type EmoteBuild} from '../../build.js';
import {f32} from './common.js';

export interface EmoteOrbitSettings {
  readonly label: string;
  readonly interval: number;
  readonly tween: boolean;
  readonly orbitFrameList: readonly number[];
}

/** `orbitControl` entry (+0x290, 0x48 bytes, loader 0x18001b190): a cycling value list. */
export class EmoteOrbit {
  readonly driverSha256: EmoteBuild;
  readonly label: string;
  private reset = true;
  private time = 0;
  private readonly interval: number;
  private readonly tween: boolean;
  private readonly values: readonly number[];

  constructor(s: EmoteOrbitSettings, driverSha256: string) {
    this.driverSha256 = emoteBuild(driverSha256);
    if (this.driverSha256 !== EMOTEDRIVER_X64_SHA256)
      throw Error(`emotedriver: orbit control is unavailable for DLL build ${driverSha256}`);
    this.label = s.label;
    this.interval = f32(s.interval);
    this.tween = s.tween;
    this.values = s.orbitFrameList.map(f32);
  }

  /** Native 0x180022420: vector assignment copies settings and the running cursor. */
  clone(): EmoteOrbit {
    const copy = new EmoteOrbit(
      {label: this.label, interval: this.interval, tween: this.tween, orbitFrameList: this.values},
      this.driverSha256,
    );
    copy.reset = this.reset;
    copy.time = this.time;
    return copy;
  }

  /** Returns the `setVariable` call the step makes, or null. */
  step(frames: number): {value: number; frames: number} | null {
    const n = this.values.length;
    let index: number;
    if (this.reset) {
      this.time = 0;
      this.reset = false;
      index = 0;
    } else {
      const old = this.time;
      this.time = f32(f32(old + f32(frames)) % this.interval);
      index = Math.trunc(f32(f32(this.time * n) / this.interval));
      if (index === Math.trunc(f32(f32(n * old) / this.interval))) return null;
    }
    const value = this.values[index] ?? 0;
    const fr = this.tween ? f32(f32(f32(this.interval / n) * (index + 1)) - this.time) : 0;
    return {value, frames: fr};
  }
}
