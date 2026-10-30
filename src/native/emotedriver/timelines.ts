import type {EmoteTimeline} from '../../formats/emote/metadata.js';
import {EmoteTween, easingPower} from './tween.js';

/**
 * Timelines of the E-mote 3.9.8 player (`timelineControl`; `emotedriver.dll` x64 SHA-256
 * `80d28bd0…`). Player fields: state map +0x2a8 (normalized label → state), playing list
 * +0x2b8, main and difference label lists +0x2d0 and +0x2e8.
 *
 * A keyframe's value is the target of a variable transition that starts when the keyframe is
 * passed and lasts until one frame before the next keyframe. Plain timelines write variables
 * with `setVariable`; difference timelines (flag 2) drive a per-track tween whose output,
 * weighted by the blend ratio, is added to the variable when variables are applied.
 */

const f32 = Math.fround;

/** `EMOTE_TIMELINE_PLAY_PARALLEL`. */
export const TIMELINE_PARALLEL = 1;
/** `EMOTE_TIMELINE_PLAY_DIFFERENCE`. */
export const TIMELINE_DIFFERENCE = 2;
/** Set by `pass` on a difference timeline that is fading out. */
const PASSING = 4;

/**
 * 0x18001ff10, applied to every label argument and to the map keys: fullwidth ASCII
 * (U+FF01–U+FF5E) becomes ASCII. Characters above U+FFFF are re-encoded with an invalid
 * lead byte natively, so such a label matches nothing; `null` stands for it.
 */
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
  /** Player +0x60: tweens queue instead of replacing. */
  readonly queuing: boolean;
  /** 0x18000ec00 (`setVariable` core; `easing` is converted there). */
  setVariable(label: string, value: number, frames: number, easing: number): void;
}

/** Frame (0x10 bytes): time, empty flag (`type == 0`), value, easing. */
interface TrackFrame {
  readonly time: number;
  readonly empty: boolean;
  readonly value: number;
  readonly easing: number;
}

/** Track (0x50 bytes); only variables with frames get one (0x18001d800). */
class Track {
  /** Difference tween (+0x40), created by the first difference play. */
  tween: EmoteTween | null = null;
  /** Difference output (+0x48), written by the fade step. */
  value = 0;
  constructor(
    readonly label: string,
    /** Label in `instantVariableList` (+0x20). */
    readonly instant: boolean,
    readonly frames: readonly TrackFrame[],
  ) {}
}

/** Timeline state (map node +0x40). Fields are zero until the body is loaded. */
export class EmoteTimelineState {
  /** +0x0 non-null once loaded. */
  loaded = false;
  tracks: Track[] = [];
  /** Blend ratio tween (+0x8), output (+0x38), stop-when-done flag as float (+0x3c). */
  blend: EmoteTween | null = null;
  blendRatio = 0;
  stopWhenBlendDone = 0;
  /** Play flags (+0x10). */
  flags = 0;
  /** +0x14: a loop has wrapped since play (makes `step` finish without wrapping again). */
  stepped = false;
  /** +0x28, +0x2c, +0x30, +0x34. A negative `loopBegin` means no loop. */
  loopBegin = 0;
  loopEnd = 0;
  lastTime = 0;
  time = 0;
  /** Current segment per track (vector +0x40, rebuilt by every seek). */
  frameIndex: number[] = [];

  constructor(readonly definition: EmoteTimeline | null) {}

