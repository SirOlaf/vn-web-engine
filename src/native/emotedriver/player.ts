/**
 * The E-mote 3.9.8 player core (`MEmotePlayer`, 0x398 bytes; `emotedriver.dll` x64, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`). It owns the variable
 * values, the metadata controls, the timelines and the player transforms, and drives one
 * motion clip (`EmoteClip`, the `MMotionPlayer` port) with them.
 *
 * Variables flow as follows: `setVariable` routes a label to its control (eye, eyebrow,
 * mouth, transition, selector) or stores it directly; Progress steps the controls in
 * sub-steps of at most 1.1 frames, writes their outputs into the value map and applies every
 * value (plus difference timelines, variable differences and mirroring) to the clip. Clamps,
 * clip time, outer forces and the physics controls follow.
 *
 * Stereovision rendering, `clone`, `assignState`/`getState` and API-log record/replay are not
 * part of this port; they throw `EmoteUnsupportedError`.
 */

import type {EmoteMetadata} from '../../formats/emote/metadata.js';
import type {EmoteDrawItem} from './clip.js';
import {
  EmoteEyeControl,
  EmoteEyebrowControl,
  EmoteMouthControl,
  EmoteOrbitControl,
  EmoteRandom,
  EmoteSelectorControl,
  type EmoteSelectorOption,
} from './controls.js';
import {EmoteBust, EmotePendulum, EmoteWind, type EmotePhysicsHost} from './physics.js';
import {EmoteTimelineSet} from './timelines.js';
import {EMOTE_TWO_PI, EmoteRotateTween, EmoteTween, easingPower, wrapAngle} from './tween.js';

const f32 = Math.fround;
const SUB_STEP = f32(1.1);
const FLT_EPSILON = f32(2 ** -23);
const HALF_PI_UNIT = f32(Math.PI);

/** `getEmoteVersion` text of this driver build. */
export const EMOTE_DRIVER_VERSION = '3.9.8';
export const EMOTE_DRIVER_BUILD = '2022/12/28-13:02:35';

export class EmoteUnsupportedError extends Error {
  constructor(feature: string) {
    super(`E-mote: ${feature} is not supported`);
    this.name = 'EmoteUnsupportedError';
  }
}

/** The clip state the player reads and writes (`MMotionPlayer`). */
export interface EmoteClip {
  /** 0x180037330. */
  setVariable(label: string, value: number): void;
  /** 0x180037cf0. */
  getVariable(label: string): number;
  /** 0x18003f720. */
  progress(frames: number): void;
  /** 0x180038bc0 as inlined by the player: object selection plus the pending object. */
  selectObject(name: string): void;
  /** 0x180038cb0. */
  setMotion(name: string, flags?: number): void;
  /** +0x1c8: packed colour, channel 0 in the low byte. */
  color: number;
  /** Root node (+0x1e8): +0x348/+0x34c coordinates, +0x358/+0x35c zoom, +0x354 angle (deg). */
  rootX: number;
  rootY: number;
  rootZoomX: number;
  rootZoomY: number;
  rootAngle: number;
  /** Root +0x340 (dirty) and +0x342 (visible). */
  rootDirty: boolean;
  visible: boolean;
  /** +0x158: the clip rotates itself (angle +0x15c, applied by 0x1800390e0(clip, 2)). */
  readonly ownRotation: boolean;
  setOwnRotation(degrees: number): void;
  readonly ownRotationAngle: number;
  /** 0x180038a10: blend mode 5 with `level` (0–255), or 0. */
  setGrayscale(mode: number, level: number): void;
  readonly grayscaleMode: number;
  readonly grayscaleLevel: number;
  /** +0x488. */
  meshDivisionRatio: number;
  /** Device +0x88. */
  smoothing: boolean;
  /** +0x4b0: the draw list `progress` rebuilds, in node order. */
  readonly drawList: readonly EmoteDrawItem[];
  /** Any node +0x35 flag. */
  readonly modified: boolean;
  /** 0x18000e6d0 clip part: the layer's world position when it is a plain layer. */
  layerPosition(name: string): readonly [number, number] | null;
}

/** Control kinds of the control map (+0x90). */
const enum Kind {
  Bust = 0,
  Hair = 1,
  Parts = 2,
  Eye = 4,
  Eyebrow = 5,
  Mouth = 6,
  Transition = 7,
  Selector = 8,
  Immediate = 9,
}

