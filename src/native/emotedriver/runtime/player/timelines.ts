import {emoteBuild, EMOTEDRIVER_X64_SHA256, type EmoteBuild} from '../../build.js';
import type {EmoteTimeline} from '../../../../formats/kirikiri/emote-metadata.js';
import {EmoteTween, easingPower} from '../controls/transition.js';
import type {EmoteApiLogScope} from './api-log.js';

/**
 * Timelines of `MEmotePlayer` (`timelineControl`): the label lists (`p+0x1a0` main,
 * `p+0x1b0` difference), the state map (`p+0x180`, label → state) and the playing list
 * (`p+0x190`). Addresses refer to `emotedriver.dll` SHA-256 `a3b693b6…5e70b3a86`.
 *
 * A timeline keyframe's value is the target of a variable transition that starts when the
 * keyframe is passed and lasts until one frame before the next keyframe (0x1001eab0).
 * Plain timelines write variables with `SetVariable`; difference timelines (flag 2) drive a
 * per-track tween whose output is added to the variable, weighted by the blend ratio, when
 * variables are applied (0x1001f4e0).
 */

const f32 = Math.fround;

/** `EMOTE_TIMELINE_PLAY_PARALLEL`. */
const PARALLEL = 1;
/** `EMOTE_TIMELINE_PLAY_DIFFERENCE`. */
const DIFFERENCE = 2;
/** Set by `Pass` (0x1001f180) on a difference timeline that is fading out. */
const PASSING = 4;

/** x64 0x18001ff10: fold fullwidth ASCII; native non-BMP labels match nothing. */
export function normalizeTimelineLabel(label: string): string | null {
  let out = '';
  for (const ch of label) {
    const c = ch.codePointAt(0)!;
    if (c > 0xffff) return null;
    out += c >= 0xff01 && c <= 0xff5e ? String.fromCharCode(c - 0xfee0) : ch;
  }
  return out;
}

/** What timelines call back into on their player. */
export interface EmoteTimelineHost {
  readonly apiLog?: EmoteApiLogScope | null;
  /** `p+0x30` (`queuing`): tweens queue instead of replacing. */
  readonly queuing: boolean;
  /** 0x10012510 (`SetVariable` core; `easing` is converted there). */
  setVariable(label: string, value: number, frames: number, easing: number): void;
}

/** Track frame (0x10 bytes): time, empty (type 0), value, easing. */
interface TrackFrame {
  readonly time: number;
  readonly empty: boolean;
  readonly value: number;
  readonly easing: number;
}

/** Track (0x38 bytes); only variables with frames get one (0x1001d980). */
class Track {
  /** Difference tween (+0x30), created on the first difference play (0x1001e650). */
  tween: EmoteTween | null = null;
  /** Difference output (+0x34), written by the fade step (0x1001edf0). */
  value = 0;
  constructor(
    readonly label: string,
    /** Label in `instantVariableList` (+0x1c). */
    readonly instant: boolean,
    readonly frames: readonly TrackFrame[],
  ) {}
}

/** Timeline state (map value at node +0x28). Fields are zero until the body is loaded. */
export class EmoteTimelineState {
  readonly driverSha256: EmoteBuild;
  /** +0x0 non-null once loaded (0x1001d980 runs on the first play). */
  loaded = false;
  tracks: Track[] = [];
  /** Blend ratio tween (+0x4), output (+0x24), stop-when-done flag as float (+0x28). */
  blend: EmoteTween | null = null;
  blendRatio = 0;
  stopWhenBlendDone = 0;
  /** Play flags (+0x8). */
  flags = 0;
  /** x64: a loop has wrapped since play. */
  stepped = false;
  /** +0x14, +0x18, +0x1c, +0x20. A negative `loopBegin` means no loop. */
  loopBegin = 0;
  loopEnd = 0;
  lastTime = 0;
  time = 0;
  /** Current segment start per track (vector at +0x2c, rebuilt by every seek). */
  frameIndex: number[] = [];

  constructor(
    readonly definition: EmoteTimeline | null,
    driverSha256?: string,
  ) {
    this.driverSha256 = emoteBuild(driverSha256);
  }

