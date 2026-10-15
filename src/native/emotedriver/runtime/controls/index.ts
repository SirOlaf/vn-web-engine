import type {
  EmoteDisabledControl,
  EmoteMetadata,
} from '../../../../formats/kirikiri/emote-metadata.js';
import type {EmoteControlHost, EmoteControlSet, EmoteControlVariableType} from '../interfaces.js';
import {EmoteBust} from './bust.js';
import {f32} from './common.js';
import {EmoteEye} from './eye.js';
import {EmoteEyebrow} from './eyebrow.js';
import {EmoteLoop} from './loop.js';
import {EmoteMouth} from './mouth.js';
import {type EmotePendulumOutput, EmotePendulum} from './pendulum.js';
import {EmoteXorshift128} from './random.js';
import {type EmoteSelectorTransition, EmoteSelector} from './selector.js';
import {EmoteWind} from './wind.js';

export {EmoteBust, emoteGravity, emoteSoftAngle} from './bust.js';
export {EmoteBlinkState, EmoteEye} from './eye.js';
export {EmoteEyebrow} from './eyebrow.js';
export {EmoteGraph, EmoteGraphFollower, type EmoteGraphSegment} from './graph.js';
export {EmoteLoop} from './loop.js';
export {EmoteMouth} from './mouth.js';
export {EmotePendulum, type EmotePendulumOutput} from './pendulum.js';
export {EmoteXorshift128} from './random.js';
export {EmoteSelector, type EmoteSelectorTransition} from './selector.js';
export {EMOTE_WIND_SLOTS, EmoteWind} from './wind.js';

/** Sub-step length limit of Progress and of the physics drivers (float 1.1 at 0x100728b0). */
export const EMOTE_SUBSTEP = f32(1.1);
/** The same limit as the comparison double (0x100728a8). */
const SUBSTEP_LIMIT = 1.100000023841858;
/** Physics loop end margin (double 0x100728b8, FLT_EPSILON). */
const PHYSICS_EPSILON = 1.1920928955078125e-7;
/** |output| at or below which all outputs of a physics entry are zeroed (float 0x10071518). */
const PHYSICS_REST = f32(0.01);

/**
 * The module-wide generator (global 0x100875ec, created on first use by 0x1000d5e0) used by
 * blink intervals (0x10005190) and wind gusts (0x1000d780).
 */
export const emoteSharedRandom = new EmoteXorshift128();

/** Options of `createEmoteControls` beyond the `EmoteControlSetFactory` signature. */
export interface EmoteControlsOptions {
  /** Generator for blinks and wind; defaults to `emoteSharedRandom`. */
  readonly random?: () => number;
  /**
   * Transition control (`p+0xe4`) by label, for selector options (resolved while loading,
   * 0x10019a50). Without it selector options drive nothing.
   */
  readonly transition?: (label: string) => EmoteSelectorTransition | null;
}

interface PhysicsEntry<T> {
  readonly control: T;
  readonly baseLayer: string;
  /** Entry +0x4. */
  first: boolean;
  /** Previous base position (entry +0x84/+0x88 bust, +0xd8/+0xdc pendulum). */
  prevX: number;
  prevY: number;
}

interface BustEntry extends PhysicsEntry<EmoteBust> {
  readonly lr: string;
  readonly ud: string;
}

interface PendulumEntry extends PhysicsEntry<EmotePendulum> {
  readonly lr: string;
  readonly lrm: string;
  readonly ud: string;
  readonly out: EmotePendulumOutput;
}

/** Enabled entries with their PSB list index (the index the loaders bind). */
function enabled<T extends object>(
  list: readonly (T | EmoteDisabledControl)[],
): {control: T; index: number}[] {
  const out: {control: T; index: number}[] = [];
  list.forEach((c, index) => {
    if (!('enabled' in c && c.enabled === false)) out.push({control: c as T, index});
  });
  return out;
}

/** Writes a control output (map `operator[]` 0x10020140). */
function write(host: EmoteControlHost, label: string, value: number): void {
  const cell = host.variable(label);
  if (cell) cell.value = f32(value);
}

/**
 * The control set of one `MEmotePlayer`: the `emote::EP*` objects built from the metadata
 * (loaders under 0x10010ee0) and the drivers Progress (0x10011f80) calls. Per sub-step of at
 * most 1.1 frames: `stepEyes`, `stepEyebrows`, `stepMouths`, `stepSelectors`, the core's
 * transitions, `stepLoops`, the core's transform tweens, `stepWind`; after the clips:
 * `stepPhysics` with the whole frame count.
 */