interface ControlRef {
  readonly kind: Kind;
  readonly index: number;
}

interface Transition {
  readonly tween: EmoteTween;
  readonly label: string;
  readonly enabled: boolean;
}

interface Clamp {
  readonly type: number;
  readonly lr: string;
  readonly ud: string;
  readonly min: number;
  readonly max: number;
}

interface VariableDiff {
  readonly module: string;
  readonly label: string;
  readonly tween: EmoteTween;
}

/** `std::string` ordering: UTF-8 bytes, i.e. code points. */
export function compareUtf8(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i),
      y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff,
      ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}

/** `std::map<std::string, float>` with in-order iteration. */
class SortedValues {
  private readonly map = new Map<string, number>();
  private keys: string[] | null = [];

  get(label: string): number | undefined {
    return this.map.get(label);
  }
  has(label: string): boolean {
    return this.map.has(label);
  }
  set(label: string, value: number): void {
    if (!this.map.has(label)) this.keys = null;
    this.map.set(label, f32(value));
  }
  clear(): void {
    this.map.clear();
    this.keys = [];
  }
  ordered(): readonly string[] {
    if (!this.keys) this.keys = [...this.map.keys()].sort(compareUtf8);
    return this.keys;
  }
}

export interface EmotePlayerOptions {
  /** The process RNG (0x180028950) shared by blinking and wind. */
  readonly random: EmoteRandom;
}

export class EmotePlayer implements EmotePhysicsHost {
  readonly metadata: EmoteMetadata;
  readonly clip: EmoteClip;
  private readonly random: EmoteRandom;

  /** +0x48, +0x4c, +0x50. */
  private readonly modelScale: number;
  private invScale = 1;
  private asOriginalScale = false;
  /** +0x54, +0x58, +0x5c. */
  bustScale = 1;
  hairScale = 1;
  partsScale = 1;
  /** +0x60, +0x61. */
  queuing = false;
  private dirty = false;
  /** +0x64 divisor, +0x68 slot, +0x6c phase, +0x70 pending frames. */
  private readonly divisor = 1;
  private readonly slot = 0;
  private phase = 0;
  private pending = 0;
  /** +0x74. */
  readonly suitableClearColor: number;
  /** +0x78, +0xb0. */
  private readonly variableList: readonly {
    label: string;
    frames: readonly {label: string; value: number}[];
  }[];
  private readonly variableLabels = new Set<string>();
  /** +0x90, +0xa0, +0xc0, +0xd0, +0xe0. */
  private readonly controls = new Map<string, ControlRef>();
  private readonly values = new SortedValues();
  private readonly instant = new Set<string>();
  private readonly diffSums = new Map<string, number>();
  private readonly diffs: VariableDiff[] = [];
  /** +0xf0, +0x108, +0x120. */
  private readonly busts: EmoteBust[] = [];
  private readonly hairs: EmotePendulum[] = [];
  private readonly parts: EmotePendulum[] = [];
  /** +0x138 … +0x1b0. */
  private readonly eyes: EmoteEyeControl[] = [];
  private readonly eyebrows: EmoteEyebrowControl[] = [];
  private readonly mouths: EmoteMouthControl[] = [];
  private readonly transitions: Transition[] = [];
  private readonly selectors: EmoteSelectorControl[] = [];
  private readonly clamps: Clamp[] = [];
  /** +0x1c8 … +0x1e0. */
  private windStart = 0;
  private windEnd = 0;
  wind: EmoteWind | null = null;
  /** +0x1e8: bit 1 multiplies the coordinates by the scale, bits 8/9 base-position scaling. */
  flags = 0x201;
  /** +0x1f0 … +0x210. */
  private readonly coord = new EmoteTween(2);
  private readonly scale = new EmoteTween(1);
  private readonly color = new EmoteTween(4);
  private readonly rot = new EmoteRotateTween();
  private readonly grayscale = new EmoteTween(1);
  /** +0x218/+0x220/+0x228 outer forces, +0x230 outer rotation, +0x238… accumulators. */
  private readonly forces = [new EmoteTween(2), new EmoteTween(2), new EmoteTween(2)] as const;
  private readonly outerRot = new EmoteRotateTween();
  private readonly forceSums = [
    new Float32Array(2),
    new Float32Array(2),
    new Float32Array(2),
  ] as const;
  /** +0x250 effective mirror, +0x251 user mirror, +0x252 metadata mirror, +0x258 fragments. */
  private userMirror = false;
  private readonly metaMirror: boolean;
  private readonly mirrorFragments: readonly string[];
  private readonly mirrorCache = new Map<string, boolean>();
  /** +0x290. */
  private readonly orbits: EmoteOrbitControl[] = [];
  readonly timelines: EmoteTimelineSet;
  /** +0x328 … +0x338. */
  private readonly profile: EmoteMetadata['charaProfile'];

