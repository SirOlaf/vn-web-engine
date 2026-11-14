import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisModes} from './modes.js';
import type {ArtemisSave} from './save.js';

export interface ArtemisTimedWaitHost {
  now(): number;
  debugSkipActive(): boolean;
  /** Current text layer (stage +0xa0) virtual +0x1c8(vector, 1): the skip vector +0x3718
   * when `skip`, otherwise the current message layer's `in` vector (+0x3730 map). */
  startTextDisplay(skip: boolean): void;
  /** Text layer +0x1e0: no display tween is registered any more. */
  textDisplayComplete(): boolean;
  /** Text layer +0x1d0: finish every display tween. */
  finishTextDisplay(): void;
  /** `s.clickskip = 1`. */
  writeClickSkip(): void;
  beginWait(inputEnabled: boolean): void;
  endWait(): void;
  clickWaitEvent(kind: 'in' | 'out'): void;
  /** 0x1400b6cf0 (click glyph release) after native state 0 clears wait flags. */
  resumeMessageState(): void;
  /** Root layer lookup +0x140 cast to a video layer (0x1400f53d0), then its +0x208:
   * false when the layer is missing, is not a video layer or has finished playing. */
  videoPlaying?(id: string): boolean;
  /** Script se map +0x3d88: the sound index registered by seplay for `id`. */
  effectIndex?(id: string): number | undefined;
  /** 0x1400adcf0: the sound manager's player state for `index` is nonzero (a missing
   * player is 0). The modeled players have one nonzero state, playing (1). */
  effectPlaying?(index: number): boolean;
  /** CSoundPlayer virtual +0x38: uint32 playback-start tick, zero when stopped/missing. */
  effectStartTick?(index: number): number;
  /** `s.automodewait` through the variable integer getter (virtual +0x10). */
  automodeWait?(): number;
  /** 0x1400b6820 click glyph placement. */
  placeClickGlyph?(): void;
}
function integer(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis wait integer');
  return number;
}

/** Saved wait flags of a caller caret. */
export interface ArtemisWaitFlags {
  readonly inputEnabled: boolean;
  readonly deadline: number;
  readonly scenario: boolean;
  readonly click: boolean;
  readonly video: string | null;
  readonly sound: {readonly id: string; readonly index: number} | null;
}
/** wait tag 0x1400cc0c0, click-wait tag `@` 0x1400cbf20, run-mode entry 0x1400c6160
 * (1 with input=1 or `@`, else 4) and the run mode 1/3/4 frame branch of 0x1400c0560.
 *
 * `time` (flag b98) ends once the absolute uint32 deadline b94 has passed; `scenario=1`
 * (flag b99) ends once the current text display has completed. `@` sets no wait flag and
 * ends only on a click. All of them start the text display first. In run mode 1 a click
 * on a complete display ends the wait (writing `s.clickskip` when a wait flag is set); a
 * click on an incomplete display finishes it and writes `s.clickskip`. `video=<id>` (flag
 * bc4, id bc8) starts no text display and ends once layer `id` is no longer a playing
 * video. `se=<id>` (flag b9b, index bc0) looks the id up in the seplay map; an unknown id
 * sets no wait, otherwise the wait starts no text display and ends once the sound
 * manager reports that index stopped (0x1400adcf0).
 *
 * Skip and automode change no wait setup except the display vector; they act in the run
 * mode 1 frame. An active skip (0x1400b5170) is a click every frame. In automode a
 * flagless wait (`@`) whose display has completed gets the deadline b94 =
 * `s.automodewait` + now; when it passes, the wait ends unless an id of the syncse list
 * names a playing se. Turning automode off clears the deadline of a flagless wait.
 * `se` with `time` sets a time-only deadline relative to the player's start tick;
 * a zero start tick returns without waiting. `scenario=2` and the debug-skip frame branch need owners that are not
 * implemented. */