export class EmoteControls implements EmoteControlSet {
  readonly eyes: readonly EmoteEye[];
  readonly eyebrows: readonly EmoteEyebrow[];
  readonly mouths: readonly EmoteMouth[];
  readonly selectors: readonly EmoteSelector[];
  readonly loops: readonly EmoteLoop[];
  readonly busts: readonly BustEntry[];
  readonly hair: readonly PendulumEntry[];
  readonly parts: readonly PendulumEntry[];
  /** `p+0x138`. */
  wind: EmoteWind | null = null;
  private readonly random: () => number;
  /** PSB list index of each enabled entry, per binding type. */
  private readonly bindings: Record<EmoteControlVariableType, {label: string; index: number}[]>;

  constructor(metadata: EmoteMetadata, options: EmoteControlsOptions = {}) {
    this.random = options.random ?? (() => emoteSharedRandom.next());
    const transition = options.transition ?? (() => null);
    const physics = <T>(control: T, baseLayer: string) => ({
      control,
      baseLayer,
      first: true,
      prevX: 0,
      prevY: 0,
    });
    this.busts = enabled(metadata.bustControl).map(({control: c}) => ({
      ...physics(new EmoteBust(c), c.baseLayer),
      lr: c.var_lr,
      ud: c.var_ud,
    }));
    const pendulums = (list: EmoteMetadata['hairControl']) =>
      enabled(list).map(({control: c}) => ({
        ...physics(new EmotePendulum(c), c.baseLayer),
        lr: c.var_lr,
        lrm: c.var_lrm,
        ud: c.var_ud,
        out: {lr: 0, lrm: 0, ud: 0},
      }));
    this.hair = pendulums(metadata.hairControl);
    this.parts = pendulums(metadata.partsControl);
    const eyes = enabled(metadata.eyeControl);
    this.eyes = eyes.map(({control}) => new EmoteEye(control, this.random));
    const brows = enabled(metadata.eyebrowControl);
    this.eyebrows = brows.map(({control}) => new EmoteEyebrow(control));
    const mouths = enabled(metadata.mouthControl);
    this.mouths = mouths.map(({control}) => new EmoteMouth(control));
    const selectors = (metadata.selectorControl ?? []).map((control, index) => ({control, index}));
    this.selectors = selectors.map(({control}) => new EmoteSelector(control, transition));
    this.loops = enabled(metadata.loopControl).map(({control}) => new EmoteLoop(control));
    this.bindings = {
      4: eyes.map(({control, index}) => ({label: control.label, index})),
      5: brows.map(({control, index}) => ({label: control.label, index})),
      6: mouths.flatMap(({control, index}) => [
        {label: control.label, index},
        {label: control.talkLabel, index},
      ]),
      8: selectors.map(({control, index}) => ({label: control.label, index})),
    };
  }

  /**
   * Loader bindings (eye 0x10015890, eyebrow 0x100171f0, mouth 0x10018920 with `label`
   * then `talkLabel`, selector 0x10019a50). The index is the PSB list position, while
   * `setVariable` indexes the list of enabled controls, as natively (they differ only when
   * a list has disabled entries, which no data has).
   */
  bindVariables(
    type: EmoteControlVariableType,
    bind: (label: string, index: number) => void,
  ): void {
    for (const {label, index} of this.bindings[type]) bind(label, index);
  }

  /** `SetVariable` dispatch (0x10012510 cases 4, 5, 6, 8). */
  setVariable(
    type: EmoteControlVariableType,
    index: number,
    label: string,
    value: number,
    frames: number,
    power: number,
    queue: boolean,
  ): void {
    const v = f32(value),
      fr = f32(frames),
      w = f32(power);
    switch (type) {
      case 4:
        this.eyes[index]?.set(v, fr, w, queue);
        break;
      case 5:
        this.eyebrows[index]?.set(v, fr, w, queue);
        break;
      case 6: {
        const mouth = this.mouths[index];
        if (!mouth) break;
        if (label === mouth.label) mouth.setFrame(v);
        else if (label === mouth.talkLabel) mouth.set(v, fr, w, queue);
        break;
      }
      case 8:
        this.selectors[index]?.set(v, fr, w, queue);
        break;
    }
  }