  /** 0x1800090b0 followed by the metadata loader 0x18000c430. */
  constructor(metadata: EmoteMetadata, clip: EmoteClip, options: EmotePlayerOptions) {
    this.metadata = metadata;
    this.clip = clip;
    this.random = options.random;
    this.timelines = new EmoteTimelineSet(this, this.instant);
    this.setCoord(0, 0, 0, 0);
    this.setScale(1, 0, 0);
    this.setRot(0, 0, 0);
    this.setColor(0x808080ff, 0, 0);
    this.setGrayscale(0, 0, 0);
    this.clip.selectObject(metadata.base.chara);
    this.clip.setMotion(metadata.base.motion);

    this.metaMirror = metadata.mirror;
    this.mirrorFragments = metadata.mirrorControl.variableMatchList;
    this.skip();
    this.clip.progress(0);
    this.modelScale = f32(metadata.scale);
    this.variableList = (metadata.variableList ?? []).map((v) => ({
      label: v.label,
      frames: v.frames.map((fr) => ({label: fr.label, value: f32(fr.frame)})),
    }));
    for (const v of this.variableList) this.variableLabels.add(v.label);
    const c = metadata.suitableClearColor;
    this.suitableClearColor = c
      ? (((((c.r & 0xff) << 8) | (c.g & 0xff)) << 8) | (c.b & 0xff)) * 256
      : 0;

    metadata.bustControl.forEach((b) => {
      if (!b.enabled) return;
      this.register(b.var_lr, Kind.Bust, this.busts.length);
      this.register(b.var_ud, Kind.Bust, this.busts.length);
      this.busts.push(new EmoteBust(b));
    });
    for (const [list, out, kind] of [
      [metadata.hairControl, this.hairs, Kind.Hair],
      [metadata.partsControl, this.parts, Kind.Parts],
    ] as const) {
      for (const h of list) {
        if (!h.enabled) continue;
        for (const label of [h.var_lr, h.var_lrm, h.var_ud]) this.register(label, kind, out.length);
        out.push(new EmotePendulum(h));
      }
    }

    if (
      metadata.eyeControl.length ||
      metadata.eyebrowControl.length ||
      metadata.mouthControl.length
    ) {
      metadata.eyeControl.forEach((e, i) => {
        if (!e.enabled) return;
        this.register(e.label, Kind.Eye, i);
        this.eyes.push(new EmoteEyeControl(e, this.random));
      });
      metadata.eyebrowControl.forEach((e, i) => {
        if (!e.enabled) return;
        this.register(e.label, Kind.Eyebrow, i);
        this.eyebrows.push(new EmoteEyebrowControl(e));
      });
      metadata.mouthControl.forEach((m, i) => {
        if (!m.enabled) return;
        this.register(m.label, Kind.Mouth, i);
        this.register(m.talkLabel, Kind.Mouth, i);
        const mouth = new EmoteMouthControl(m.label, m.talkLabel);
        mouth.shape = Math.trunc(m.beginFrame);
        this.mouths.push(mouth);
      });
      // The control map records the metadata list index (disabled entries only trail).
      metadata.transitionControl.forEach((t, i) => {
        if (!t.enabled) return;
        this.register(t.label, Kind.Transition, i);
        this.transitions.push({tween: new EmoteTween(1), label: t.label, enabled: true});
      });
      metadata.selectorControl.forEach((s, i) => {
        if (!s.enabled) return;
        this.register(s.label, Kind.Selector, i);
        const options: EmoteSelectorOption[] = s.optionList.map((o) => ({
          tween: this.transitions.find((t) => t.label === o.label)?.tween ?? null,
          offValue: f32(o.offValue),
          onValue: f32(o.onValue),
        }));
        this.selectors.push(new EmoteSelectorControl(s.label, options));
      });
      for (const label of metadata.immediateControl) this.register(label, Kind.Immediate, 0);
    }

    if (metadata.clampControl.length) {
      for (const c of metadata.clampControl) {
        if (!c.enabled) continue;
        this.clamps.push({
          type: c.type,
          lr: c.var_lr,
          ud: c.var_ud,
          min: f32(c.min),
          max: f32(c.max),
        });
      }
      for (const label of metadata.instantVariableList ?? []) this.instant.add(label);
    }

    this.timelines.loadList(metadata.timelineControl);
    this.profile = metadata.charaProfile;
    for (const o of metadata.orbitControl)
      if (o.enabled) this.orbits.push(new EmoteOrbitControl(o));
  }

