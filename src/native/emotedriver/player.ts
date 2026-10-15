import type {IEmotePlayer} from './contract.js';
import type {EmotePlayerCore} from './runtime/player-core.js';

/**
 * `PEmotePlayer` (vtable 0x1007174c, 0x24 bytes): the exported player. Slots 0–55 delegate
 * to the player core (`MEmotePlayer`, `PEmotePlayer+0x10`); slot 56 draws through the
 * renderer the device supplies. Addresses refer to `emotedriver.dll` SHA-256
 * `a3b693b6…5e70b3a86`.
 */

/** Draws a player (slot 56, 0x10002b30). Supplied by the device. */
export interface EmotePlayerRenderer {
  render(player: PEmotePlayer): void;
}

/**
 * Renderer state shared by a player and its clones (`AMotionRenderer`, `PEmotePlayer+0xc`,
 * reference counted at +0x9c).
 */
export interface EmotePlayerRendererState {
  /** Renderer +0x98 (slots 7/8); 1 after construction (0x10058570). */
  smoothing: boolean;
}

const f32 = Math.fround;

export class PEmotePlayer implements IEmotePlayer {
  /** +0x4. */
  private refCount = 1;
  private destroyed = false;

  constructor(
    readonly core: EmotePlayerCore,
    readonly renderer: EmotePlayerRenderer,
    readonly rendererState: EmotePlayerRendererState = {smoothing: true},
    /** Called when the reference count reaches zero (slot 57). */
    private readonly onDestroy?: (player: PEmotePlayer) => void,
  ) {}

  /** Slot 0 (0x10001d90). */
  addRef(): number {
    return ++this.refCount;
  }

  /** Slot 1 (0x10001da0); slot 57 at zero. */
  release(): number {
    const n = --this.refCount;
    if (n === 0 && !this.destroyed) {
      this.destroyed = true;
      this.onDestroy?.(this);
    }
    return n;
  }

  /** Slot 2 (0x10001dc0 → 0x10001bd0): shares the renderer, copies the core (0x1000e000). */
  clone(): IEmotePlayer {
    return new PEmotePlayer(this.core.clone(), this.renderer, this.rendererState, this.onDestroy);
  }

  /** Slot 3 (0x10001e30 → 0x1000f2a0). Only players of this implementation are accepted. */
  assignState(source: IEmotePlayer): void {
    if (!(source instanceof PEmotePlayer)) {
      throw new TypeError('emotedriver: assignState needs a player of this runtime');
    }
    this.core.assignState(source.core);
  }

  show(): void {
    this.core.show();
  }

  hide(): void {
    this.core.hide();
  }

  isHidden(): boolean {
    return this.core.isHidden();
  }

  setSmoothing(enabled: boolean): void {
    this.rendererState.smoothing = enabled;
  }

  getSmoothing(): boolean {
    return this.rendererState.smoothing;
  }

  setMeshDivisionRatio(ratio: number): void {
    this.core.setMeshDivisionRatio(ratio);
  }

  getMeshDivisionRatio(): number {
    return this.core.getMeshDivisionRatio();
  }

  /** Slots 11/12 (0x10001f00/0x10001f10): core `p+0x30`. */
  setQueuing(enabled: boolean): void {
    this.core.queuing = enabled;
  }

  getQueuing(): boolean {
    return this.core.queuing;
  }

  /** Slots 13–18: `p+0x28`, `p+0x2c`, `p+0x24`. */
  setHairScale(scale: number): void {
    this.core.hairScale = f32(scale);
  }

  getHairScale(): number {
    return this.core.hairScale;
  }

  setPartsScale(scale: number): void {
    this.core.partsScale = f32(scale);
  }

  getPartsScale(): number {
    return this.core.partsScale;
  }

  setBustScale(scale: number): void {
    this.core.bustScale = f32(scale);
  }

  getBustScale(): number {
    return this.core.bustScale;
  }

  setCoord(x: number, y: number, frameCount: number, easing: number): void {
    this.core.setCoord(x, y, frameCount, easing);
  }

  getCoord(): {readonly x: number; readonly y: number} {
    return this.core.getCoord();
  }

  setScale(scale: number, frameCount: number, easing: number): void {
    this.core.setScale(scale, frameCount, easing);
  }