  /** 0x10017160: eye updates (0x10005520) for one sub-step `frames`. */
  stepEyes(host: EmoteControlHost, frames: number): void {
    for (const eye of this.eyes) write(host, eye.label, eye.update(frames, this.random));
  }

  /** 0x10018890: eyebrow updates (0x10007da0) for one sub-step `frames`. */
  stepEyebrows(host: EmoteControlHost, frames: number): void {
    for (const brow of this.eyebrows) write(host, brow.label, brow.update(frames));
  }

  /** 0x10019310: mouth updates (0x1000a7a0); writes `label` (frame) then `talkLabel`. */
  stepMouths(host: EmoteControlHost, frames: number): void {
    for (const mouth of this.mouths) {
      const [frame, level] = mouth.update(frames);
      write(host, mouth.label, frame);
      write(host, mouth.talkLabel, level);
    }
  }

  /** 0x1001a770: selector updates (0x1000b870); the variable is the selected index. */
  stepSelectors(host: EmoteControlHost, frames: number): void {
    for (const selector of this.selectors) write(host, selector.label, selector.update(frames));
  }

  /** 0x1001b320: loop updates (0x1000a580) into `var_loop`. */
  stepLoops(host: EmoteControlHost, frames: number): void {
    for (const loop of this.loops) write(host, loop.variable, loop.update(frames));
  }

  /** Progress gate of 0x1000d780: a wind exists and was configured (+0xc). */
  windActive(): boolean {
    return this.wind?.enabled ?? false;
  }

  /** 0x1000d780 for one sub-step `frames`. */
  stepWind(_host: EmoteControlHost, frames: number): void {
    this.wind?.update(frames, this.random);
  }

  /** 0x1000d630 (from `StartWind` 0x1001c340): a new wind, gusts cleared. */
  createWind(start: number, goal: number): void {
    this.wind = new EmoteWind(start, goal);
  }

  /** 0x1000d690. */
  configureWind(powerMin: number, powerMax: number, speed: number): void {
    this.wind?.set(powerMin, powerMax, speed);
  }

  destroyWind(): void {
    this.wind = null;
  }

  /**
   * Progress step 7 (0x10012129..): bust (0x10013c30) with `bustScale` (`p+0x24`), hair
   * (0x10015500) with `hairScale` (`p+0x28`), parts with `partsScale` (`p+0x2c`), over the
   * whole `frames` (skipped for 0, as Progress does).
   *
   * Per entry: the base layer position is read (0x10012210). The first call steps once by
   * `frames`; later calls step in pieces of at most 1.1 frames until frames − FLT_EPSILON,
   * interpolating the base position from the previous call's. The root rotation sets the
   * gravity direction. When every output of the entry is within ±0.01 all are written as
   * 0. The variables reach the clips at the next Progress.
   */
  stepPhysics(host: EmoteControlHost, frames: number): void {
    const total = f32(frames);
    if (total === 0) return;
    for (const entry of this.busts) {
      const out = {lr: 0, ud: 0};
      drive(host, entry, total, (x, y, step, rad) => {
        [out.lr, out.ud] = entry.control.update(x, y, step, f32(host.bustScale), rad);
      });
      if (Math.abs(out.lr) <= PHYSICS_REST && Math.abs(out.ud) <= PHYSICS_REST) out.lr = out.ud = 0;
      write(host, entry.lr, out.lr);
      write(host, entry.ud, out.ud);
    }
    this.drivePendulums(host, this.hair, host.hairScale, total);
    this.drivePendulums(host, this.parts, host.partsScale, total);
  }

  private drivePendulums(
    host: EmoteControlHost,
    list: readonly PendulumEntry[],
    scale: number,
    frames: number,
  ): void {
    const s = f32(scale);
    for (const entry of list) {
      const {out} = entry;
      drive(host, entry, frames, (x, y, step, rad) =>
        entry.control.update(x, y, step, s, rad, this.wind, out),
      );
      if (
        Math.abs(out.lr) <= PHYSICS_REST &&
        Math.abs(out.lrm) <= PHYSICS_REST &&
        Math.abs(out.ud) <= PHYSICS_REST
      )
        out.lr = out.lrm = out.ud = 0;
      write(host, entry.lr, out.lr);
      write(host, entry.lrm, out.lrm);
      write(host, entry.ud, out.ud);
    }
  }