  private register(label: string, kind: Kind, index: number): void {
    if (!this.controls.has(label)) this.controls.set(label, {kind, index});
  }

  // ---- variables -------------------------------------------------------------------------

  countVariables(): number {
    return this.variableList.length;
  }
  getVariableLabelAt(index: number): string {
    return this.variableList[index]?.label ?? '';
  }
  countVariableFrameAt(index: number): number {
    return this.variableList[index]?.frames.length ?? 0;
  }
  getVariableFrameLabelAt(index: number, frame: number): string {
    return this.variableList[index]?.frames[frame]?.label ?? '';
  }
  getVariableFrameValueAt(index: number, frame: number): number {
    return this.variableList[index]?.frames[frame]?.value ?? 0;
  }

  /** 0x18000e980: an unknown label becomes a tweened transition variable. */
  addUserDefinedVariable(label: string): void {
    if (this.controls.has(label) || this.variableLabels.has(label)) return;
    this.register(label, Kind.Transition, this.transitions.length);
    this.transitions.push({tween: new EmoteTween(1), label, enabled: true});
  }

  /** 0x18000eec0 (API entry). */
  setVariable(label: string, value: number, frames = 0, easing = 0): void {
    this.setVariableCore(label, value, frames, easing);
  }

  /** 0x18000ec00: the dispatch shared with timelines and orbits. */
  private setVariableCore(label: string, value: number, frames: number, easing: number): void {
    const power = easingPower(easing);
    const v = f32(value),
      fr = f32(frames);
    this.dirty = true;
    const ref = this.controls.get(label);
    if (!ref || ref.kind === Kind.Immediate) {
      this.values.set(label, v);
      return;
    }
    switch (ref.kind) {
      case Kind.Eye:
        this.eyes[ref.index]?.walker.set(v, fr, power, this.queuing);
        return;
      case Kind.Eyebrow:
        this.eyebrows[ref.index]?.walker.set(v, fr, power, this.queuing);
        return;
      case Kind.Mouth: {
        const m = this.mouths[ref.index];
        if (!m) return;
        if (label === m.label) m.shape = Math.trunc(v);
        else m.talk.set([v], fr, power, this.queuing);
        return;
      }
      case Kind.Transition: {
        const t = this.transitions[ref.index];
        if (t?.enabled) t.tween.set([v], fr, power, this.queuing);
        return;
      }
      case Kind.Selector:
        this.selectors[ref.index]?.set(v, fr, power, this.queuing);
        return;
      default:
        return;
    }
  }

  /** 0x18000f7b0. */
  getVariable(label: string): number {
    const v = this.values.get(label);
    return v !== undefined ? v : this.clip.getVariable(label);
  }

  /** `setVariableDiff`: one tween per (module, label). */
  setVariableDiff(module: string, label: string, value: number, frames = 0, easing = 0): void {
    let d = this.diffs.find((x) => x.module === module && x.label === label);
    if (!d) {
      d = {module, label, tween: new EmoteTween(1)};
      this.diffs.push(d);
      this.diffs.sort((a, b) => compareUtf8(a.module, b.module) || compareUtf8(a.label, b.label));
    }
    this.dirty = true;
    d.tween.set([f32(value)], f32(frames), easingPower(easing), this.queuing);
  }

  getVariableDiff(module: string, label: string): number {
    return this.diffs.find((x) => x.module === module && x.label === label)?.tween.current[0] ?? 0;
  }

  // ---- transforms ------------------------------------------------------------------------