  /** 0x1001d980. */
  load(instant: ReadonlySet<string>): void {
    const d = this.definition;
    this.loaded = true;
    this.blend = new EmoteTween(1, this.driverSha256);
    this.tracks = [];
    if (!d) return;
    this.loopBegin = f32(d.loopBegin);
    this.loopEnd = f32(d.loopEnd);
    // The reader already replaced a negative `lastTime` by the latest frame time (≥ 0).
    this.lastTime = f32(d.lastTime);
    if (this.driverSha256 !== EMOTEDRIVER_X64_SHA256) {
      this.blendRatio = 1;
      this.stopWhenBlendDone = 0;
      this.blend.set([1], 0, 0, false);
    }
    for (const v of d.variables) {
      if (v.frames.length === 0) continue;
      const frames = v.frames.map((fr) => ({
        time: f32(fr.time),
        empty: fr.type === 0,
        // A string value aborts natively ("can't convert value to float"; krkr files only).
        value: typeof fr.value === 'number' ? f32(fr.value) : 0,
        easing: f32(fr.easing ?? 0),
      }));
      this.tracks.push(new Track(v.label, instant.has(v.label), frames));
    }
  }

  get loops(): boolean {
    return this.loopBegin >= 0;
  }
}

/** Time of the frame after `index`; the native reads past the end for a last frame with content. */
function nextTime(frames: readonly TrackFrame[], index: number, fallback: number): number {
  return frames[index + 1]?.time ?? fallback;
}

function frameCountTo(frames: readonly TrackFrame[], index: number, t: number): number {
  const d = f32(f32((frames[index + 1]?.time ?? 0) - t) - 1);
  return d >= 0 ? d : 0;
}

export class EmoteTimelineSet {
  readonly driverSha256: EmoteBuild;
  private readonly x64: boolean;
  /** `p+0x1a0`, `p+0x1b0`: labels in list order (duplicates kept). */
  readonly mainLabels: string[] = [];
  readonly diffLabels: string[] = [];
  /** `p+0x180`. */
  readonly states = new Map<string, EmoteTimelineState>();
  /** `p+0x190`. */
  playing: string[] = [];

  constructor(
    private readonly host: EmoteTimelineHost,
    private readonly instant: ReadonlySet<string>,
    driverSha256?: string,
  ) {
    this.driverSha256 = emoteBuild(driverSha256);
    this.x64 = this.driverSha256 === EMOTEDRIVER_X64_SHA256;
  }

  private key(label: string): string | null {
    return this.x64 ? normalizeTimelineLabel(label) : label;
  }

  private find(label: string): EmoteTimelineState | undefined {
    const key = this.key(label);
    return key === null ? undefined : this.states.get(key);
  }

  /** 0x1001d4a0: `label` and optional `diff` of every entry; bodies load on first play. */
  loadList(timelines: readonly EmoteTimeline[]): void {
    for (const t of timelines) {
      (t.diff ? this.diffLabels : this.mainLabels).push(t.label);
      const key = this.key(t.label);
      if (key !== null && !this.states.has(key))
        this.states.set(key, new EmoteTimelineState(t, this.driverSha256));
    }
  }

  /** 0x1001caf0. Without the parallel flag every playing timeline stops first. */
  play(label: string, flags: number): void {
    try {
      if (this.host.apiLog?.enter()) this.host.apiLog.record('PlayTimeline', [label, flags]);
      if ((flags & PARALLEL) === 0) this.stop('');
      const key = this.key(label);
      if (key === null) return;
      const state = this.states.get(key);
      if (!state) return;
      if (!this.playing.includes(key)) this.playing.push(key);
      if (!state.loaded) state.load(this.instant);
      if (this.x64) {
        state.blendRatio = 1;
        state.stopWhenBlendDone = 0;
        state.stepped = false;
        state.blend!.set([1], 0, 0, false);
      }
      this.setupPlay(state, flags);
      this.seek(state, 0);
    } finally {
      this.host.apiLog?.leave();
    }
  }