  /** 0x18001d800. */
  load(instant: ReadonlySet<string>): void {
    const d = this.definition;
    this.loaded = true;
    this.blend = new EmoteTween(1);
    this.tracks = [];
    if (!d) return;
    this.loopBegin = f32(d.loopBegin);
    this.loopEnd = f32(d.loopEnd);
    // The reader already replaced a negative `lastTime` by the latest frame time (≥ 0).
    this.lastTime = f32(d.lastTime);
    for (const v of d.variables) {
      if (v.frames.length === 0) continue;
      const frames = v.frames.map((fr) => ({
        time: f32(fr.time),
        empty: fr.type === 0,
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

/** Transition length to the frame after `index`; past the last frame the native reads
 * beyond the vector, taken as time 0 here. */
function frameCountTo(frames: readonly TrackFrame[], index: number, t: number): number {
  const d = f32(f32((frames[index + 1]?.time ?? 0) - t) - 1);
  return d >= 0 ? d : 0;
}

export class EmoteTimelineSet {
  /** +0x2d0, +0x2e8: raw labels in list order (duplicates kept). */
  readonly mainLabels: string[] = [];
  readonly diffLabels: string[] = [];
  /** +0x2a8. */
  readonly states = new Map<string, EmoteTimelineState>();
  /** +0x2b8: normalized labels. */
  playing: string[] = [];

  constructor(
    private readonly host: EmoteTimelineHost,
    private readonly instant: ReadonlySet<string>,
  ) {}

  /** 0x18001d330: `label` and optional `diff`; bodies load on first play. */
  loadList(timelines: readonly EmoteTimeline[]): void {
    for (const t of timelines) {
      (t.diff ? this.diffLabels : this.mainLabels).push(t.label);
      const key = normalizeTimelineLabel(t.label);
      if (key !== null && !this.states.has(key)) this.states.set(key, new EmoteTimelineState(t));
    }
  }

  private find(label: string): {key: string; state: EmoteTimelineState} | null {
    const key = normalizeTimelineLabel(label);
    if (key === null) return null;
    const state = this.states.get(key);
    return state ? {key, state} : null;
  }

  /** 0x18001b940. Without the parallel flag every playing timeline stops first. */
  play(label: string, flags: number): void {
    if ((flags & TIMELINE_PARALLEL) === 0) this.stop('');
    const found = this.find(label);
    if (!found) return;
    const {key, state} = found;
    if (!this.playing.includes(key)) this.playing.push(key);
    if (!state.loaded) state.load(this.instant);
    state.blendRatio = 1;
    state.stopWhenBlendDone = 0;
    state.stepped = false;
    state.blend!.set([1], 0, 0, false);
    state.flags = flags;
    if (flags & TIMELINE_DIFFERENCE) {
      for (const track of state.tracks) {
        if (track.instant) continue;
        if (!track.tween) track.tween = new EmoteTween(1);
        else track.tween.set([0], 0, 0, false);
      }
    }
    this.seek(state, 0);
  }

  /** 0x18001bec0. The empty label asks whether any timeline plays. */
  isPlaying(label: string): boolean {
    const key = normalizeTimelineLabel(label);
    if (key === '') return this.playing.length !== 0;
    return key !== null && this.playing.includes(key);
  }

  /** 0x18001c000. The empty label stops all. */
  stop(label: string): void {
    const key = normalizeTimelineLabel(label);
    if (key === '') {
      this.playing = [];
      return;
    }
    if (key !== null) this.playing = this.playing.filter((l) => l !== key);
  }

  /** 0x18001c410. Only loaded timelines; the blend tween advances in the fade step. */
  setBlendRatio(label: string, value: number, frames: number, easing: number, stop: boolean): void {
    const state = this.find(label)?.state;
    if (!state?.blend) return;
    state.blend.set([f32(value)], f32(frames), easingPower(easing), this.host.queuing);
    state.stopWhenBlendDone = stop ? 1 : 0;
  }

  /** 0x18001c800. */
  getBlendRatio(label: string): number {
    const state = this.find(label)?.state;
    return state?.blend ? state.blendRatio : 0;
  }

  /** 0x18001ce50: `loopBegin >= 0`; an unloaded state reads 0 and counts as looping. */
  isLoop(label: string): boolean {
    const state = this.find(label)?.state;
    return state ? state.loopBegin >= 0 : false;
  }

  /** 0x18001d000: `lastTime` of a one-shot timeline, else 0. */
  totalFrameCount(label: string): number {
    const state = this.find(label)?.state;
    return state && state.loopBegin < 0 ? state.lastTime : 0;
  }

  /** 0x180003270. The native bound check admits `index == count` (reads past the end). */
  playingLabelAt(index: number): string {
    return this.playing[index] ?? '';
  }

  /** 0x18001b770: flags with the parallel bit, 0 for an unknown label. */
  playingFlagsAt(index: number): number {
    const state = this.states.get(this.playingLabelAt(index));
    return state ? (state.flags | TIMELINE_PARALLEL) >>> 0 : 0;
  }

  /** The state of a playing label; 0x180022990 inserts a zeroed one when missing. */
  private state(key: string): EmoteTimelineState {
    let state = this.states.get(key);
    if (!state) {
      state = new EmoteTimelineState(null);
      this.states.set(key, state);
    }
    return state;
  }

  /**
   * 0x18001e0b0: positions every track at `time` and starts the transition of the last
   * keyframe with content at or before the segment. A single-frame track sets nothing.
   */
  seek(state: EmoteTimelineState, time: number): void {
    const t = f32(time);
    state.frameIndex = [];
    const passing = (state.flags & PASSING) !== 0;
    for (const track of state.tracks) {
      if (passing && track.instant) continue;
      const diff = (state.flags & TIMELINE_DIFFERENCE) !== 0 && !track.instant;
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
      if (diff) track.tween?.set([frame.value], fr, easingPower(frame.easing), this.host.queuing);
      else this.host.setVariable(track.label, frame.value, fr, frame.easing);
    }
    state.time = t;
  }

  /**
   * 0x18001e300: passes the keyframes up to `time` (`inclusive`: frames at exactly `time`
   * too) and starts the transition of each passed keyframe with content.
   */
  evaluate(state: EmoteTimelineState, time: number, inclusive: boolean): void {
    const t = f32(time);
    const passing = (state.flags & PASSING) !== 0;
    state.tracks.forEach((track, k) => {
      if (passing && track.instant) return;
      const diff = (state.flags & TIMELINE_DIFFERENCE) !== 0 && !track.instant;
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
        if (diff) track.tween?.set([frame.value], fr, easingPower(frame.easing), this.host.queuing);
        else this.host.setVariable(track.label, frame.value, fr, frame.easing);
      }
      state.frameIndex[k] = index;
    });
    state.time = t;
  }

  /** 0x18001e550: blend ratio and difference track tweens of a difference timeline. */
  private fade(state: EmoteTimelineState, frames: number): void {
    if ((state.flags & TIMELINE_DIFFERENCE) === 0) return;
    if (state.blend) state.blendRatio = state.blend.step(frames)[0]!;
    for (const track of state.tracks) {
      if (track.instant || !track.tween) continue;
      track.value = track.tween.step(frames)[0]!;
    }
  }

  private blendDone(state: EmoteTimelineState): boolean {
    return state.stopWhenBlendDone !== 0 && !!state.blend && !state.blend.busy;
  }

  /** 0x18001e5e0: advances every playing timeline by `frames`; loops, ends and removes. */
  advance(frames: number): void {
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

  /** 0x180022ac0 (`std::remove`): every occurrence goes. */
  private removePlaying(key: string): void {
    this.playing = this.playing.filter((l) => l !== key);
  }

  /** 0x18001e9a0: one-shot timelines run to their end and stop; loops finish blending. */
  skip(): void {
    let i = 0;
    while (i < this.playing.length) {
      const key = this.playing[i]!,
        state = this.state(key);
      if (state.loops) {
        state.blend?.skip();
        i++;
        continue;
      }
      this.evaluate(state, state.lastTime, true);
      this.removePlaying(key);
    }
  }

  /**
   * 0x18001ebf0: one-shot timelines and fading-out loops run to their end and stop. A loop
   * that has not wrapped yet completes one pass and restarts; its blend tween finishes.
   */
  step(): void {
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

  /**
   * `pass`: one-shot timelines apply their remaining keyframes (with the frame time as
   * transition length) and stop; difference timelines fade out over 20 frames and apply only
   * their instant tracks.
   */
  pass(): void {
    let i = 0;
    while (i < this.playing.length) {
      const key = this.playing[i]!,
        state = this.state(key);
      if (state.loops) {
        i++;
        continue;
      }
      const diff = (state.flags & TIMELINE_DIFFERENCE) !== 0;
      if (diff) {
        if (state.flags & PASSING) {
          i++;
          continue;
        }
        this.setBlendRatio(key, 0, 20, 0, true);
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
      if ((state.flags & PASSING) === 0) this.removePlaying(key);
      else i++;
    }
  }

  /** `fadeInTimeline`: starts a stopped timeline as a parallel difference one at ratio 0. */
  fadeIn(label: string, frames: number, easing: number): void {
    if (!this.isPlaying(label)) {
      this.play(label, TIMELINE_PARALLEL | TIMELINE_DIFFERENCE);
      this.setBlendRatio(label, 0, 0, 0, false);
    }
    this.setBlendRatio(label, 1, frames, easing, false);
  }

  /** `fadeOutTimeline`. */
  fadeOut(label: string, frames: number, easing: number): void {
    this.setBlendRatio(label, 0, frames, easing, true);
  }

  /** 0x18001f2a0: adds the weighted difference track outputs for `label` to `value`. */
  blended(label: string, value: number): number {
    let v = value;
    for (const key of this.playing) {
      const state = this.state(key);
      if ((state.flags & TIMELINE_DIFFERENCE) === 0) continue;
      for (const track of state.tracks) {
        if (track.instant || !track.tween || track.label !== label) continue;
        v = f32(f32(track.value * state.blendRatio) + v);
      }
    }
    return v;
  }

  /** Track labels of the playing timelines and whether one of them still changes. */
  animating(labels: Set<string>): boolean {
    for (const key of this.playing) {
      const state = this.state(key);
      for (const track of state.tracks) labels.add(track.label);
      if (state.blend?.busy) return true;
      if (!state.loops) return true;
    }
    return false;
  }
}