export class ArtemisTimedWait {
  private active = false;
  private inputEnabled = false;
  private deadline = 0;
  private scenario = false;
  /** `@`: no wait flag is set. */
  private click = false;
  /** bc4/bc8: the layer id of a `video=` wait. */
  private video: string | null = null;
  /** b9b/ba0/bc0: the se id and sound index of an `se=` wait. */
  private sound: {readonly id: string; readonly index: number} | null = null;
  constructor(
    private readonly modes: ArtemisModes,
    private readonly save: ArtemisSave,
    private readonly host: ArtemisTimedWaitHost,
  ) {}
  get pending(): boolean {
    return this.active;
  }
  /** A `scenario=1` wait is pending (flag b99). */
  get scenarioPending(): boolean {
    return this.active && this.scenario;
  }
  /** An `se=` wait is pending (flag b9b). */
  get soundPending(): boolean {
    return this.active && this.sound !== null;
  }
  /** A `video=` wait is pending (flag bc4). */
  get videoPending(): boolean {
    return this.active && this.video !== null;
  }
  /** An `@` click-wait is pending. */
  get clickPending(): boolean {
    return this.active && this.click;
  }
  get deadlineTick(): number {
    return this.deadline;
  }
  /** Wait flags read by Lua `getScriptWaitReason` (0x1401315b0): `time` is b98 with the
   * uint32 deadline b94; `textTween` is b99; `sound` is b9b with the se id ba0; `video`
   * is bc4 with the id bc8. textClearTween (b9a) belongs to the unimplemented scenario=2
   * wait and is never set here. */
  get reason(): {
    readonly time?: number;
    readonly textTween?: true;
    readonly sound?: string;
    readonly video?: string;
  } {
    if (!this.active || this.click) return {};
    if (this.sound !== null) return {sound: this.sound.id};
    if (this.video !== null) return {video: this.video};
    return this.scenario ? {textTween: true} : {time: this.deadline};
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name === '@') {
      this.clickWait();
      return true;
    }
    if (tag.name !== 'wait') return false;
    const p = tag.args;
    const input = integer(p.get('input') ?? '0');
    const skipping = this.modes.skipAllowed && (this.modes.commandSkip || this.modes.controlSkip);
    const debugSkip = this.host.debugSkipActive();
    // Native input=2 bypasses all wait setup while skip/debug-skip is active.
    if (input === 2 && (skipping || debugSkip)) return true;
    if (this.active) throw new Error('Artemis timed wait is already pending');
    let sound: {id: string; index: number} | null = null;
    let soundDeadline: number | undefined;
    if (p.has('se')) {
      if (!this.host.effectIndex || !this.host.effectPlaying)
        throw new Error('Unsupported Artemis se wait owner');
      const id = p.get('se')!,
        index = this.host.effectIndex(id);
      // An se id seplay never registered sets no wait and leaves the run mode alone.
      if (index === undefined) return true;
      if (p.has('time')) {
        if (!this.host.effectStartTick) throw new Error('Unsupported Artemis timed se wait owner');
        const start = this.host.effectStartTick(index) >>> 0;
        if (start === 0) return true;
        soundDeadline = (start + integer(p.get('time')!)) >>> 0;
      } else sound = {id, index};
    }
    const hasSound = sound !== null || soundDeadline !== undefined;
    const video = hasSound ? undefined : p.get('video');
    const scenario = video === undefined && !hasSound ? integer(p.get('scenario') ?? '0') : 0;
    if (scenario === 2) throw new Error('Artemis scenario=2 waits are not implemented');
    if (video !== undefined && !this.host.videoPlaying)
      throw new Error('Unsupported Artemis video wait owner');
    this.scenario = scenario === 1;
    this.click = false;
    this.deadline = soundDeadline ?? 0;
    this.video = video ?? null;
    this.sound = sound;
    // The se and video branches start no text display.
    if (this.scenario) this.host.startTextDisplay(false);
    else if (video === undefined && !hasSound) {
      this.deadline = (integer(p.get('time') ?? '0') + this.host.now()) >>> 0;
      this.host.startTextDisplay(skipping || debugSkip);
    }
    this.inputEnabled = input === 1;
    this.active = true;
    this.host.beginWait(this.inputEnabled);
    if (this.inputEnabled) {
      this.host.clickWaitEvent('in');
      if (!skipping && !debugSkip)
        this.save.request(this.modes.autosave === 2 ? 'autosave.dat' : '');
    }
    return true;
  }
  /** 0x1400cbf20: display start with the skip vector while skipping or debug-skipping,
   * then the open-coded run mode 1 entry (c74 = c70, c70 = 1, onClickWaitIn, save gate). */
  private clickWait(): void {
    if (this.active) throw new Error('Artemis timed wait is already pending');
    const skip =
      (this.modes.skipAllowed && (this.modes.commandSkip || this.modes.controlSkip)) ||
      this.host.debugSkipActive();
    this.host.startTextDisplay(skip);
    this.scenario = false;
    this.click = true;
    this.deadline = 0;
    this.inputEnabled = true;
    this.active = true;
    this.host.beginWait(true);
    this.host.clickWaitEvent('in');
    if (!skip) this.save.request(this.modes.autosave === 2 ? 'autosave.dat' : '');
  }
  /** One frame of 0x1400c0560 for this wait. `inputFrame` is run mode 1, where `clicked`
   * is the click query (b5690 role 0, or an active skip b5170); other run modes ignore
   * both. Native compares absolute uint32 deadlines strictly; zero is the disabled
   * sentinel. */
  tick(now: number, clicked = false, inputFrame = clicked): boolean {
    if (!this.active) return false;
    if (this.host.debugSkipActive())
      throw Error('Artemis debug-skip wait frame is not implemented');
    if (inputFrame && this.inputEnabled) {
      if (clicked) {
        if (this.host.textDisplayComplete()) {
          // b98/b99 mark s.clickskip; `@` sets no wait flag.
          if (!this.click) this.host.writeClickSkip();
          this.end();
          return true;
        }
        this.host.finishTextDisplay();
        this.host.writeClickSkip();
      }
      if (this.click && this.deadline === 0 && this.modes.automode) {
        if (this.host.textDisplayComplete()) {
          if (!this.host.automodeWait || !this.host.placeClickGlyph)
            throw Error('Unsupported Artemis automode wait owner');
          this.host.placeClickGlyph();
          this.deadline = (this.host.automodeWait() + (now >>> 0)) >>> 0;
        }
      }
    }
    if (this.deadline && this.deadline < now >>> 0 && !this.syncSeHeld()) {
      this.end();
      return true;
    }
    if (this.scenario && this.host.textDisplayComplete()) {
      this.end();
      return true;
    }
    if (this.sound !== null) {
      if (this.host.effectPlaying!(this.sound.index)) return false;
      this.end();
      return true;
    }
    if (this.video !== null && !this.host.videoPlaying!(this.video)) {
      this.end();
      return true;
    }
    return false;
  }
  /** In automode, an id of the syncse list registered by seplay whose player state is
   * playing holds a passed deadline. */
  private syncSeHeld(): boolean {
    if (!this.modes.automode) return false;
    return this.modes.syncSe.some((id) => {
      if (!this.host.effectIndex || !this.host.effectPlaying)
        throw Error('Unsupported Artemis syncse owner');
      const index = this.host.effectIndex(id);
      return index !== undefined && this.host.effectPlaying(index);
    });
  }
  /** A b94 write by a run mode owner other than the wait tags (`trans type="0"`): a wait
   * without flags or input whose frame branch ends it once the deadline has passed. The
   * owner has already entered the run mode. */
  setDeadline(ms: number): void {
    if (this.active) throw new Error('Artemis timed wait is already pending');
    this.clear();
    this.deadline = ms >>> 0;
    this.active = true;
  }
  /** b7810 turning automode off: a wait without flags (`@`, or none) loses its deadline. */
  clearAutomodeDeadline(): void {
    if (!this.active || this.click) this.deadline = 0;
  }
  /** The wait flags of the current caret, cleared for a new caret (call, event handler
   * scope, jump); undefined when no wait is pending. */
  take(): ArtemisWaitFlags | undefined {
    const flags = this.active
      ? {
          inputEnabled: this.inputEnabled,
          deadline: this.deadline,
          scenario: this.scenario,
          click: this.click,
          video: this.video,
          sound: this.sound,
        }
      : undefined;
    this.clear();
    return flags;
  }
  /** Reinstates the wait flags of a returning caret (c6580). */
  restore(flags: ArtemisWaitFlags | undefined): void {
    this.clear();
    if (!flags) return;
    ({
      inputEnabled: this.inputEnabled,
      deadline: this.deadline,
      scenario: this.scenario,
      click: this.click,
      video: this.video,
      sound: this.sound,
    } = flags);
    this.active = true;
  }
  /** bf210 empties the caret (script+0xb68), whose fields b94..bc8 are these wait flags.
   * No scheduler release, Out event or message update runs; reset performs its own. */
  clear(): void {
    this.inputEnabled = false;
    this.deadline = 0;
    this.scenario = false;
    this.click = false;
    this.video = null;
    this.sound = null;
    this.active = false;
  }
  /** c6160(0): scheduler release precedes Out, then wait flags/message update. */
  private end(): void {
    this.host.endWait();
    if (this.inputEnabled) this.host.clickWaitEvent('out');
    this.deadline = 0;
    this.scenario = false;
    this.click = false;
    this.video = null;
    this.sound = null;
    this.active = false;
    this.host.resumeMessageState();
  }
}