  getScale(): number {
    return this.core.getScale();
  }

  setRot(rot: number, frameCount: number, easing: number): void {
    this.core.setRot(rot, frameCount, easing);
  }

  getRot(): number {
    return this.core.getRot();
  }

  setColor(argb: number, frameCount: number, easing: number): void {
    this.core.setColor(argb, frameCount, easing);
  }

  getColor(): number {
    return this.core.getColor();
  }

  countVariables(): number {
    return this.core.countVariables();
  }

  getVariableLabelAt(index: number): string {
    return this.core.getVariableLabelAt(index);
  }

  countVariableFrameAt(index: number): number {
    return this.core.countVariableFrameAt(index);
  }

  getVariableFrameLabelAt(index: number, frame: number): string {
    return this.core.getVariableFrameLabelAt(index, frame);
  }

  getVariableFrameValueAt(index: number, frame: number): number {
    return this.core.getVariableFrameValueAt(index, frame);
  }

  setVariable(label: string, value: number, frameCount: number, easing: number): void {
    this.core.setVariable(label, value, frameCount, easing);
  }

  getVariable(label: string): number {
    return this.core.getVariable(label);
  }

  startWind(start: number, goal: number, speed: number, powerMin: number, powerMax: number): void {
    this.core.startWind(start, goal, speed, powerMin, powerMax);
  }

  stopWind(): void {
    this.core.stopWind();
  }

  /** Slots 36/37 (0x100022d0/0x10002300): `p+0x1a0`. */
  countMainTimelines(): number {
    return this.core.timelines.mainLabels.length;
  }

  getMainTimelineLabelAt(index: number): string {
    return this.core.timelines.mainLabels[index] ?? '';
  }

  /** Slots 38/39: `p+0x1b0`. */
  countDiffTimelines(): number {
    return this.core.timelines.diffLabels.length;
  }

  getDiffTimelineLabelAt(index: number): string {
    return this.core.timelines.diffLabels[index] ?? '';
  }

  /** Slots 40/41 (0x100023f0/0x10002420): `p+0x190`. */
  countPlayingTimelines(): number {
    return this.core.timelines.playing.length;
  }

  getPlayingTimelineLabelAt(index: number): string {
    // Index == count reads past the vector natively.
    return this.core.timelines.playing[index] ?? '';
  }

  /** Slot 42 (0x1001c9d0): play flags | 1, or 0. */
  getPlayingTimelineFlagsAt(index: number): number {
    return this.core.timelines.playingFlagsAt(index);
  }

  isLoopTimeline(label: string): boolean {
    return this.core.timelines.isLoop(label);
  }

  playTimeline(label: string, flags: number): void {
    this.core.timelines.play(label, flags & 0xff);
  }

  isTimelinePlaying(label: string): boolean {
    return this.core.timelines.isPlaying(label);
  }

  stopTimeline(label: string): void {
    this.core.timelines.stop(label);
  }

  setTimelineBlendRatio(
    label: string,
    value: number,
    frameCount: number,
    easing: number,
    stopWhenBlendDone: boolean,
  ): void {
    this.core.timelines.setBlendRatio(label, value, frameCount, easing, stopWhenBlendDone);
  }

  getTimelineBlendRatio(label: string): number {
    return this.core.timelines.getBlendRatio(label);
  }

  /** Slot 49 (0x100028f0). */
  fadeInTimeline(label: string, frameCount: number, easing: number): void {
    const t = this.core.timelines;
    if (!t.isPlaying(label)) {
      t.play(label, 3);
      t.setBlendRatio(label, 0, 0, 0, false);
    }
    t.setBlendRatio(label, 1, frameCount, easing, false);
  }

  /** Slot 50 (0x10002a00). */
  fadeOutTimeline(label: string, frameCount: number, easing: number): void {
    this.core.timelines.setBlendRatio(label, 0, frameCount, easing, true);
  }

  isAnimating(): boolean {
    return this.core.isAnimating();
  }

  skip(): void {
    this.core.skip();
  }

  pass(): void {
    this.core.pass();
  }

  progress(frameCount: number): void {
    this.core.progress(frameCount);
  }

  isModified(): boolean {
    return this.core.isModified();
  }

  /** Slot 56 (0x10002b30). */
  render(): void {
    this.renderer.render(this);
  }
}