  /** 0x1001e650: stores the flags; difference tracks get a tween reset to 0. */
  private setupPlay(state: EmoteTimelineState, flags: number): void {
    state.flags = flags;
    if ((flags & DIFFERENCE) === 0) return;
    for (const track of state.tracks) {
      if (track.instant) continue;
      if (!track.tween) track.tween = new EmoteTween(1, this.driverSha256);
      else track.tween.set([0], 0, 0, false);
    }
  }

  /** 0x1001cc90. The empty label asks whether any timeline plays. */
  isPlaying(label: string): boolean {
    const key = this.key(label);
    if (key === '') return this.playing.length !== 0;
    return key !== null && this.playing.includes(key);
  }

  /** 0x1001cdc0. The empty label stops all. */
  stop(label: string): void {
    try {
      if (this.host.apiLog?.enter()) this.host.apiLog.record('StopTimeline', [label]);
      const key = this.key(label);
      if (key === '') {
        this.playing = [];
        return;
      }
      if (key === null) return;
      if (this.x64) {
        this.playing = this.playing.filter((name) => name !== key);
        return;
      }
      const i = this.playing.indexOf(key);
      if (i >= 0) this.removeAt(i);
    } finally {
      this.host.apiLog?.leave();
    }
  }

  /** 0x1001cf30. Only loaded timelines; the blend tween advances only in the fade step. */
  setBlendRatio(label: string, value: number, frames: number, easing: number, stop: boolean): void {
    try {
      if (this.host.apiLog?.enter())
        this.host.apiLog.record('SetTimelineBlendRatio', [label, value, frames, easing, stop]);
      const state = this.find(label);
      if (!state?.loaded || !state.blend) return;
      state.blend.set(
        [f32(value)],
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.host.queuing,
      );
      state.stopWhenBlendDone = stop ? 1 : 0;
    } finally {
      this.host.apiLog?.leave();
    }
  }

  /** 0x1001d090. */
  getBlendRatio(label: string): number {
    const state = this.find(label);
    return state?.loaded ? state.blendRatio : 0;
  }

  /** 0x1001d1c0: `loopBegin >= 0`; an unloaded state reads 0 and counts as looping. */
  isLoop(label: string): boolean {
    const state = this.find(label);
    return state ? state.loopBegin >= 0 : false;
  }

  /** 0x1001c9d0 (slot 42). */
  playingLabelAt(index: number): string {
    return this.playing[index] ?? '';
  }

  totalFrameCount(label: string): number {
    const state = this.find(label);
    return state && state.loopBegin < 0 ? state.lastTime : 0;
  }

  playingFlagsAt(index: number): number {
    if (this.x64) {
      const state = this.states.get(this.playingLabelAt(index));
      return state ? (state.flags | PARALLEL) >>> 0 : 0;
    }
    const label = index < this.playing.length ? this.playing[index]! : '';
    const state = this.states.get(label);
    return state ? state.flags | 1 : 0;
  }

  private state(label: string): EmoteTimelineState {
    let state = this.states.get(label);
    if (!state) {
      // 0x10020920 inserts a missing key; every playing label is in the map.
      state = new EmoteTimelineState(
        this.x64
          ? null
          : {
              label,
              diff: false,
              loopBegin: 0,
              loopEnd: 0,
              lastTime: 0,
              variables: [],
              unread: {},
            },
        this.driverSha256,
      );
      this.states.set(label, state);
    }
    return state;
  }

  /** 0x1001e780: positions every track at `time` and starts the segment's transition. */
  seek(state: EmoteTimelineState, time: number): void {
    if (this.x64) {
      this.seekX64(state, time);
      return;
    }
    const t = f32(time);
    state.frameIndex = [];
    const passing = (state.flags & PASSING) !== 0;
    for (const track of state.tracks) {
      if (passing && track.instant) continue;
      const diff = (state.flags & DIFFERENCE) !== 0 && !track.instant;
      const frames = track.frames;
      let index = 0;
      for (let i = 0; i < frames.length - 1; i++) {
        index = i;
        if (frames[i]!.time <= t && t < frames[i + 1]!.time) break;
        index = i + 1;
      }
      state.frameIndex.push(index);
      const frame = frames[index]!;
      if (frame.empty) continue;
      const frameCount = Math.max(0, f32(nextTime(frames, index, t) - t - 1));
      if (diff) {
        track.tween?.set(
          [frame.value],
          frameCount,
          easingPower(frame.easing, this.driverSha256),
          this.host.queuing,
        );
      } else {
        this.host.setVariable(track.label, frame.value, frameCount, frame.easing);
      }
    }
    state.time = t;
  }

