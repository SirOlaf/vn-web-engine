import type {EmoteTimeline} from '../../../../formats/kirikiri/emote-metadata.js';
import {EmoteTween, easingPower} from '../controls/transition.js';

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

/** What timelines call back into on their player. */
export interface EmoteTimelineHost {
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
  /** +0x0 non-null once loaded (0x1001d980 runs on the first play). */
  loaded = false;
  tracks: Track[] = [];
  /** Blend ratio tween (+0x4), output (+0x24), stop-when-done flag as float (+0x28). */
  blend: EmoteTween | null = null;
  blendRatio = 0;
  stopWhenBlendDone = 0;
  /** Play flags (+0x8). */
  flags = 0;
  /** +0x14, +0x18, +0x1c, +0x20. A negative `loopBegin` means no loop. */
  loopBegin = 0;
  loopEnd = 0;
  lastTime = 0;
  time = 0;
  /** Current segment start per track (vector at +0x2c, rebuilt by every seek). */
  frameIndex: number[] = [];

  constructor(readonly definition: EmoteTimeline) {}

  /** 0x1001d980. */
  load(instant: ReadonlySet<string>): void {
    const d = this.definition;
    this.loaded = true;
    this.loopBegin = f32(d.loopBegin);
    this.loopEnd = f32(d.loopEnd);
    // The reader already replaced a negative `lastTime` by the latest frame time (≥ 0).
    this.lastTime = f32(d.lastTime);
    this.blend = new EmoteTween(1);
    this.blendRatio = 1;
    this.stopWhenBlendDone = 0;
    this.blend.set([1], 0, 0, false);
    this.tracks = [];
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

export class EmoteTimelineSet {
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
  ) {}

  /** 0x1001d4a0: `label` and optional `diff` of every entry; bodies load on first play. */
  loadList(timelines: readonly EmoteTimeline[]): void {
    for (const t of timelines) {
      (t.diff ? this.diffLabels : this.mainLabels).push(t.label);
      if (!this.states.has(t.label)) this.states.set(t.label, new EmoteTimelineState(t));
    }
  }

  /** 0x1001caf0. Without the parallel flag every playing timeline stops first. */
  play(label: string, flags: number): void {
    if ((flags & PARALLEL) === 0) this.stop('');
    const state = this.states.get(label);
    if (!state) return;
    if (!this.playing.includes(label)) this.playing.push(label);
    if (!state.loaded) state.load(this.instant);
    this.setupPlay(state, flags);
    this.seek(state, 0);
  }

  /** 0x1001e650: stores the flags; difference tracks get a tween reset to 0. */
  private setupPlay(state: EmoteTimelineState, flags: number): void {
    state.flags = flags;
    if ((flags & DIFFERENCE) === 0) return;
    for (const track of state.tracks) {
      if (track.instant) continue;
      if (!track.tween) track.tween = new EmoteTween(1);
      else track.tween.set([0], 0, 0, false);
    }
  }

  /** 0x1001cc90. The empty label asks whether any timeline plays. */
  isPlaying(label: string): boolean {
    if (label === '') return this.playing.length !== 0;
    return this.playing.includes(label);
  }

  /** 0x1001cdc0. The empty label stops all. */
  stop(label: string): void {
    if (label === '') {
      this.playing = [];
      return;
    }
    const i = this.playing.indexOf(label);
    if (i >= 0) this.playing.splice(i, 1);
  }

  /** 0x1001cf30. Only loaded timelines; the blend tween advances only in the fade step. */
  setBlendRatio(label: string, value: number, frames: number, easing: number, stop: boolean): void {
    const state = this.states.get(label);
    if (!state?.loaded || !state.blend) return;
    state.blend.set([f32(value)], f32(frames), easingPower(easing), this.host.queuing);
    state.stopWhenBlendDone = stop ? 1 : 0;
  }

  /** 0x1001d090. */
  getBlendRatio(label: string): number {
    const state = this.states.get(label);
    return state?.loaded ? state.blendRatio : 0;
  }

  /** 0x1001d1c0: `loopBegin >= 0`; an unloaded state reads 0 and counts as looping. */
  isLoop(label: string): boolean {
    const state = this.states.get(label);
    return state ? state.loopBegin >= 0 : false;
  }

  /** 0x1001c9d0 (slot 42). */
  playingFlagsAt(index: number): number {
    const label = index < this.playing.length ? this.playing[index]! : '';
    const state = this.states.get(label);
    return state ? state.flags | 1 : 0;
  }

  private state(label: string): EmoteTimelineState {
    let state = this.states.get(label);
    if (!state) {
      // 0x10020920 inserts a missing key; every playing label is in the map.
      state = new EmoteTimelineState({
        label,
        diff: false,
        loopBegin: 0,
        loopEnd: 0,
        lastTime: 0,
        variables: [],
        unread: {},
      });
      this.states.set(label, state);
    }
    return state;
  }

  /** 0x1001e780: positions every track at `time` and starts the segment's transition. */
  seek(state: EmoteTimelineState, time: number): void {
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
        track.tween?.set([frame.value], frameCount, easingPower(frame.easing), this.host.queuing);
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
            track.tween?.set([next.value], frameCount, easingPower(next.easing), this.host.queuing);
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
    if (state.blend) state.blendRatio = state.blend.step(frames)[0]!;
    for (const track of state.tracks) {
      if (track.instant || !track.tween) continue;
      track.value = track.tween.step(frames)[0]!;
    }
  }

  /** 0x1001ee80: advances every playing timeline; loops, ends and removes. */
  advance(frames: number): void {
    let dt = f32(frames);
    if (dt === 0) return;
    let i = 0;
    while (i < this.playing.length) {
      const state = this.state(this.playing[i]!);
      if (!state.loops) {
        this.evaluate(state, f32(state.time + dt), true);
        if (state.flags & DIFFERENCE) this.fade(state, dt);
        if (state.lastTime <= state.time) {
          this.playing.splice(i, 1);
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
        this.playing.splice(i, 1);
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
        this.playing.splice(i, 1);
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
      if ((state.flags & PASSING) === 0) this.playing.splice(i, 1);
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
        if (!track.instant && track.label === label) v = f32(track.value * state.blendRatio + v);
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
}