  /**
   * `Skip` (0x10012190) for these controls: bust (0x10013b80) and hair/parts (0x10015480)
   * return to their loaded `param` state and first-step flags; eyes, eyebrows, mouths and
   * selectors finish their requests (0x10017020, 0x10018760, 0x10019220, 0x1001a680).
   */
  skip(): void {
    for (const e of this.busts) {
      e.control.reset();
      e.first = true;
    }
    for (const e of [...this.hair, ...this.parts]) {
      e.control.reset();
      e.first = true;
    }
    for (const eye of this.eyes) eye.motion.skip();
    for (const brow of this.eyebrows) brow.motion.skip();
    for (const mouth of this.mouths) mouth.skip();
    for (const selector of this.selectors) selector.skip();
  }

  /**
   * Control part of `IsAnimating` (0x100108f0), in native order: selectors, (transitions in
   * the core), eyes, eyebrows, mouths. A mouth counts when neither of its labels is a
   * timeline track.
   */
  isAnimating(timelineVariables: ReadonlySet<string>): boolean {
    const free = (label: string) => !timelineVariables.has(label);
    return (
      this.selectors.some((s) => s.busy && free(s.label)) ||
      this.eyes.some((e) => e.motion.busy && free(e.label)) ||
      this.eyebrows.some((e) => e.motion.busy && free(e.label)) ||
      this.mouths.some((m) => m.busy && free(m.label) && free(m.talkLabel))
    );
  }

  /**
   * Control part of `AssignState` (0x1000f2a0): eye and eyebrow graph motions, mouths and
   * selectors copy the state of the source control with the same label. Blink, loop and
   * physics state are not copied; the wind is restarted by the core.
   */
  assignState(source: EmoteControlSet): void {
    if (!(source instanceof EmoteControls) || source === this) return;
    const copy = <T extends {label: string; assign(s: T): void}>(
      from: readonly T[],
      to: readonly T[],
    ) => {
      for (const s of from) to.find((t) => t.label === s.label)?.assign(s);
    };
    copy(source.eyes, this.eyes);
    copy(source.eyebrows, this.eyebrows);
    copy(source.mouths, this.mouths);
    copy(source.selectors, this.selectors);
  }
}

/** Shared driver loop of 0x10013c30 and 0x10015500. */
function drive<T>(
  host: EmoteControlHost,
  entry: PhysicsEntry<T>,
  frames: number,
  step: (x: number, y: number, frames: number, rad: number) => void,
): void {
  const [x, y] = basePosition(host, entry.baseLayer, entry.prevX, entry.prevY);
  // Degrees → radians with the double 2π (0x10072760) and 360 (0x10072758).
  const rad = () => f32((f32(host.rootAngle) * 6.2831854820251465) / 360);
  if (entry.first) {
    entry.first = false;
    step(x, y, frames, rad());
  } else {
    const limit = frames - PHYSICS_EPSILON;
    if (limit > 0) {
      let t = 0;
      do {
        const rest = f32(frames - t);
        const sub = rest <= SUBSTEP_LIMIT ? rest : EMOTE_SUBSTEP;
        t = f32(sub + t);
        const ratio = f32(t / frames);
        const xi = f32(ratio * x + entry.prevX * (1 - ratio));
        const yi = f32((1 - ratio) * entry.prevY + y * ratio);
        step(xi, yi, sub, rad());
      } while (t < limit);
    }
  }
  entry.prevX = x;
  entry.prevY = y;
}

/**
 * 0x10012210: the base layer's point relative to the root coordinate, scaled by
 * `inverseScale`, plus the root coordinate; the previous position when the layer has none.
 */
function basePosition(
  host: EmoteControlHost,
  label: string,
  prevX: number,
  prevY: number,
): [number, number] {
  const point = host.shapePoint?.(label) ?? null;
  if (!point) return [prevX, prevY];
  const rx = f32(host.rootX ?? 0),
    ry = f32(host.rootY ?? 0),
    s = f32(host.inverseScale ?? 1);
  const dx = f32(f32(point.x) - rx),
    dy = f32(f32(point.y) - ry);
  return [f32(rx + f32(dx * s)), f32(ry + f32(s * dy))];
}

/**
 * Builds the control set of a model's metadata. Matches `EmoteControlSetFactory`; `options`
 * adds the generator and the selector's transition lookup.
 */
export function createEmoteControls(
  metadata: EmoteMetadata,
  options: EmoteControlsOptions = {},
): EmoteControls {
  return new EmoteControls(metadata, options);
}
