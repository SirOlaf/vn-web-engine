import type {EmoteModel, EmoteMotion} from '../../../formats/kirikiri/emote-model.js';
import type {EmoteVariableFrames} from '../../../formats/kirikiri/emote-metadata.js';
import {EmoteTween, easingPower} from './controls/transition.js';
import {EMOTE_TWO_PI, EmoteRotateTween} from './controls/rotate.js';
import {EmoteTimelineSet} from './player/timelines.js';
import type {
  EmoteClipDriver,
  EmoteClipFactory,
  EmoteClipListener,
  EmoteClipPlayerAccess,
  EmoteControlHost,
  EmoteControlHostRandom,
  EmoteControlSet,
  EmoteControlSetFactory,
  EmoteControlVariableType,
  EmoteVariableCell,
  EmoteWindState,
} from './interfaces.js';

/**
 * `MEmotePlayer` (vtable 0x10071cac, 0x1e8 bytes, `PEmotePlayer+0x10`): Progress, variables,
 * timelines, transform tweens and the transition and clamp controls of one E-mote player.
 * Addresses refer to `emotedriver.dll` SHA-256 `a3b693b6…5e70b3a86`; field comments name the
 * native offsets (`p+…`).
 *
 * The clips (`MMotionPlayer`) and the eye, eyebrow, mouth, selector, loop, wind and physics
 * controls are reached through `EmoteClipDriver` and `EmoteControlSet`. Stereovision
 * (`p+0x1c0`) is never enabled by this build; its paths (0x1001fc00, 0x1001fcb0 and the
 * per-clip mapping in 0x100129d0) are not reproduced, so the player always has one clip.
 */

const f32 = Math.fround;
/** Largest Progress sub-step: `float` 1.1 (0x100728b0). */
const SUB_STEP = f32(1.1);
const PI_F = f32(Math.PI);

export type EmotePlayerClip = EmoteClipDriver & EmoteClipPlayerAccess;

export interface EmotePlayerCoreOptions {
  readonly model: EmoteModel;
  readonly createClip: EmoteClipFactory;
  readonly createControls: EmoteControlSetFactory;
  /** Receives clip events (0x10033fe0). Default: ignored. */
  readonly listener?: EmoteClipListener;
}

/** `transitionControl` entry (`p+0xe4`, 0x20 bytes): tween and variable label. */
interface TransitionEntry {
  readonly label: string;
  readonly tween: EmoteTween;
}

/** `clampControl` entry (`p+0x114`, 0x44 bytes, 0x1001b8c0). */
interface ClampEntry {
  readonly type: number;
  readonly min: number;
  readonly max: number;
  readonly varLr: string;
  readonly varUd: string;
}

/** Root tween values last written to the clips (root node +0x288..+0x298). */
interface RootValues {
  x: number;
  y: number;
  /** Degrees (+0x294). */
  angle: number;
  scale: number;
}

/** MSVC CRT `rand` (`holdrand`, seed 1): one sequence for the process, as natively. */
let holdrand = 1;
function crtRand(): number {
  holdrand = (Math.imul(holdrand, 214013) + 2531011) | 0;
  return (holdrand >>> 16) & 0x7fff;
}