  /**
   * 0x1001eab0: passes the keyframes up to `time` (`inclusive`: frames at exactly `time`
   * too). Passing a keyframe completes the previous transition and starts the next one.
   */
  evaluate(state: EmoteTimelineState, time: number, inclusive: boolean): void {
    if (this.x64) {
      this.evaluateX64(state, time, inclusive);
      return;
    }
    const t = f32(time);
    const passing = (state.flags & PASSING) !== 0;
    state.tracks.forEach((track, i) => {
      if (passing && track.instant) return;
      const diff = (state.flags & DIFFERENCE) !== 0 && !track.instant;
      const frames = track.frames;
      // With skipped tracks the index vector is shorter than the track list (native indexes
      // it by track number regardless).
      let index = state.frameIndex[i] ?? 0;
      while (index < frames.length - 1) {
        const ft = frames[index + 1]!.time;
        if (!(inclusive ? ft <= t : ft < t)) break;
        const current = frames[index]!;
        if (!current.empty) {
          if (diff) track.tween?.set([current.value], 0, 0, this.host.queuing);
          else this.host.setVariable(track.label, current.value, 0, 0);
        }
        index++;
        const next = frames[index]!;
        if (!next.empty) {
          const frameCount = Math.max(0, f32(nextTime(frames, index, t) - t - 1));
          if (diff) {
            track.tween?.set(
              [next.value],
              frameCount,
              easingPower(next.easing, this.driverSha256),
              this.host.queuing,
            );
          } else {
            this.host.setVariable(track.label, next.value, frameCount, next.easing);
          }
        }
      }
      state.frameIndex[i] = index;
    });
    state.time = t;
  }

  /** 0x1001edf0: blend ratio and difference track tweens. */
  private fade(state: EmoteTimelineState, frames: number): void {
    if (this.x64 && (state.flags & DIFFERENCE) === 0) return;
    if (state.blend) state.blendRatio = state.blend.step(frames)[0]!;
    for (const track of state.tracks) {
      if (track.instant || !track.tween) continue;
      track.value = track.tween.step(frames)[0]!;
    }
  }

  /** 0x1001ee80: advances every playing timeline; loops, ends and removes. */
  advance(frames: number): void {
    if (this.x64) {
      this.advanceX64(frames);
      return;
    }
    let dt = f32(frames);
    if (dt === 0) return;
    let i = 0;
    while (i < this.playing.length) {
      const state = this.state(this.playing[i]!);
      if (!state.loops) {
        this.evaluate(state, f32(state.time + dt), true);
        if (state.flags & DIFFERENCE) this.fade(state, dt);
        if (state.lastTime <= state.time) {
          this.removeAt(i);
          continue;
        }
      } else {
        while (state.loopEnd <= state.time + dt) {
          dt = f32(dt - (state.loopEnd - state.time));
          this.evaluate(state, state.loopEnd, false);
          this.seek(state, state.loopBegin);
        }
        this.evaluate(state, f32(state.time + Math.max(dt, 0)), true);
        if (state.flags & DIFFERENCE) this.fade(state, dt);
      }
      if (state.stopWhenBlendDone !== 0 && state.blend && !state.blend.busy) {
        this.removeAt(i);
        continue;
      }
      i++;
      // The loop adjustment of `dt` carries over to the following timelines (native reuses the
      // argument slot).
    }
  }

  /** 0x1001f0b0 (`Skip`): one-shot timelines run to their end and stop; loops finish blending. */
  skip(): void {
    let i = 0;
    while (i < this.playing.length) {
      const state = this.state(this.playing[i]!);
      if (!state.loops) {
        this.evaluate(state, state.lastTime, true);
        this.removeAt(i);
        continue;
      }
      state.blend?.skip();
      i++;
    }
  }