  setCoord(x: number, y: number, frames = 0, easing = 0): void {
    this.dirty = true;
    this.coord.set([f32(x), f32(y)], f32(frames), easingPower(easing), this.queuing);
  }
  getCoord(): [number, number] {
    return [this.clip.rootX, this.clip.rootY];
  }
  setScale(scale: number, frames = 0, easing = 0): void {
    this.dirty = true;
    this.scale.set([f32(scale)], f32(frames), easingPower(easing), this.queuing);
  }
  getScale(): number {
    return this.clip.rootZoomX;
  }
  setRot(radians: number, frames = 0, easing = 0): void {
    this.dirty = true;
    this.rot.set(f32(radians), f32(frames), easingPower(easing), this.queuing);
  }
  getRot(): number {
    return this.clipAngle();
  }
  setColor(color: number, frames = 0, easing = 0): void {
    const c = color >>> 0;
    this.dirty = true;
    this.color.set(
      [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24],
      f32(frames),
      easingPower(easing),
      this.queuing,
    );
  }
  getColor(): number {
    return this.clip.color >>> 0;
  }
  /** 0x180018fc0 (does not mark the player dirty). */
  setGrayscale(value: number, frames = 0, easing = 0): void {
    this.grayscale.set([f32(value)], f32(frames), easingPower(easing), this.queuing);
  }
  getGrayscale(): number {
    return this.clip.grayscaleMode === 5 ? f32(this.clip.grayscaleLevel / 255) : 0;
  }
  setAsOriginalScale(value: boolean): void {
    this.asOriginalScale = value;
  }
  isAsOriginalScale(): boolean {
    return this.asOriginalScale;
  }

  setOuterForce(label: string, x: number, y: number, frames = 0, easing = 0): void {
    this.dirty = true;
    const t = this.forceTween(label);
    t?.set([f32(x), f32(y)], f32(frames), easingPower(easing), this.queuing);
  }
  getOuterForce(label: string): [number, number] {
    const t = this.forceTween(label);
    return t ? [t.current[0]!, t.current[1]!] : [0, 0];
  }
  private forceTween(label: string): EmoteTween | null {
    if (label === 'bust') return this.forces[0];
    if (label === 'hair') return this.forces[1];
    if (label === 'parts') return this.forces[2];
    return null;
  }

  /** 0x180019eb0. */
  setOuterRot(radians: number, frames = 0, easing = 0): void {
    this.dirty = true;
    this.outerRot.set(f32(radians), f32(frames), easingPower(easing), this.queuing);
  }
  getOuterRot(): number {
    return this.outerRot.current;
  }

  /** 0x18001ac70. */
  startWind(start: number, end: number, power: number, maxWidth: number, minWidth: number): void {
    let s = f32(start),
      e = f32(end),
      p = f32(power);
    if (p < 0) {
      p = f32(-p);
      [s, e] = [e, s];
    }
    if (s === e || p === 0 || (f32(maxWidth) === 0 && f32(minWidth) === 0)) {
      this.wind = null;
      return;
    }
    if (!this.wind || this.windStart !== s || this.windEnd !== e)
      this.wind = new EmoteWind(f32(s / this.modelScale), f32(e / this.modelScale), this.random);
    this.windStart = s;
    this.windEnd = e;
    const w = this.wind;
    w.maxWidth = f32(maxWidth);
    w.minWidth = f32(minWidth);
    w.restart(f32((f32(w.end - w.start) >= 0 ? 1 : -1) * f32(p / this.modelScale)));
  }
  stopWind(): void {
    this.startWind(0, 0, 0, 0, 0);
  }

  setMirror(value: boolean): void {
    this.userMirror = value;
  }
  private get mirrored(): boolean {
    return this.metaMirror !== this.userMirror;
  }

  /** 0x18001b020. */
  private mirrorMatch(label: string): boolean {
    if (!this.mirrored) return false;
    let hit = this.mirrorCache.get(label);
    if (hit === undefined) {
      hit = this.mirrorFragments.some((f) => label.includes(f));
      this.mirrorCache.set(label, hit);
    }
    return hit;
  }

  // ---- clip pass-through -----------------------------------------------------------------

  show(): void {
    this.clip.visible = true;
    this.clip.rootDirty = true;
  }
  hide(): void {
    this.clip.visible = false;
    this.clip.rootDirty = true;
  }
  isHidden(): boolean {
    return !this.clip.visible;
  }
  setSmoothing(value: boolean): void {
    this.clip.smoothing = value;
  }
  getSmoothing(): boolean {
    return this.clip.smoothing;
  }
  setMeshDivisionRatio(value: number): void {
    this.clip.meshDivisionRatio = f32(value);
  }
  getMeshDivisionRatio(): number {
    return this.clip.meshDivisionRatio;
  }
  isModified(): boolean {
    return this.clip.modified;
  }