/** x87 `fistp` in the default rounding mode (nearest, ties to even). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** `std::map<std::string, …>` key order (bytes; UTF-16 order equals it outside surrogates). */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class EmotePlayerCore {
  readonly model: EmoteModel;
  readonly motion: EmoteMotion;
  private readonly createClip: EmoteClipFactory;
  private readonly createControls: EmoteControlSetFactory;
  private readonly listener: EmoteClipListener;

  /** `p+0xc` clips; `p+0x8` is the first. */
  clips: EmotePlayerClip[] = [];
  /** `p+0x1cc`. */
  currentClip = 0;
  controls!: EmoteControlSet;

  /** `p+0x1c` model scale and `p+0x20` = 1 / (scale tween · `p+0x1c`). */
  modelScale = 1;
  inverseScale = 1;
  /** `p+0x24` bust, `p+0x28` hair, `p+0x2c` parts scale. */
  bustScale = 1;
  hairScale = 1;
  partsScale = 1;
  /** `p+0x30` (`queuing`, slots 11/12): tweens queue instead of replacing. */
  queuing = false;
  /** `p+0x31`: forces one more Progress sub-step (set by every setter). */
  private forceStep = false;
  /** `p+0x34`..`p+0x40`: Progress runs on call `slot` of every `divisor` calls. */
  private queueDivisor = 1;
  private queueSlot = 0;
  private queuePhase = 0;
  private pendingFrames = 0;

  /** `p+0x44` (`variableList`). */
  readonly variableList: EmoteVariableFrames[] = [];
  /** `p+0x54` binding map: label → control type and index. */
  private readonly bindings = new Map<
    string,
    {type: EmoteControlVariableType | 7; index: number}
  >();
  /** `p+0x64` variable map and its key order. */
  private readonly cells = new Map<string, EmoteVariableCell>();
  private cellOrder: string[] = [];
  /** `p+0x74` (`instantVariableList`). */
  private readonly instant = new Set<string>();

  /** `p+0xe4` transitions, `p+0x114` clamps, `p+0x150` mirror fragments. */
  private readonly transitions: TransitionEntry[] = [];
  private readonly clamps: ClampEntry[] = [];
  private mirrorMatch: readonly string[] = [];

  /** `p+0x124..0x134` `StartWind` arguments and `p+0x138` (host view of the wind control). */
  private windStart = 0;
  private windGoal = 0;
  private windSpeed = 0;
  private windMin = 0;
  private windMax = 0;
  wind: EmoteWindState | null = null;

  /** `p+0x13c` coord (2), `p+0x140` scale (1), `p+0x144` colour (4), `p+0x148` rotation. */
  readonly coordTween = new EmoteTween(2);
  readonly scaleTween = new EmoteTween(1);
  readonly colorTween = new EmoteTween(4);
  readonly rotateTween = new EmoteRotateTween();

  /** `p+0x14c` effective mirror, `p+0x14d` (never set by this build), `p+0x14e` model mirror. */
  mirror = false;
  private readonly mirrorOverride = false;

  readonly timelines: EmoteTimelineSet;
  private root: RootValues = {x: 0, y: 0, angle: 0, scale: 1};

  /** Host passed to the controls. */
  readonly host: EmoteControlHost & EmoteControlHostRandom;

  /**
   * Player construction (0x1000da90 → 0x1000e460 → 0x10010ee0). With `cloneOf`, the copy
   * constructor (0x1000e000): the clips are copies of the source clips and the state is
   * assigned from the source after loading.
   */
  constructor(options: EmotePlayerCoreOptions, cloneOf?: EmotePlayerCore) {
    this.model = options.model;
    this.createClip = options.createClip;
    this.createControls = options.createControls;
    this.listener = options.listener ?? {action() {}};
    const self = this;
    this.host = {
      variable: (label) => self.cell(label),
      get clips() {
        return self.clips;
      },
      get currentClip() {
        return self.currentClip;
      },
      get rootAngle() {
        return self.root.angle;
      },
      get hairScale() {
        return self.hairScale;
      },
      get partsScale() {
        return self.partsScale;
      },
      get bustScale() {
        return self.bustScale;
      },
      random: () => crtRand() / 0x8000,
      rand: crtRand,
      get wind() {
        return self.wind;
      },
    };
    this.timelines = new EmoteTimelineSet(
      {
        get queuing() {
          return self.queuing;
        },
        setVariable: (label, value, frames, easing) =>
          self.setVariable(label, value, frames, easing),
      },
      this.instant,
    );

    const {chara, motion} = this.model.metadata.base;
    const m = this.model.objects.get(chara)?.motions.get(motion);
    if (!m) throw new Error(`emotedriver: undefined motion ${chara}/${motion}`);
    this.motion = m;
    if (cloneOf) {
      // 0x1000e000: MEmotePlayer vtable[2] (0x1000f220) copies each clip.
      this.clips = cloneOf.clips.map((c) => {
        const clip = this.createClip(m);
        clip.assignState(c);
        return clip;
      });
      this.root = {...cloneOf.root};
    } else {
      // 0x1000da90: MEmotePlayer vtable[1] (0x1000f160).
      this.clips = [this.createClip(m)];
    }

    // 0x1000e460 defaults and initial tweens.
    this.setCoord(0, 0, 0, 0);
    this.setScale(1, 0, 0);
    this.setRot(0, 0, 0);
    this.setColor(0x808080ff, 0, 0);
    this.load();
    if (cloneOf) this.assignState(cloneOf);
  }

  /** Copy constructor (slot 2, 0x10001dc0 → 0x10001bd0 → 0x1000e000). */
  clone(): EmotePlayerCore {
    return new EmotePlayerCore(
      {
        model: this.model,
        createClip: this.createClip,
        createControls: this.createControls,
        listener: this.listener,
      },
      this,
    );
  }

  private get mainClip(): EmotePlayerClip {
    return this.clips[0]!;
  }

  // -------------------------------------------------------------------------------------
  // Loading

  /** 0x10010ee0 (after the reset 0x10011e80, which a new player does not need). */
  private load(): void {
    const md = this.model.metadata;
    this.mirror = this.mirrorOverride !== md.mirror;
    this.writeRoot();
    this.skip();
    const clip = this.mainClip;
    clip.advance(0);
    clip.evaluate();
    clip.dispatchEvents(this.listener);
    this.modelScale = f32(md.scale);
    const s = this.scaleTween.step(0)[0]!;
    this.inverseScale = f32(1 / (this.modelScale * s));

    this.controls = this.createControls(md);
    const bind = (type: EmoteControlVariableType | 7) => (label: string, index: number) => {
      if (!this.bindings.has(label)) this.bindings.set(label, {type, index});
    };
    this.controls.bindVariables(4, bind(4));
    this.controls.bindVariables(5, bind(5));
    this.controls.bindVariables(6, bind(6));
    // 0x100193d0: the binding index is the position in the PSB list.
    md.transitionControl.forEach((entry, index) => {
      if (!entry.enabled) return;
      bind(7)(entry.label, index);
      this.transitions.push({label: entry.label, tween: new EmoteTween(1)});
    });
    this.controls.bindVariables(8, bind(8));
    // 0x1001b8c0.
    for (const c of md.clampControl) {
      if (!c.enabled) continue;
      this.clamps.push({
        type: c.type,
        min: f32(c.min),
        max: f32(c.max),
        varLr: c.var_lr,
        varUd: c.var_ud,
      });
    }
    this.mirrorMatch = md.mirrorControl.variableMatchList;
    for (const label of md.instantVariableList ?? []) this.instant.add(label);
    this.timelines.loadList(md.timelineControl);
    // `variableList`: frames of a repeated label are inserted before the existing ones.
    for (const v of md.variableList ?? []) {
      const frames = v.frames.map((fr) => ({label: fr.label, frame: f32(fr.frame)}));
      const i = this.variableList.findIndex((e) => e.label === v.label);
      if (i >= 0) {
        const e = this.variableList[i]!;
        this.variableList[i] = {label: e.label, frames: [...frames, ...e.frames]};
      } else {
        this.variableList.push({label: v.label, frames});
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Variables

  /** Variable map lookup with insertion (0x10020140); new cells hold 0. */
  cell(label: string): EmoteVariableCell {
    let c = this.cells.get(label);
    if (!c) {
      c = {label, value: 0};
      this.cells.set(label, c);
      let lo = 0,
        hi = this.cellOrder.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareKeys(this.cellOrder[mid]!, label) < 0) lo = mid + 1;
        else hi = mid;
      }
      this.cellOrder.splice(lo, 0, label);
    }
    return c;
  }

  /**
   * 0x10012510 (`SetVariable` slot 32 via 0x10012440). A variable without a control binding
   * takes the value at once; bound variables start the control's tween.
   */
  setVariable(label: string, value: number, frames: number, easing: number): void {
    this.forceStep = true;
    const power = easingPower(easing);
    const binding = this.bindings.get(label);
    if (!binding) {
      this.cell(label).value = f32(value);
      return;
    }
    if (binding.type === 7) {
      this.transitions[binding.index]?.tween.set([f32(value)], f32(frames), power, this.queuing);
      return;
    }
    this.controls.setVariable(
      binding.type,
      binding.index,
      label,
      f32(value),
      f32(frames),
      power,
      this.queuing,
    );
  }

  /** 0x100127b0: the map value, else the clip's parameter value. */
  getVariable(label: string): number {
    const c = this.cells.get(label);
    return c ? c.value : f32(this.mainClip.getVariable(label));
  }

  /** 0x1001c860: mirrored players negate variables whose label contains a match fragment. */
  private mirrorSign(label: string): boolean {
    if (!this.mirror) return false;
    return this.mirrorMatch.some((m) => label.includes(m));
  }

  /** 0x10012910: variables → main clip (0x100129d0 → 0x100319f0), then the clamps. */
  private applyVariables(): void {
    const clip = this.mainClip;
    for (const label of this.cellOrder) {
      let v = this.timelines.blended(label, this.cells.get(label)!.value);
      if (this.mirrorSign(label)) v = -v;
      clip.applyVariable(label, v);
    }
    this.applyClamps();
  }

  /** 0x1001bff0: `clampControl` limits a two-variable pair to a disc (type 1) or eases it (0). */
  private applyClamps(): void {
    const clip = this.mainClip;
    for (const c of this.clamps) {
      let lr = this.timelines.blended(c.varLr, this.cells.get(c.varLr)?.value ?? 0);
      let ud = this.timelines.blended(c.varUd, this.cells.get(c.varUd)?.value ?? 0);
      const range = c.max - c.min;
      lr = f32(((lr - c.min) / range) * 2 - 1);
      ud = f32(((ud - c.min) / range) * 2 - 1);
      if (lr !== 0 && ud !== 0) {
        if (c.type === 0) {
          let r = f32(Math.abs(f32(lr / ud)));
          if (r > 1) r = f32(1 / r);
          const k = f32(1 / f32(Math.sqrt(f32(r * r + 1))));
          lr = f32(k * lr);
          ud = f32(k * ud);
          const len = f32(Math.sqrt(f32(lr * lr + ud * ud)));
          const c1 = f32(1 - f32(Math.cos(f32(r * PI_F * 0.5))));
          const ratio = f32(f32(Math.sin(f32(len * PI_F * 0.5))) / len);
          const m = f32((ratio - 1) * c1 + 1);
          lr = f32(m * lr);
          ud = f32(m * ud);
        } else if (c.type === 1) {
          const len = f32(Math.sqrt(f32(lr * lr + ud * ud)));
          if (len > 1) {
            const a = f32(Math.atan2(ud, lr));
            lr = f32(Math.cos(a));
            ud = f32(Math.sin(a));
          }
        }
      }
      lr = f32((lr + 1) * 0.5 * range + c.min);
      ud = f32(range * ((ud + 1) * 0.5) + c.min);
      if (this.mirrorSign(c.varLr)) lr = -lr;
      clip.applyVariable(c.varLr, lr);
      clip.applyVariable(c.varUd, ud);
    }
  }

  // -------------------------------------------------------------------------------------
  // Progress

  /** 0x10011f80 (slot 54). */
  progress(frames: number): void {
    const total = f32(f32(frames) + this.pendingFrames);
    this.queuePhase = ((this.queuePhase + 1) >>> 0) % this.queueDivisor;
    if (this.queuePhase !== this.queueSlot) {
      this.pendingFrames = total;
      return;
    }
    this.pendingFrames = 0;
    // 0x1001fc00 maintains the stereovision clip pair only.
    this.timelines.advance(total);
    const host = this.host;
    let rest = total;
    while (rest > 0 || this.forceStep) {
      this.forceStep = false;
      const step = rest <= SUB_STEP ? rest : SUB_STEP;
      this.controls.stepEyes(host, step);
      this.controls.stepEyebrows(host, step);
      this.controls.stepMouths(host, step);
      this.controls.stepSelectors(host, step);
      this.stepTransitions(step);
      this.controls.stepLoops(host, step);
      this.stepTransforms(step);
      if (this.controls.windActive()) this.controls.stepWind(host, step);
      rest = f32(rest - step);
    }
    this.applyVariables();
    for (const clip of this.clips) {
      clip.advance(total);
      clip.evaluate();
      clip.dispatchEvents(this.listener);
    }
    if (total !== 0) this.controls.stepPhysics(host, total);
  }

  /** 0x100199c0: transition tweens write their variables. */
  private stepTransitions(frames: number): void {
    for (const t of this.transitions) this.cell(t.label).value = t.tween.step(frames)[0]!;
  }

  /** 0x1001b5f0: coord, colour, scale and rotation tweens → every clip. */
  private stepTransforms(frames: number): void {
    const coord = this.coordTween.step(frames);
    this.root.x = coord[0]!;
    this.root.y = coord[1]!;
    const c = this.colorTween.step(frames);
    const argb =
      (((((roundEven(c[3]!) << 8) | roundEven(c[2]!)) << 8) | roundEven(c[1]!)) << 8) |
      roundEven(c[0]!);
    for (const clip of this.clips) clip.color = argb >>> 0;
    const s = this.scaleTween.step(frames)[0]!;
    this.inverseScale = f32(1 / (s * this.modelScale));
    this.root.scale = s;
    const rad = this.rotateTween.step(frames);
    this.root.angle = f32((rad * 360) / EMOTE_TWO_PI);
    this.writeRoot();
  }

  /** Root node +0x283 (mirror) and +0x288..+0x29c; the clip sets its dirty flag on change. */
  private writeRoot(): void {
    const r = this.root;
    for (const clip of this.clips) {
      clip.setRootTransform({
        x: r.x,
        y: r.y,
        angle: r.angle,
        scaleX: r.scale,
        scaleY: r.scale,
        mirror: this.mirror,
      });
    }
  }

  // -------------------------------------------------------------------------------------
  // Transform setters (0x1001b3a0, 0x1001b420, 0x1001b4a0, 0x1001b510)

  setCoord(x: number, y: number, frames: number, easing: number): void {
    this.forceStep = true;
    this.coordTween.set([f32(x), f32(y)], f32(frames), easingPower(easing), this.queuing);
  }

  setScale(scale: number, frames: number, easing: number): void {
    this.forceStep = true;
    this.scaleTween.set([f32(scale)], f32(frames), easingPower(easing), this.queuing);
  }

  /** Radians. */
  setRot(rot: number, frames: number, easing: number): void {
    this.forceStep = true;
    this.rotateTween.set(f32(rot), f32(frames), easingPower(easing), this.queuing);
  }

  setColor(argb: number, frames: number, easing: number): void {
    const v = argb >>> 0;
    this.forceStep = true;
    this.colorTween.set(
      [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24],
      f32(frames),
      easingPower(easing),
      this.queuing,
    );
  }

  /** Slot 20 (0x10001fb0): root +0x288/+0x28c of the main clip. */
  getCoord(): {readonly x: number; readonly y: number} {
    return {x: this.root.x, y: this.root.y};
  }

  /** Slot 22 (0x10002020): root +0x298. */
  getScale(): number {
    return this.root.scale;
  }

  /** Slot 24 (0x10002070): root +0x294 in radians. */
  getRot(): number {
    return f32((this.root.angle * EMOTE_TWO_PI) / 360);
  }

  /** Slot 26 (0x100020e0): main clip +0x150. */
  getColor(): number {
    return this.mainClip.color >>> 0;
  }

  // -------------------------------------------------------------------------------------
  // Wind (0x1001c340)

  startWind(start: number, goal: number, speed: number, powerMin: number, powerMax: number): void {
    let s = f32(start),
      g = f32(goal),
      sp = f32(speed);
    const mn = f32(powerMin),
      mx = f32(powerMax);
    if (sp < 0) {
      [s, g] = [g, s];
      sp = f32(-sp);
    }
    if (g !== s && sp !== 0 && (mn !== 0 || mx !== 0)) {
      let power = 0;
      if (!this.wind || s !== this.windStart || g !== this.windGoal) {
        this.controls.createWind(f32(s / this.modelScale), f32(g / this.modelScale));
      } else {
        power = this.wind.power;
      }
      this.windStart = s;
      this.windGoal = g;
      this.windSpeed = sp;
      this.windMin = mn;
      this.windMax = mx;
      this.wind = {start: s, goal: g, speed: sp, powerMin: mn, powerMax: mx, power};
      this.controls.configureWind(mn, mx, f32(sp / this.modelScale));
      return;
    }
    this.controls.destroyWind();
    this.wind = null;
  }

  stopWind(): void {
    this.startWind(0, 0, 0, 0, 0);
  }

  // -------------------------------------------------------------------------------------
  // Skip, Pass, IsAnimating, Show/Hide

  /** 0x10012190 (slot 52). */
  skip(): void {
    this.timelines.skip();
    // Controls are created by `load` after its own `skip`.
    this.controls?.skip();
    for (const t of this.transitions) t.tween.skip();
    this.coordTween.skip();
    this.scaleTween.skip();
    this.rotateTween.skip();
    this.colorTween.skip();
  }

  /** 0x1001f180 (slot 53). */
  pass(): void {
    this.timelines.pass();
  }

  /** 0x100108f0 (slot 51). The colour tween is not checked. */
  isAnimating(): boolean {
    if (this.coordTween.busy || this.scaleTween.busy || this.rotateTween.busy) return true;
    const labels = new Set<string>();
    if (this.timelines.animating(labels)) return true;
    for (const t of this.transitions) if (t.tween.busy && !labels.has(t.label)) return true;
    return this.controls.isAnimating(labels);
  }

  /** 0x10010850 (slot 4). */
  show(): void {
    for (const clip of this.clips) clip.rootVisible = true;
  }

  /** 0x100108a0 (slot 5). */
  hide(): void {
    for (const clip of this.clips) clip.rootVisible = false;
  }

  /** Slot 6 (0x10001e70). */
  isHidden(): boolean {
    return !this.mainClip.rootVisible;
  }

  /** Slots 9/10 (0x10001eb0/0x10001ef0): clip +0x358. */
  setMeshDivisionRatio(ratio: number): void {
    for (const clip of this.clips) clip.meshDivisionRatio = f32(ratio);
  }

  getMeshDivisionRatio(): number {
    return this.mainClip.meshDivisionRatio;
  }

  /** Slot 55 (0x10002b20 → 0x10032950). */
  isModified(): boolean {
    return this.mainClip.isModified();
  }

  // -------------------------------------------------------------------------------------
  // Queries (slots 27–43)

  countVariables(): number {
    return this.variableList.length;
  }

  getVariableLabelAt(index: number): string {
    return this.variableList[index]?.label ?? '';
  }

  countVariableFrameAt(index: number): number {
    return this.variableList[index]?.frames.length ?? 0;
  }

  /** 0x10012e80. */
  getVariableFrameLabelAt(index: number, frame: number): string {
    return this.variableList[index]?.frames[frame]?.label ?? '';
  }

  getVariableFrameValueAt(index: number, frame: number): number {
    return this.variableList[index]?.frames[frame]?.frame ?? 0;
  }

  // -------------------------------------------------------------------------------------
  // AssignState (0x1000f2a0)

  assignState(source: EmotePlayerCore): void {
    if (source === this) return;
    this.bustScale = source.bustScale;
    this.hairScale = source.hairScale;
    this.partsScale = source.partsScale;
    this.queuing = source.queuing;
    this.queueDivisor = source.queueDivisor;
    this.queueSlot = source.queueSlot;
    this.queuePhase = source.queuePhase;
    this.pendingFrames = source.pendingFrames;
    this.currentClip = source.currentClip;
    this.windStart = source.windStart;
    this.windGoal = source.windGoal;
    this.windSpeed = source.windSpeed;
    this.windMax = source.windMax;
    this.windMin = source.windMin;
    this.startWind(this.windStart, this.windGoal, this.windSpeed, this.windMin, this.windMax);
    this.coordTween.copyFrom(source.coordTween);
    this.scaleTween.copyFrom(source.scaleTween);
    this.colorTween.copyFrom(source.colorTween);
    this.rotateTween.copyFrom(source.rotateTween);
    this.controls.assignState(source.controls);
    for (const from of source.transitions) {
      const to = this.transitions.find((t) => t.label === from.label);
      to?.tween.copyFrom(from.tween);
    }
    this.timelines.assignFrom(source.timelines);
  }
}