  /**
   * 0x1001f180 (`Pass`): one-shot timelines apply their remaining keyframes (with the frame
   * time as transition length) and stop; difference timelines fade out over 20 frames and
   * apply only their instant tracks.
   */
  pass(): void {
    let i = 0;
    while (i < this.playing.length) {
      const label = this.playing[i]!;
      const state = this.state(label);
      if (state.loops) {
        i++;
        continue;
      }
      const diff = (state.flags & DIFFERENCE) !== 0;
      if (diff) {
        if (state.flags & PASSING) {
          i++;
          continue;
        }
        this.setBlendRatio(label, 0, 20, 0, true);
        state.flags |= PASSING;
      }
      state.tracks.forEach((track, k) => {
        if (diff && !track.instant) return;
        const frames = track.frames;
        for (let j = (state.frameIndex[k] ?? 0) + 1; j < frames.length; j++) {
          const frame = frames[j]!;
          if (!frame.empty)
            this.host.setVariable(track.label, frame.value, frame.time, frame.easing);
        }
      });
      if ((state.flags & PASSING) === 0) this.removeAt(i);
      else i++;
    }
  }

  /** 0x1001f4e0: adds the weighted difference track outputs for `label` to `value`. */
  blended(label: string, value: number): number {
    let v = value;
    for (const name of this.playing) {
      const state = this.state(name);
      if ((state.flags & DIFFERENCE) === 0) continue;
      for (const track of state.tracks) {
        if (!track.instant && track.label === label && (!this.x64 || track.tween)) {
          const product = track.value * state.blendRatio;
          v = f32((this.x64 ? f32(product) : product) + v);
        }
      }
    }
    return v;
  }

  /**
   * Timeline part of `IsAnimating` (0x100108f0): collects the track labels of the playing
   * timelines into `labels` and returns true on the first timeline that blends or does not
   * loop.
   */
  animating(labels: Set<string>): boolean {
    for (const name of this.playing) {
      const state = this.state(name);
      for (const track of state.tracks) labels.add(track.label);
      if (state.blend?.busy) return true;
      if (!state.loops) return true;
    }
    return false;
  }

  /**
   * Timeline part of `AssignState` (0x1000f2a0): stops all, then restarts the timelines that
   * play in `source` (parallel, with their flags), evaluates them to the source time and
   * copies the stop flag and the blend tween.
   */
  assignFrom(source: EmoteTimelineSet): void {
    if (source.driverSha256 !== this.driverSha256)
      throw Error('emotedriver: cannot assign timelines between DLL builds');
    this.stop('');
    for (const label of source.playing) {
      const from = source.states.get(label);
      const to = this.states.get(label);
      if (!from || !to) continue;
      this.play(label, from.flags | PARALLEL);
      this.evaluate(to, from.time, true);
      to.stopWhenBlendDone = from.stopWhenBlendDone;
      if (from.blend && to.blend) to.blend.copyFrom(from.blend);
    }
  }

  private seekX64(state: EmoteTimelineState, time: number): void {
    const t = f32(time);
    state.frameIndex = [];
    const passing = (state.flags & PASSING) !== 0;
    for (const track of state.tracks) {
      if (passing && track.instant) continue;
      const diff = (state.flags & DIFFERENCE) !== 0 && !track.instant;
      const frames = track.frames;
      let index = 0,
        content = -1;
      if (frames.length !== 1) {
        for (let i = 0; ;) {
          if (!frames[i]!.empty) content = i;
          if (frames[i]!.time <= t && t < frames[i + 1]!.time) break;
          index = ++i;
          if (i >= frames.length - 1) break;
        }
      }
      state.frameIndex.push(index);
      if (content < 0) continue;
      const frame = frames[content]!,
        fr = frameCountTo(frames, content, t);
      if (diff)
        track.tween?.set(
          [frame.value],
          fr,
          easingPower(frame.easing, this.driverSha256),
          this.host.queuing,
        );
      else this.host.setVariable(track.label, frame.value, fr, frame.easing);
    }
    state.time = t;
  }