  // ---- timelines -------------------------------------------------------------------------

  countMainTimelines(): number {
    return this.timelines.mainLabels.length;
  }
  getMainTimelineLabelAt(index: number): string {
    return this.timelines.mainLabels[index] ?? '';
  }
  countDiffTimelines(): number {
    return this.timelines.diffLabels.length;
  }
  getDiffTimelineLabelAt(index: number): string {
    return this.timelines.diffLabels[index] ?? '';
  }
  countPlayingTimelines(): number {
    return this.timelines.playing.length;
  }
  getPlayingTimelineLabelAt(index: number): string {
    return this.timelines.playingLabelAt(index);
  }
  getPlayingTimelineFlagsAt(index: number): number {
    return this.timelines.playingFlagsAt(index);
  }
  isLoopTimeline(label: string): boolean {
    return this.timelines.isLoop(label);
  }
  getTimelineTotalFrameCount(label: string): number {
    return this.timelines.totalFrameCount(label);
  }
  playTimeline(label: string, flags = 0): void {
    this.timelines.play(label, flags);
  }
  isTimelinePlaying(label: string): boolean {
    return this.timelines.isPlaying(label);
  }
  stopTimeline(label: string): void {
    this.timelines.stop(label);
  }
  setTimelineBlendRatio(
    label: string,
    value: number,
    frames = 0,
    easing = 0,
    stopWhenDone = false,
  ): void {
    this.timelines.setBlendRatio(label, value, frames, easing, stopWhenDone);
  }
  getTimelineBlendRatio(label: string): number {
    return this.timelines.getBlendRatio(label);
  }
  fadeInTimeline(label: string, frames = 0, easing = 0): void {
    this.timelines.fadeIn(label, frames, easing);
  }
  fadeOutTimeline(label: string, frames = 0, easing = 0): void {
    this.timelines.fadeOut(label, frames, easing);
  }

  // ---- chara profile, blink --------------------------------------------------------------

  isCharaProfileAvailable(): boolean {
    return this.profile !== null;
  }
  getCharaHeight(): number {
    const h = f32(this.profile?.height ?? 0);
    return this.asOriginalScale ? f32(h / this.modelScale) : h;
  }
  countCharaProfiles(): number {
    return this.profile?.markers.length ?? 0;
  }
  getCharaProfileLabelAt(index: number): string {
    return this.profile?.markers[index]?.label ?? '';
  }
  getCharaProfile(label: string): number {
    const m = this.profile?.markers.find((x) => x.label === label);
    const v = f32(m?.value ?? 0);
    return this.asOriginalScale ? f32(v / this.modelScale) : v;
  }
  getSuitableClearColor(): number {
    return this.suitableClearColor >>> 0;
  }
  setBlinkEnabled(enabled: boolean): void {
    for (const e of this.eyes) e.setBlinkEnabled(enabled);
  }
  getBlinkEnabled(): boolean {
    return this.eyes.some((e) => e.blinkEnabled !== 0);
  }

  // ---- unsupported -----------------------------------------------------------------------

  setStereovisionEnabled(value: boolean): void {
    if (value) throw new EmoteUnsupportedError('stereovision');
  }
  getStereovisionEnabled(): boolean {
    return false;
  }

  // ---- animation state -------------------------------------------------------------------

  /** 0x18000bb20. */
  isAnimating(): boolean {
    if (this.coord.busy || this.scale.busy || this.rot.busy || this.outerRot.busy) return true;
    const labels = new Set<string>();
    if (this.timelines.animating(labels)) return true;
    const free = (label: string) => !labels.has(label);
    if (this.selectors.some((s) => s.busy && free(s.label))) return true;
    if (this.transitions.some((t) => t.tween.busy && free(t.label))) return true;
    if (this.eyes.some((e) => e.walker.busy && free(e.label))) return true;
    if (this.eyebrows.some((e) => e.walker.busy && free(e.label))) return true;
    if (this.mouths.some((m) => m.talk.busy && free(m.label) && free(m.talkLabel))) return true;
    return false;
  }

