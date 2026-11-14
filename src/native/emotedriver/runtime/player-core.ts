import {emoteBuild, EMOTEDRIVER_X64_SHA256, type EmoteBuild} from '../build.js';
import {EmoteOrbit} from './controls/orbit.js';
import type {EmoteModel, EmoteMotion} from '../../../formats/kirikiri/emote-model.js';
import type {EmoteVariableFrames} from '../../../formats/kirikiri/emote-metadata.js';
import {EmoteTween, easingPower} from './controls/transition.js';
import {EMOTE_TWO_PI, EmoteRotateTween, wrapAngle} from './controls/rotate.js';
import {EmoteVariableClamp} from './player/clamp.js';
import {EmoteTimelineSet} from './player/timelines.js';
import {EmoteApiLog} from './player/api-log.js';
import {emoteStereovisionCoefficients} from './player/stereovision.js';
import type {
  EmoteClipDriver,
  EmoteClipFactory,
  EmoteClipListener,
  EmoteClipPlayerAccess,
  EmoteX64ClipPlayerAccess,
  EmoteControlHost,
  EmoteControlHostRandom,
  EmoteControlSet,
  EmoteX64ControlSet,
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

export type EmotePlayerClip = EmoteClipDriver & EmoteClipPlayerAccess;

export interface EmotePlayerCoreOptions {
  readonly driverSha256?: string;
  /** X64 resource-group generator, retained across clones and InitCore. */
  readonly random?: () => number;
  readonly model: EmoteModel;
  readonly createClip: EmoteClipFactory;
  readonly createControls: EmoteControlSetFactory;
  /** Receives clip events (0x10033fe0). Default: ignored. */
  readonly listener?: EmoteClipListener;
}

/** `transitionControl` entry (`p+0xe4`, 0x20 bytes): tween and variable label. */
interface TransitionEntry {
  readonly enabled?: boolean;
  readonly label: string;
  readonly tween: EmoteTween;
}

/** `clampControl` entry (`p+0x114`, 0x44 bytes, 0x1001b8c0). */
interface ClampEntry {
  readonly kernel: EmoteVariableClamp;
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

interface VariableDiff {
  readonly module: string;
  readonly label: string;
  readonly tween: EmoteTween;
}

/** UTF-8 key order, including surrogate pairs. */
export function compareEmoteUtf8(a: string, b: string): number {
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

export class EmotePlayerCore {
  private readonly apiLog: EmoteApiLog | null;
  readonly driverSha256: EmoteBuild;
  private readonly x64: boolean;
  private readonly random: (() => number) | undefined;
  private readonly diffs: VariableDiff[] = [];
  private readonly diffSums = new Map<string, number>();
  private readonly variableLabels = new Set<string>();
  private readonly orbits: EmoteOrbit[] = [];
  /** Native x64 +0x300..+0x314, retained by copy independently of the camera cache. */
  private readonly stereovision = {
    enabled: false,
    volume: 1,
    parallaxRatio: f32(0.2),
    screenCount: 2,
    dirty: true,
  };
  private readonly stereoVariables = new Map<
    string,
    {
      readonly range: readonly [number, number];
      readonly coefficients: Float32Array;
    }
  >();
  private asOriginalScale = false;
  flags = 0x201;
  private readonly forceSums = [
    new Float32Array(2),
    new Float32Array(2),
    new Float32Array(2),
  ] as const;
  private readonly outerForces = {bust: {x: 0, y: 0}, hair: {x: 0, y: 0}, parts: {x: 0, y: 0}};
  private readonly grayscaleTween: EmoteTween;
  private readonly forceTweens: readonly [EmoteTween, EmoteTween, EmoteTween];
  private readonly outerRotateTween: EmoteRotateTween;
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
    {type: EmoteControlVariableType | 0 | 1 | 2 | 7 | 9; index: number}
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
  readonly coordTween: EmoteTween;
  readonly scaleTween: EmoteTween;
  readonly colorTween: EmoteTween;
  readonly rotateTween: EmoteRotateTween;

  /** `p+0x14c` effective mirror, `p+0x14d` (never set by this build), `p+0x14e` model mirror. */
  mirror = false;
  private readonly mirrorOverride = false;

  readonly timelines: EmoteTimelineSet;
  private root: RootValues = {x: 0, y: 0, angle: 0, scale: 1};
  private readonly rootTransformInput = {
    x: 0,
    y: 0,
    angle: 0,
    scaleX: 1,
    scaleY: 1,
    mirror: false,
  };

  /** Host passed to the controls. */
  readonly host: EmoteControlHost & EmoteControlHostRandom;

  /**
   * Player construction (0x1000da90 → 0x1000e460 → 0x10010ee0). With `cloneOf`, the copy
   * constructor (0x1000e000): the clips are copies of the source clips and the state is
   * assigned from the source after loading.
   */
  constructor(options: EmotePlayerCoreOptions, cloneOf?: EmotePlayerCore) {
    this.driverSha256 = emoteBuild(options.driverSha256);
    this.x64 = this.driverSha256 === EMOTEDRIVER_X64_SHA256;
    this.apiLog = this.x64 ? new EmoteApiLog() : null;
    if (cloneOf && cloneOf.driverSha256 !== this.driverSha256)
      throw Error('emotedriver: player DLL build mismatch');
    this.random = options.random;
    if (this.x64 && !this.random)
      throw Error('emotedriver: x64 player requires its process random source');
    this.coordTween = new EmoteTween(2, this.driverSha256);
    this.scaleTween = new EmoteTween(1, this.driverSha256);
    this.colorTween = new EmoteTween(4, this.driverSha256);
    this.rotateTween = new EmoteRotateTween(this.driverSha256);
    this.grayscaleTween = new EmoteTween(1, this.driverSha256);
    this.forceTweens = [
      new EmoteTween(2, this.driverSha256),
      new EmoteTween(2, this.driverSha256),
      new EmoteTween(2, this.driverSha256),
    ];
    this.outerRotateTween = new EmoteRotateTween(this.driverSha256);
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
      shapePoint: (label) => self.mainClip.shapePoint?.(label) ?? null,
      get rootX() {
        return self.root.x;
      },
      get rootY() {
        return self.root.y;
      },
      get inverseScale() {
        return self.inverseScale;
      },
      random: () => (self.x64 ? self.random!() : crtRand() / 0x8000),
      rand: crtRand,
      physicsBasePosition: (label) => self.physicsBasePosition(label),
      get physicsAngle() {
        return self.physicsAngle;
      },
      get outerForces() {
        return self.outerForces;
      },
      get wind() {
        return self.wind;
      },
    };
    this.timelines = new EmoteTimelineSet(
      {
        get apiLog() {
          return self.apiLog;
        },
        get queuing() {
          return self.queuing;
        },
        setVariable: (label, value, frames, easing) =>
          self.setVariable(label, value, frames, easing),
      },
      this.instant,
      this.driverSha256,
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

    if (this.x64) {
      const clip = this.mainClip as EmotePlayerClip & Partial<EmoteX64ClipPlayerAccess>;
      for (const key of ['setOwnRotation', 'setGrayscale', 'layerPosition'] as const)
        if (typeof clip[key] !== 'function') throw Error(`emotedriver: x64 clip missing ${key}`);
      if (
        typeof clip.rootDirty !== 'boolean' ||
        typeof clip.smoothing !== 'boolean' ||
        typeof clip.ownRotation !== 'boolean' ||
        typeof clip.ownRotationAngle !== 'number' ||
        typeof clip.grayscaleMode !== 'number' ||
        typeof clip.grayscaleLevel !== 'number'
      )
        throw Error('emotedriver: incomplete x64 clip state');
    }
    // 0x1000e460 defaults and initial tweens.
    this.setCoord(0, 0, 0, 0);
    this.setScale(1, 0, 0);
    this.setRot(0, 0, 0);
    this.setColor(0x808080ff, 0, 0);
    if (this.x64) this.setGrayscale(0, 0, 0);
    this.load();
    if (cloneOf) this.assignState(cloneOf);
  }

  /** Copy constructors 0x1000e000 / 0x180008b50; each clip is copied independently. */
  clone(): EmotePlayerCore {
    return new EmotePlayerCore(
      {
        model: this.model,
        driverSha256: this.driverSha256,
        ...(this.random ? {random: this.random} : {}),
        createClip: this.createClip,
        createControls: this.createControls,
        listener: this.listener,
      },
      this,
    );
  }

  private get x64Clip(): EmotePlayerClip & EmoteX64ClipPlayerAccess {
    return this.mainClip as EmotePlayerClip & EmoteX64ClipPlayerAccess;
  }

  private get x64Controls(): EmoteX64ControlSet {
    return this.controls as EmoteX64ControlSet;
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
    this.inverseScale = f32(1 / (this.x64 ? f32(this.modelScale * s) : this.modelScale * s));

    // 0x100193d0 runs before the selector loader 0x10019a50, which resolves its options'
    // transitions by label, so the transition tweens exist before the controls are built.
    const expressions =
      !this.x64 || !!(md.eyeControl.length || md.eyebrowControl.length || md.mouthControl.length);
    const transitionIndex: number[] = [];
    (expressions ? md.transitionControl : []).forEach((entry, index) => {
      if (!entry.enabled) return;
      transitionIndex.push(index);
      this.transitions.push({label: entry.label, tween: new EmoteTween(1, this.driverSha256)});
    });
    this.controls = this.createControls(expressions ? md : {...md, selectorControl: []}, {
      ...(this.x64 ? {driverSha256: this.driverSha256, random: this.random} : {}),
      transition: (label) => this.transitions.find((t) => t.label === label)?.tween ?? null,
    });
    const bind =
      (type: EmoteControlVariableType | 0 | 1 | 2 | 7 | 9) => (label: string, index: number) => {
        if (!this.bindings.has(label)) this.bindings.set(label, {type, index});
      };
    if (this.x64) {
      const physics = (list: typeof md.bustControl | typeof md.hairControl, type: 0 | 1 | 2) => {
        let index = 0;
        for (const c of list) {
          if (!c.enabled) continue;
          bind(type)(c.var_lr, index);
          bind(type)(c.var_ud, index);
          if ('var_lrm' in c) bind(type)(c.var_lrm, index);
          index++;
        }
      };
      physics(md.bustControl, 0);
      physics(md.hairControl, 1);
      physics(md.partsControl, 2);
    }
    this.controls.bindVariables(4, bind(4));
    this.controls.bindVariables(5, bind(5));
    this.controls.bindVariables(6, bind(6));
    // The binding index is the position in the PSB list.
    this.transitions.forEach((t, i) => bind(7)(t.label, transitionIndex[i]!));
    this.controls.bindVariables(8, bind(8));
    if (this.x64 && expressions) for (const label of md.immediateControl ?? []) bind(9)(label, 0);
    // 0x1001b8c0.
    for (const c of md.clampControl) {
      if (!c.enabled) continue;
      this.clamps.push({
        kernel: new EmoteVariableClamp(c, this.driverSha256),
        varLr: c.var_lr,
        varUd: c.var_ud,
      });
    }
    this.mirrorMatch = md.mirrorControl.variableMatchList;
    if (!this.x64 || md.clampControl.length)
      for (const label of md.instantVariableList ?? []) this.instant.add(label);
    this.timelines.loadList(md.timelineControl);
    // `variableList`: frames of a repeated label are inserted before the existing ones.
    for (const v of md.variableList ?? []) {
      const frames = v.frames.map((fr) => ({label: fr.label, frame: f32(fr.frame)}));
      if (this.x64) {
        this.variableList.push({label: v.label, frames});
        this.variableLabels.add(v.label);
        continue;
      }
      const i = this.variableList.findIndex((e) => e.label === v.label);
      if (i >= 0) {
        const e = this.variableList[i]!;
        this.variableList[i] = {label: e.label, frames: [...frames, ...e.frames]};
      } else {
        this.variableList.push({label: v.label, frames});
      }
    }
    if (this.x64)
      for (const orbit of md.orbitControl ?? [])
        if (orbit.enabled) this.orbits.push(new EmoteOrbit(orbit, this.driverSha256));
    if (this.x64 && md.stereovisionControl) {
      const rangeOf = this.x64Clip.getVariableRange;
      if (!rangeOf && md.stereovisionControl.variableMatchList.length)
        throw Error('emotedriver: x64 clip missing getVariableRange');
      for (const label of md.stereovisionControl.variableMatchList) {
        const range = rangeOf!.call(this.mainClip, label);
        if (!range) continue;
        if (!this.stereoVariables.has(label))
          this.stereoVariables.set(label, {
            range,
            coefficients: new Float32Array(this.stereovision.screenCount * 2),
          });
        this.setVariable(label, 0, 0, 0);
      }
      this.updateStereoCoefficients();
    }
  }

  private updateStereoCoefficients(): void {
    const state = this.stereovision;
    for (const {range, coefficients} of this.stereoVariables.values())
      emoteStereovisionCoefficients(
        range[0],
        range[1],
        state.volume,
        state.parallaxRatio,
        state.screenCount,
        coefficients,
      );
  }

  /** Native 0x18000d3f0: synchronize ownership only on an eligible progress call. */
  private updateStereoClips(): void {
    if (!this.stereovision.enabled) {
      if (this.clips.length === 2) this.clips.splice(1, 1);
    } else if (this.clips.length === 1 && this.stereoVariables.size) {
      const copy = this.createClip(this.motion);
      if (copy === this.mainClip)
        throw Error('emotedriver: clip factory did not create an independent stereo clip');
      copy.assignState(this.mainClip);
      this.clips.push(copy);
    }
    if (this.stereovision.enabled && this.stereovision.dirty) {
      this.updateStereoCoefficients();
      this.stereovision.dirty = false;
    }
  }

  /** Native 0x18000f9f0: mirrored mapped variables swap screen order after sign handling. */
  private applyClipVariable(label: string, value: number): void {
    if (!this.x64 || !this.stereovision.enabled) {
      this.mainClip.applyVariable(label, value);
      return;
    }
    const variable = this.stereoVariables.get(label);
    if (!variable) {
      for (const clip of this.clips) clip.applyVariable(label, value);
      return;
    }
    const count = this.stereovision.screenCount;
    for (let screen = 0; screen < count; screen++) {
      const index = this.mirror ? count - screen - 1 : screen;
      this.clips[index]!.applyVariable(
        label,
        f32(
          f32(value * variable.coefficients[screen * 2]!) + variable.coefficients[screen * 2 + 1]!,
        ),
      );
    }
  }

  /** Native render slot72 clamps the uint32 screen index to the last owned clip. */
  get renderClip(): EmotePlayerClip {
    return this.clips[Math.min(this.currentClip >>> 0, this.clips.length - 1)]!;
  }

  setStereovisionEnabled(enabled: boolean): void {
    this.requireX64();
    this.stereovision.enabled = enabled;
  }
  getStereovisionEnabled(): boolean {
    this.requireX64();
    return this.stereovision.enabled;
  }
  setStereovisionVolume(volume: number): void {
    this.requireX64();
    volume = f32(volume);
    if (volume !== this.stereovision.volume) {
      this.stereovision.volume = volume;
      this.stereovision.dirty = true;
    }
  }
  getStereovisionVolume(): number {
    this.requireX64();
    return this.stereovision.volume;
  }
  setStereovisionParallaxRatio(ratio: number): void {
    this.requireX64();
    ratio = f32(ratio);
    if (ratio !== this.stereovision.parallaxRatio) {
      this.stereovision.parallaxRatio = ratio;
      this.stereovision.dirty = true;
    }
  }
  getStereovisionParallaxRatio(): number {
    this.requireX64();
    return this.stereovision.parallaxRatio;
  }
  setStereovisionRenderScreen(screen: number): void {
    this.requireX64();
    this.currentClip = screen | 0;
  }
  getStereovisionRenderScreen(): number {
    this.requireX64();
    return this.currentClip;
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
        if ((this.x64 ? compareEmoteUtf8 : compareKeys)(this.cellOrder[mid]!, label) < 0)
          lo = mid + 1;
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
    try {
      if (this.apiLog?.enter()) this.apiLog.record('SetVariable', [label, value, frames, easing]);
      this.forceStep = true;
      const power = easingPower(easing, this.driverSha256);
      const binding = this.bindings.get(label);
      if (!binding || binding.type === 9) {
        this.cell(label).value = f32(value);
        return;
      }
      if (binding.type === 7) {
        this.transitions[binding.index]?.tween.set([f32(value)], f32(frames), power, this.queuing);
        return;
      }
      if (binding.type === 0 || binding.type === 1 || binding.type === 2) return;
      this.controls.setVariable(
        binding.type,
        binding.index,
        label,
        f32(value),
        f32(frames),
        power,
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
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
    for (const label of this.cellOrder) {
      let v = this.timelines.blended(label, this.cells.get(label)!.value);
      if (this.x64) {
        const difference = this.diffSums.get(label);
        if (difference !== undefined) v = f32(v + difference);
      }
      if (this.mirrorSign(label)) v = -v;
      this.applyClipVariable(label, v);
    }
    this.applyClamps();
  }

  /** 0x1001bff0: `clampControl` limits a two-variable pair to a disc (type 1) or eases it (0). */
  private applyClamps(): void {
    for (const c of this.clamps) {
      let lr = this.timelines.blended(c.varLr, this.cells.get(c.varLr)?.value ?? 0);
      let ud = this.timelines.blended(c.varUd, this.cells.get(c.varUd)?.value ?? 0);
      if (this.x64) {
        const dlr = this.diffSums.get(c.varLr),
          dud = this.diffSums.get(c.varUd);
        if (dlr !== undefined) lr = f32(lr + dlr);
        if (dud !== undefined) ud = f32(ud + dud);
      }
      const values = c.kernel.apply(lr, ud);
      lr = values[0]!;
      ud = values[1]!;
      if (this.mirrorSign(c.varLr)) lr = -lr;
      this.applyClipVariable(c.varLr, lr);
      this.applyClipVariable(c.varUd, ud);
    }
  }

  // -------------------------------------------------------------------------------------
  // Progress

  /** 0x10011f80 (slot 54). */
  progress(frames: number): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('CalcLayerFrameInfo', [frames]);
      frames = this.apiLog?.replay(this, frames) ?? frames;
      const total = f32(f32(frames) + this.pendingFrames);
      this.queuePhase = ((this.queuePhase + 1) >>> 0) % this.queueDivisor;
      if (this.queuePhase !== this.queueSlot) {
        this.pendingFrames = total;
        return;
      }
      this.pendingFrames = 0;
      if (this.x64) this.updateStereoClips();
      if (this.x64) {
        for (const orbit of this.orbits) {
          const call = orbit.step(total);
          if (call) this.setVariable(orbit.label, call.value, call.frames, 0);
        }
      }
      this.timelines.advance(total);
      if (this.x64) {
        this.diffSums.clear();
        for (const d of this.diffs)
          this.diffSums.set(
            d.label,
            f32((this.diffSums.get(d.label) ?? 0) + d.tween.step(total)[0]!),
          );
      }
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
        if (!this.x64) this.controls.stepLoops(host, step);
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
      if (total !== 0) {
        if (this.x64) {
          this.forceTweens.forEach((t, i) => {
            const values = t.step(total),
              sum = this.forceSums[i]!;
            sum[0] = f32(f32(values[0]! * total) + sum[0]!);
            sum[1] = f32(f32(values[1]! * total) + sum[1]!);
          });
          this.outerRotateTween.step(total);
          const forces = this.outerForces,
            sums = this.forceSums;
          forces.bust.x = sums[0][0]!;
          forces.bust.y = sums[0][1]!;
          forces.hair.x = sums[1][0]!;
          forces.hair.y = sums[1][1]!;
          forces.parts.x = sums[2][0]!;
          forces.parts.y = sums[2][1]!;
        }
        this.controls.stepPhysics(host, total);
      }
    } finally {
      this.apiLog?.leave();
    }
  }

  /** 0x100199c0: transition tweens write their variables. */
  private stepTransitions(frames: number): void {
    for (const t of this.transitions) this.cell(t.label).value = t.tween.step(frames)[0]!;
  }

  /** 0x1001b5f0: coord, colour, scale and rotation tweens → every clip. */
  private stepTransforms(frames: number): void {
    if (this.x64) {
      this.stepX64Transforms(frames);
      return;
    }
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

  /** x64 0x180019240: float stores, original scale, coordinate flags and grayscale. */
  private stepX64Transforms(frames: number): void {
    const coord = this.coordTween.step(frames),
      color = this.colorTween.step(frames);
    let scale = this.scaleTween.step(frames)[0]!;
    if (this.asOriginalScale) scale = f32(scale / this.modelScale);
    this.inverseScale = f32(1 / f32(this.modelScale * scale));
    const rad = this.rotateTween.step(frames);
    this.root.x = this.flags & 2 ? f32(coord[0]! * scale) : coord[0]!;
    this.root.y = this.flags & 2 ? f32(coord[1]! * scale) : coord[1]!;
    this.root.scale = scale;
    const channel = (i: number) => Math.trunc(color[i]!) | 0;
    const packed =
      ((((((channel(3) << 8) | channel(2)) << 8) | channel(1)) << 8) | channel(0)) >>> 0;
    const degrees = f32(f32(rad * 360) / EMOTE_TWO_PI);
    for (const clip of this.clips) {
      clip.color = packed;
      const access = clip as EmotePlayerClip & EmoteX64ClipPlayerAccess;
      if (access.ownRotation)
        access.setOwnRotation(Number.isFinite(degrees) ? wrapAngle(degrees, 360) : degrees);
    }
    if (!this.x64Clip.ownRotation) this.root.angle = degrees;
    this.writeRoot();
    const gray = this.grayscaleTween.step(frames)[0]!;
    const value = gray <= 1 ? gray : 1;
    for (const clip of this.clips) {
      const access = clip as EmotePlayerClip & EmoteX64ClipPlayerAccess;
      access.rootDirty = true;
      access.setGrayscale(value > 0 ? 5 : 0, Math.trunc(f32(value * 255)));
    }
  }

  /** Root node +0x283 (mirror) and +0x288..+0x29c; the clip sets its dirty flag on change. */
  private writeRoot(): void {
    const r = this.root,
      input = this.rootTransformInput;
    for (const clip of this.clips) {
      input.x = r.x;
      input.y = r.y;
      input.angle = r.angle;
      input.scaleX = r.scale;
      input.scaleY = r.scale;
      input.mirror = this.mirror;
      clip.setRootTransform(input);
    }
  }

  // -------------------------------------------------------------------------------------
  // Transform setters (0x1001b3a0, 0x1001b420, 0x1001b4a0, 0x1001b510)

  setCoord(x: number, y: number, frames: number, easing: number): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('SetCoord', [x, y, frames, easing]);
      this.forceStep = true;
      this.coordTween.set(
        [f32(x), f32(y)],
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
  }

  setScale(scale: number, frames: number, easing: number): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('SetScale', [scale, frames, easing]);
      this.forceStep = true;
      this.scaleTween.set(
        [f32(scale)],
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
  }

  /** Radians. */
  setRot(rot: number, frames: number, easing: number): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('SetRot', [rot, frames, easing]);
      this.forceStep = true;
      this.rotateTween.set(
        f32(rot),
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
  }

  setColor(argb: number, frames: number, easing: number): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('SetColor', [argb, frames, easing]);
      const v = argb >>> 0;
      this.forceStep = true;
      this.colorTween.set(
        [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24],
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
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
    return this.x64 ? this.clipAngle() : f32((this.root.angle * EMOTE_TWO_PI) / 360);
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
    try {
      if (this.apiLog?.enter()) this.apiLog.record('Skip', []);
      this.timelines.skip();
      this.settle();
    } finally {
      this.apiLog?.leave();
    }
  }

  /** x64 0x18000e210: skip loop timelines while marking them stepped. */
  step(): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('Step', []);
      this.requireX64();
      this.timelines.step();
      this.settle();
    } finally {
      this.apiLog?.leave();
    }
  }

  private settle(): void {
    if (this.x64) {
      for (const tween of this.forceTweens) tween.skip();
      for (const sum of this.forceSums) sum.fill(0);
      for (const force of [this.outerForces.bust, this.outerForces.hair, this.outerForces.parts]) {
        force.x = 0;
        force.y = 0;
      }
      this.outerRotateTween.skip();
    }
    this.controls?.skip(this.x64 ? this.host : undefined);
    for (const t of this.transitions) t.tween.skip();
    this.coordTween.skip();
    this.scaleTween.skip();
    this.rotateTween.skip();
    this.colorTween.skip();
    if (this.x64) for (const d of this.diffs) d.tween.skip();
  }

  /** 0x1001f180 (slot 53). */
  pass(): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('Pass', []);
      this.timelines.pass();
    } finally {
      this.apiLog?.leave();
    }
  }

  /** 0x100108f0 (slot 51). The colour tween is not checked. */
  isAnimating(): boolean {
    if (
      this.coordTween.busy ||
      this.scaleTween.busy ||
      this.rotateTween.busy ||
      (this.x64 && this.outerRotateTween.busy)
    )
      return true;
    const labels = new Set<string>();
    if (this.timelines.animating(labels)) return true;
    for (const t of this.transitions) if (t.tween.busy && !labels.has(t.label)) return true;
    return this.controls.isAnimating(labels);
  }

  /** 0x10010850 (slot 4). */
  show(): void {
    for (const clip of this.clips) clip.rootVisible = true;
    if (this.x64) this.x64Clip.rootDirty = true;
  }

  /** 0x100108a0 (slot 5). */
  hide(): void {
    for (const clip of this.clips) clip.rootVisible = false;
    if (this.x64) this.x64Clip.rootDirty = true;
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

  // x64 player API and host operations (0x18000e980..0x18001b020).

  private requireX64(): void {
    if (!this.x64) throw Error(`emotedriver: API unavailable for DLL build ${this.driverSha256}`);
  }

  /**
   * x64 public GetState, 0x180002b80. Labels are case-sensitive narrow C strings.
   * The native color-byte branches repeat colorG/colorR, making the blue/alpha
   * branches unreachable; unknown names (including colorB/colorA) return zero.
   */
  getState(label: string): number {
    this.requireX64();
    const end = label.indexOf('\0');
    if (end !== -1) label = label.slice(0, end);
    switch (label) {
      case 'coordX':
        return this.getCoord().x;
      case 'coordY':
        return this.getCoord().y;
      case 'scale':
        return this.getScale();
      case 'rot':
        return this.getRot();
      case 'colorR':
        return this.getColor() >>> 24;
      case 'colorG':
        return (this.getColor() >>> 16) & 255;
      default:
        return 0;
    }
  }

  addUserDefinedVariable(label: string): void {
    this.requireX64();
    if (this.bindings.has(label) || this.variableLabels.has(label)) return;
    this.bindings.set(label, {type: 7, index: this.transitions.length});
    this.transitions.push({label, enabled: true, tween: new EmoteTween(1, this.driverSha256)});
  }

  setVariableDiff(module: string, label: string, value: number, frames = 0, easing = 0): void {
    try {
      if (this.apiLog?.enter())
        this.apiLog.record('SetVariableDiff', [module, label, value, frames, easing]);
      this.requireX64();
      let diff = this.diffs.find((d) => d.module === module && d.label === label);
      if (!diff) {
        diff = {module, label, tween: new EmoteTween(1, this.driverSha256)};
        this.diffs.push(diff);
        this.diffs.sort(
          (a, b) => compareEmoteUtf8(a.module, b.module) || compareEmoteUtf8(a.label, b.label),
        );
      }
      this.forceStep = true;
      diff.tween.set(
        [f32(value)],
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
  }

  getVariableDiff(module: string, label: string): number {
    this.requireX64();
    return this.diffs.find((d) => d.module === module && d.label === label)?.tween.current[0] ?? 0;
  }

  setGrayscale(value: number, frames = 0, easing = 0): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('SetGrayscale', [value, frames, easing]);
      this.requireX64();
      this.grayscaleTween.set(
        [f32(value)],
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
  }

  getGrayscale(): number {
    this.requireX64();
    return this.x64Clip.grayscaleMode === 5 ? f32(this.x64Clip.grayscaleLevel / 255) : 0;
  }

  setAsOriginalScale(value: boolean): void {
    this.requireX64();
    this.asOriginalScale = value;
  }
  isAsOriginalScale(): boolean {
    this.requireX64();
    return this.asOriginalScale;
  }

  private forceTween(label: string): EmoteTween | null {
    return label === 'bust'
      ? this.forceTweens[0]
      : label === 'hair'
        ? this.forceTweens[1]
        : label === 'parts'
          ? this.forceTweens[2]
          : null;
  }

  setOuterForce(label: string, x: number, y: number, frames = 0, easing = 0): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('SetOuterForce', [label, x, y, frames, easing]);
      this.requireX64();
      this.forceStep = true;
      this.forceTween(label)?.set(
        [f32(x), f32(y)],
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
  }

  getOuterForce(label: string): [number, number] {
    this.requireX64();
    const tween = this.forceTween(label);
    return tween ? [tween.current[0]!, tween.current[1]!] : [0, 0];
  }

  setOuterRot(value: number, frames = 0, easing = 0): void {
    try {
      if (this.apiLog?.enter()) this.apiLog.record('SetOuterRot', [value, frames, easing]);
      this.requireX64();
      this.forceStep = true;
      this.outerRotateTween.set(
        f32(value),
        f32(frames),
        easingPower(easing, this.driverSha256),
        this.queuing,
      );
    } finally {
      this.apiLog?.leave();
    }
  }
  getOuterRot(): number {
    this.requireX64();
    return this.outerRotateTween.current;
  }

  setMirror(value: boolean): void {
    this.requireX64();
    this.mirror = this.model.metadata.mirror !== value;
  }

  setSmoothing(value: boolean): void {
    this.requireX64();
    this.x64Clip.smoothing = value;
  }
  getSmoothing(): boolean {
    this.requireX64();
    return this.x64Clip.smoothing;
  }

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

  isCharaProfileAvailable(): boolean {
    this.requireX64();
    return this.model.metadata.charaProfile !== null;
  }
  getCharaHeight(): number {
    this.requireX64();
    const value = f32(this.model.metadata.charaProfile?.height ?? 0);
    return this.asOriginalScale ? f32(value / this.modelScale) : value;
  }
  countCharaProfiles(): number {
    this.requireX64();
    return this.model.metadata.charaProfile?.markers.length ?? 0;
  }
  getCharaProfileLabelAt(index: number): string {
    this.requireX64();
    return this.model.metadata.charaProfile?.markers[index]?.label ?? '';
  }
  getCharaProfile(label: string): number {
    this.requireX64();
    const value = f32(
      this.model.metadata.charaProfile?.markers.find((m) => m.label === label)?.value ?? 0,
    );
    return this.asOriginalScale ? f32(value / this.modelScale) : value;
  }
  getSuitableClearColor(): number {
    this.requireX64();
    const color = this.model.metadata.suitableClearColor;
    return color
      ? ((((((color.r & 255) << 8) | (color.g & 255)) << 8) | (color.b & 255)) * 256) >>> 0
      : 0;
  }
  setBlinkEnabled(value: boolean): void {
    this.requireX64();
    this.x64Controls.setBlinkEnabled(value);
  }
  getBlinkEnabled(): boolean {
    this.requireX64();
    return this.x64Controls.getBlinkEnabled();
  }

  startRecordAPILog(): void {
    this.requireX64();
    this.apiLog!.startRecord();
  }
  stopRecordAPILog(): void {
    this.requireX64();
    this.apiLog!.stop();
  }
  isRecordingAPILog(): boolean {
    this.requireX64();
    return this.apiLog!.recording;
  }
  startReplayAPILog(): void {
    this.requireX64();
    this.apiLog!.startReplay();
  }
  stopReplayAPILog(): void {
    this.requireX64();
    this.apiLog!.stop();
  }
  isReplayingAPILog(): boolean {
    this.requireX64();
    return this.apiLog!.replaying;
  }
  clearAPILog(): void {
    this.requireX64();
    this.apiLog!.clear();
  }
  getAPILog(): string {
    this.requireX64();
    return this.apiLog!.get();
  }
  setAPILog(log: string): void {
    this.requireX64();
    this.apiLog!.set(log);
  }

  /** X64 0x18000e6d0; no concrete clip or physics implementation is assumed. */
  physicsBasePosition(label: string): {readonly x: number; readonly y: number} | null {
    this.requireX64();
    const point = this.x64Clip.layerPosition(label);
    if (!point) return null;
    let {x, y} = point;
    const angle = this.outerRotateTween.current;
    if (f32(2 ** -23) < Math.abs(angle)) {
      const sin = f32(Math.sin(angle)),
        cos = f32(Math.cos(angle));
      const ox = this.root.x,
        oy = this.root.y,
        dx = f32(x - ox),
        dy = f32(y - oy);
      x = f32(f32(f32(dx * cos) - f32(dy * sin)) + ox);
      y = f32(f32(f32(dy * cos) + f32(dx * sin)) + oy);
    }
    if (this.flags & 0x200) {
      x = f32(x * this.inverseScale);
      y = f32(y * this.inverseScale);
    }
    if (this.flags & 0x100) {
      x = f32(f32(f32(x - this.root.x) * this.inverseScale) + this.root.x);
      y = f32(f32(f32(y - this.root.y) * this.inverseScale) + this.root.y);
    }
    return {x, y};
  }

  private clipAngle(): number {
    const degrees = this.x64Clip.ownRotation ? this.x64Clip.ownRotationAngle : this.root.angle;
    return f32(f32(degrees * EMOTE_TWO_PI) / 360);
  }
  get physicsAngle(): number {
    this.requireX64();
    return f32(this.clipAngle() + this.outerRotateTween.current);
  }

  // -------------------------------------------------------------------------------------
  // AssignState (0x1000f2a0 / 0x180009df0)

  assignState(source: EmotePlayerCore): void {
    if (source.driverSha256 !== this.driverSha256)
      throw Error('emotedriver: player DLL build mismatch');
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
    if (this.x64) {
      Object.assign(this.stereovision, source.stereovision, {dirty: true});
      // Native std::map assignment replaces the raw variable map. Metadata,
      // bindings, flags, applied transforms and force accumulators stay local.
      this.cells.clear();
      for (const [label, cell] of source.cells) this.cells.set(label, {...cell});
      this.cellOrder = [...source.cellOrder];
      this.orbits.length = 0;
      for (const orbit of source.orbits) this.orbits.push(orbit.clone());
    }
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
    if (this.x64) {
      this.grayscaleTween.copyFrom(source.grayscaleTween);
      this.forceTweens.forEach((tween, i) => tween.copyFrom(source.forceTweens[i]!));
      this.outerRotateTween.copyFrom(source.outerRotateTween);
    }
    this.controls.assignState(source.controls);
    for (const from of source.transitions) {
      const to = this.transitions.find((t) => t.label === from.label);
      to?.tween.copyFrom(from.tween);
    }
    this.timelines.assignFrom(source.timelines);
    if (this.x64) {
      // Native emplace at the end of 0x180009df0 keeps an existing module/label entry;
      // neither overwrite existing differences nor erase destination-only ones.
      for (const from of source.diffs) {
        if (this.diffs.some((to) => to.module === from.module && to.label === from.label)) continue;
        const tween = new EmoteTween(1, this.driverSha256);
        tween.copyFrom(from.tween);
        this.diffs.push({module: from.module, label: from.label, tween});
      }
      this.diffs.sort(
        (a, b) => compareEmoteUtf8(a.module, b.module) || compareEmoteUtf8(a.label, b.label),
      );
    }
  }
}