  private evaluateX64(state: EmoteTimelineState, time: number, inclusive: boolean): void {
    const t = f32(time);
    const passing = (state.flags & PASSING) !== 0;
    state.tracks.forEach((track, k) => {
      if (passing && track.instant) return;
      const diff = (state.flags & DIFFERENCE) !== 0 && !track.instant;
      const frames = track.frames;
      // With skipped tracks the index vector is shorter than the track list; the native
      // indexes it by track number regardless.
      let index = state.frameIndex[k] ?? 0;
      while (index < frames.length - 1) {
        const ft = frames[index + 1]!.time;
        if (inclusive ? t < ft : t <= ft) break;
        index++;
        const frame = frames[index]!;
        if (frame.empty) continue;
        const fr = frameCountTo(frames, index, t);
        if (diff)
          track.tween?.set(
            [frame.value],
            fr,
            easingPower(frame.easing, this.driverSha256),
            this.host.queuing,
          );
        else this.host.setVariable(track.label, frame.value, fr, frame.easing);
      }
      state.frameIndex[k] = index;
    });
    state.time = t;
  }

  private advanceX64(frames: number): void {
    const dt = f32(frames);
    if (dt === 0) return;
    let i = 0;
    while (i < this.playing.length) {
      const key = this.playing[i]!,
        state = this.state(key);
      if (state.loops) {
        this.fade(state, dt);
        let d = dt;
        // A loop end at or before its begin never terminates natively.
        if (state.loopEnd > state.loopBegin) {
          while (state.loopEnd <= f32(state.time + d)) {
            d = f32(d - f32(state.loopEnd - state.time));
            this.evaluate(state, state.loopEnd, false);
            this.seek(state, state.loopBegin);
            state.stepped = true;
          }
        }
        this.evaluate(state, f32(state.time + (d >= 0 ? d : 0)), true);
      } else {
        this.evaluate(state, f32(state.time + dt), true);
        this.fade(state, dt);
        if (!(state.time < state.lastTime)) {
          this.removePlaying(key);
          continue;
        }
      }
      if (this.blendDone(state)) {
        this.removePlaying(key);
        continue;
      }
      i++;
    }
  }

  private blendDone(state: EmoteTimelineState): boolean {
    return state.stopWhenBlendDone !== 0 && !!state.blend && !state.blend.busy;
  }

  private removePlaying(key: string): void {
    this.playing = this.playing.filter((l) => l !== key);
  }

  step(): void {
    if (!this.x64) throw Error('emotedriver: timeline step requires the x64 DLL build');
    let i = 0;
    while (i < this.playing.length) {
      const key = this.playing[i]!,
        state = this.state(key);
      if (!state.loops || state.stopWhenBlendDone !== 0) {
        this.evaluate(state, state.lastTime, true);
        this.removePlaying(key);
        continue;
      }
      if (!state.stepped) {
        const end = state.loopEnd,
          remaining = f32(end - state.time);
        this.evaluate(state, end, false);
        this.seek(state, state.loopBegin);
        this.evaluate(state, state.loopBegin, true);
        this.fade(state, remaining);
        state.stepped = true;
      }
      state.blend?.skip();
      i++;
    }
  }

  fadeIn(label: string, frames: number, easing: number): void {
    try {
      if (this.host.apiLog?.enter())
        this.host.apiLog.record('FadeInTimeline', [label, frames, easing]);
      if (!this.isPlaying(label)) {
        this.play(label, PARALLEL | DIFFERENCE);
        this.setBlendRatio(label, 0, 0, 0, false);
      }
      this.setBlendRatio(label, 1, frames, easing, false);
    } finally {
      this.host.apiLog?.leave();
    }
  }

  fadeOut(label: string, frames: number, easing: number): void {
    try {
      if (this.host.apiLog?.enter())
        this.host.apiLog.record('FadeOutTimeline', [label, frames, easing]);
      this.setBlendRatio(label, 0, frames, easing, true);
    } finally {
      this.host.apiLog?.leave();
    }
  }

  private removeAt(index: number): void {
    if (this.x64) this.removePlaying(this.playing[index]!);
    else this.playing.splice(index, 1);
  }
}