  /** 0x18000df30. */
  skip(): void {
    this.timelines.skip();
    this.settle();
  }

  /** 0x18000e210. */
  step(): void {
    this.timelines.step();
    this.settle();
  }

  /** 0x18000e4f0. */
  pass(): void {
    this.timelines.pass();
  }

  private settle(): void {
    for (const f of this.forces) f.skip();
    for (const s of this.forceSums) s.fill(0);
    this.outerRot.skip();
    for (const b of this.busts) b.reset(this);
    for (const h of this.hairs) h.reset(this);
    for (const p of this.parts) p.reset(this);
    for (const e of this.eyes) e.walker.skip();
    for (const e of this.eyebrows) e.walker.skip();
    for (const m of this.mouths) m.talk.skip();
    for (const s of this.selectors) s.skip();
    for (const t of this.transitions) t.tween.skip();
    this.coord.skip();
    this.scale.skip();
    this.rot.skip();
    this.color.skip();
    for (const d of this.diffs) d.tween.skip();
  }

  /** 0x18000d3f0. */
  progress(frames: number): void {
    let dt = f32(f32(frames) + this.pending);
    this.phase = (this.phase + 1) % this.divisor;
    if (this.phase !== this.slot) {
      this.pending = dt;
      return;
    }
    this.pending = 0;

    for (const o of this.orbits) {
      const call = o.step(dt);
      if (call) this.setVariableCore(o.label, call.value, call.frames, 0);
    }
    this.timelines.advance(dt);
    this.diffSums.clear();
    for (const d of this.diffs) {
      const v = d.tween.step(dt)[0]!;
      this.diffSums.set(d.label, f32((this.diffSums.get(d.label) ?? 0) + v));
    }

    let rest = dt;
    while (0 < rest || this.dirty) {
      this.dirty = false;
      const h = rest <= SUB_STEP ? rest : SUB_STEP;
      for (const e of this.eyes) this.values.set(e.label, e.step(h));
      for (const e of this.eyebrows) this.values.set(e.label, e.step(h));
      for (const m of this.mouths) {
        const talk = m.talk.step(h)[0]!;
        this.values.set(m.label, m.shape);
        this.values.set(m.talkLabel, talk);
      }
      for (const s of this.selectors) this.values.set(s.label, s.step(h));
      for (const t of this.transitions) this.values.set(t.label, t.tween.step(h)[0]!);
      this.transform(h);
      if (this.wind?.enabled) this.wind.step(h);
      rest = f32(rest - h);
    }

    for (const label of this.values.ordered()) {
      let v = this.timelines.blended(label, this.values.get(label)!);
      const d = this.diffSums.get(label);
      if (d !== undefined) v = f32(v + d);
      if (this.mirrorMatch(label)) v = -v;
      this.clip.setVariable(label, v);
    }
    this.applyClamps();
    this.clip.progress(dt);

    if (dt !== 0) {
      this.forces.forEach((t, i) => {
        const out = t.step(dt);
        const sum = this.forceSums[i]!;
        sum[0] = f32(f32(out[0]! * dt) + sum[0]!);
        sum[1] = f32(f32(out[1]! * dt) + sum[1]!);
      });
      this.outerRot.step(dt);
      const [bx, by] = this.forceSums[0];
      for (const b of this.busts) b.step(this, dt, bx!, by!);
      const [hx, hy] = this.forceSums[1];
      for (const h of this.hairs) h.step(this, dt, this.hairScale, hx!, hy!);
      const [px, py] = this.forceSums[2];
      for (const p of this.parts) p.step(this, dt, this.partsScale, px!, py!);
    }
  }

  /** 0x180019240. */
  private transform(dt: number): void {
    const coord = this.coord.step(dt);
    const color = this.color.step(dt);
    let s = this.scale.step(dt)[0]!;
    if (this.asOriginalScale) s = f32(s / this.modelScale);
    this.invScale = f32(1 / f32(this.modelScale * s));
    const rad = this.rot.step(dt);
    let x = coord[0]!,
      y = coord[1]!;
    if (this.flags & 2) {
      x = f32(x * s);
      y = f32(y * s);
    }
    const ch = (i: number) => Math.trunc(color[i]!) | 0;
    const clip = this.clip;
    clip.color = ((((((ch(3) << 8) | ch(2)) << 8) | ch(1)) << 8) | ch(0)) >>> 0;
    clip.rootX = x;
    clip.rootY = y;
    clip.rootZoomX = s;
    clip.rootZoomY = s;
    clip.rootDirty = true;
    const deg = f32(f32(rad * 360) / EMOTE_TWO_PI);
    if (clip.ownRotation) clip.setOwnRotation(wrapAngle(deg, 360));
    else clip.rootAngle = deg;
    const g = this.grayscale.step(dt)[0]!;
    const v = g <= 1 ? g : 1;
    clip.setGrayscale(v > 0 ? 5 : 0, Math.trunc(f32(v * 255)));
  }

  /** The value the clamps and physics read: stored value, difference timelines, diffs. */
  private effective(label: string): number {
    let v = this.values.get(label) ?? 0;
    v = this.timelines.blended(label, v);
    const d = this.diffSums.get(label);
    if (d !== undefined) v = f32(v + d);
    return v;
  }

  /** 0x18001a660. */
  private applyClamps(): void {
    for (const c of this.clamps) {
      const range = f32(c.max - c.min);
      let lr = f32(f32(f32(f32(this.effective(c.lr) - c.min) / range) * 2) - 1);
      let ud = f32(f32(f32(f32(this.effective(c.ud) - c.min) / range) * 2) - 1);
      if (lr !== 0 && ud !== 0) {
        if (c.type === 0) {
          let r = Math.abs(f32(lr / ud));
          if (1 < r) r = f32(1 / r);
          const k = f32(1 / f32(Math.sqrt(f32(f32(r * r) + 1))));
          lr = f32(lr * k);
          ud = f32(ud * k);
          const len = f32(Math.sqrt(f32(f32(ud * ud) + f32(lr * lr))));
          const a = f32(Math.cos(f32(f32(r * HALF_PI_UNIT) * 0.5)));
          const b = f32(Math.sin(f32(f32(len * HALF_PI_UNIT) * 0.5)));
          const m = f32(f32(f32(1 - a) * f32(f32(b / len) - 1)) + 1);
          ud = f32(m * ud);
          lr = f32(m * lr);
        } else if (c.type === 1) {
          const len = f32(Math.sqrt(f32(f32(ud * ud) + f32(lr * lr))));
          if (1 < len) {
            const a = f32(Math.atan2(ud, lr));
            lr = f32(Math.cos(a));
            ud = f32(Math.sin(a));
          }
        }
      }
      let outLr = f32(f32(f32(f32(lr + 1) * 0.5) * range) + c.min);
      if (this.mirrorMatch(c.lr)) outLr = -outLr;
      this.clip.setVariable(c.lr, outLr);
      this.clip.setVariable(c.ud, f32(f32(f32(f32(ud + 1) * 0.5) * range) + c.min));
    }
  }

  private clipAngle(): number {
    const deg = this.clip.ownRotation ? this.clip.ownRotationAngle : this.clip.rootAngle;
    return f32(f32(deg * EMOTE_TWO_PI) / 360);
  }

  // ---- physics host ----------------------------------------------------------------------

  /** 0x18000e6d0. */
  basePosition(layer: string): readonly [number, number] | null {
    const p = this.clip.layerPosition(layer);
    if (!p) return null;
    let [x, y] = p;
    const a = this.outerRot.current;
    if (FLT_EPSILON < Math.abs(a)) {
      const s = f32(Math.sin(a)),
        c = f32(Math.cos(a));
      const ox = this.clip.rootX,
        oy = this.clip.rootY;
      const dx = f32(x - ox),
        dy = f32(y - oy);
      x = f32(f32(f32(dx * c) - f32(dy * s)) + ox);
      y = f32(f32(f32(dy * c) + f32(dx * s)) + oy);
    }
    if (this.flags & 0x200) {
      x = f32(x * this.invScale);
      y = f32(y * this.invScale);
    }
    if (this.flags & 0x100) {
      const ox = this.clip.rootX,
        oy = this.clip.rootY;
      x = f32(f32(f32(x - ox) * this.invScale) + ox);
      y = f32(f32(f32(y - oy) * this.invScale) + oy);
    }
    return [x, y];
  }

  get physicsAngle(): number {
    return f32(this.clipAngle() + this.outerRot.current);
  }

  setValue(label: string, value: number): void {
    this.values.set(label, value);
  }
}
