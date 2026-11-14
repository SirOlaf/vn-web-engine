import type {IEmoteD3d11Device, IEmoteD3d11Player} from './contract.js';
import type {EmotePlayerCore} from './runtime/player-core.js';
import type {EmoteX64ClipPlayerAccess} from './runtime/interfaces.js';

/** Private native resource/renderer ownership shared by a player and its clones. */
export interface EmoteD3d11PlayerResources {
  readonly device: IEmoteD3d11Device;
  smoothing: boolean;
  retain(): void;
  release(): void;
  createCore(): EmotePlayerCore;
  draw(core: EmotePlayerCore): void;
}

/** Exact x64 PEmotePlayer (vtable0x180090f50), assembled from the shared native core. */
export class PEmoteD3d11Player implements IEmoteD3d11Player {
  private references = 1;
  private core: EmotePlayerCore | null;

  constructor(
    private readonly resources: EmoteD3d11PlayerResources,
    copy?: EmotePlayerCore,
  ) {
    resources.retain();
    resources.device.addRef();
    try {
      this.core = copy ?? resources.createCore();
    } catch (error) {
      try {
        resources.release();
      } finally {
        resources.device.release();
      }
      throw error;
    }
  }

  private live(): EmotePlayerCore {
    if (this.references <= 0 || !this.core) throw new Error('Using a released E-mote player');
    return this.core;
  }

  /** Slots1..3,0x180001800/1810/1520. */
  addRef(): number {
    this.live();
    return ++this.references;
  }
  release(): number {
    this.live();
    const count = --this.references;
    if (count === 0) {
      this.core = null;
      try {
        this.resources.release();
      } finally {
        this.resources.device.release();
      }
    }
    return count;
  }
  refCount(): number {
    return this.references;
  }

  /** 0x1800026b0: retain shared resource/renderer/files, copy the core. */
  clone(): IEmoteD3d11Player {
    return new PEmoteD3d11Player(this.resources, this.live().clone());
  }
  assignState(source: IEmoteD3d11Player): void {
    if (!(source instanceof PEmoteD3d11Player))
      throw new TypeError('emotedriver: assignState needs a player of this runtime');
    this.live().assignState(source.live());
  }
  /** 0x180002640: preserve the existing resource and construct on its last motion file. */
  initCore(): void {
    this.live();
    this.core = this.resources.createCore();
  }

  /** 0x180002850/28a0: only a changed root visibility marks that clip dirty. */
  show(): void {
    this.visibility(true);
  }
  hide(): void {
    this.visibility(false);
  }
  private visibility(visible: boolean): void {
    for (const clip of this.live().clips)
      if (clip.rootVisible !== visible) {
        clip.rootVisible = visible;
        (clip as typeof clip & EmoteX64ClipPlayerAccess).rootDirty = true;
      }
  }
  /** 0x180002910/2920: resource+0x88, shared across clones, independently of core copying. */
  setSmoothing(enabled: boolean): void {
    this.live();
    this.resources.smoothing = enabled;
  }
  getSmoothing(): boolean {
    this.live();
    return this.resources.smoothing;
  }
  setQueuing(enabled: boolean): void {
    this.live().queuing = enabled;
  }
  getQueuing(): boolean {
    return this.live().queuing;
  }
  setHairScale(scale: number): void {
    this.live().hairScale = Math.fround(scale);
  }
  getHairScale(): number {
    return this.live().hairScale;
  }
  setPartsScale(scale: number): void {
    this.live().partsScale = Math.fround(scale);
  }
  getPartsScale(): number {
    return this.live().partsScale;
  }
  setBustScale(scale: number): void {
    this.live().bustScale = Math.fround(scale);
  }
  getBustScale(): number {
    return this.live().bustScale;
  }
  getOuterForce(label: string): {readonly x: number; readonly y: number} {
    const [x, y] = this.live().getOuterForce(label);
    return {x, y};
  }
  /** 0x180003b00: enqueue and render the selected stereo clip without a progress call. */
  render(): void {
    this.resources.draw(this.live());
  }

  /** Slot8, 0x1800028f0. */
  isHidden(): boolean {
    return this.live().isHidden();
  }

  /** Slot11, 0x180002930. */
  setMeshDivisionRatio(ratio: number): void {
    return this.live().setMeshDivisionRatio(ratio);
  }

  /** Slot12, 0x180002960. */
  getMeshDivisionRatio(): number {
    return this.live().getMeshDivisionRatio();
  }

  /** Slot23, 0x180002a20. */
  setCoord(x: number, y: number, frameCount: number, easing: number): void {
    return this.live().setCoord(x, y, frameCount, easing);
  }

  /** Slot24, 0x180002a30. */
  getCoord(): {readonly x: number; readonly y: number} {
    return this.live().getCoord();
  }

  /** Slot25, 0x180002a60. */
  setScale(scale: number, frameCount: number, easing: number): void {
    return this.live().setScale(scale, frameCount, easing);
  }

  /** Slot26, 0x180002a70. */
  getScale(): number {
    return this.live().getScale();
  }

  /** Slot27, 0x180002a90. */
  setRot(radians: number, frameCount: number, easing: number): void {
    return this.live().setRot(radians, frameCount, easing);
  }

  /** Slot28, 0x180002aa0. */
  getRot(): number {
    return this.live().getRot();
  }

  /** Slot29, 0x180002af0. */
  setColor(color: number, frameCount: number, easing: number): void {
    return this.live().setColor(color, frameCount, easing);
  }

  /** Slot30, 0x180002b00. */
  getColor(): number {
    return this.live().getColor();
  }

  /** Slot31, 0x180002b10. */
  setGrayscale(value: number, frameCount: number, easing: number): void {
    return this.live().setGrayscale(value, frameCount, easing);
  }

  /** Slot32, 0x180002b20. */
  getGrayscale(): number {
    return this.live().getGrayscale();
  }

  /** Slot33, 0x180002b50. */
  setAsOriginalScale(enabled: boolean): void {
    return this.live().setAsOriginalScale(enabled);
  }

  /** Slot34, 0x180002b60. */
  isAsOriginalScale(): boolean {
    return this.live().isAsOriginalScale();
  }

  /** Slot35, 0x180002b80. */
  getState(label: string): number {
    return this.live().getState(label);
  }

  /** Slot36, 0x180002f30. */
  countVariables(): number {
    return this.live().countVariables();
  }

  /** Slot37, 0x180002f40. */
  getVariableLabelAt(index: number): string {
    return this.live().getVariableLabelAt(index);
  }

  /** Slot38, 0x180002f70. */
  countVariableFrameAt(index: number): number {
    return this.live().countVariableFrameAt(index);
  }

  /** Slot39, 0x180002f90. */
  getVariableFrameLabelAt(index: number, frame: number): string {
    return this.live().getVariableFrameLabelAt(index, frame);
  }

  /** Slot40, 0x180002fe0. */
  getVariableFrameValueAt(index: number, frame: number): number {
    return this.live().getVariableFrameValueAt(index, frame);
  }

  /** Slot41, 0x180003020. */
  addUserDefinedVariable(label: string): void {
    return this.live().addUserDefinedVariable(label);
  }

  /** Slot42, 0x1800030e0. */
  setVariable(label: string, value: number, frameCount: number, easing: number): void {
    return this.live().setVariable(label, value, frameCount, easing);
  }

  /** Slot43, 0x1800030f0. */
  getVariable(label: string): number {
    return this.live().getVariable(label);
  }

  /** Slot44, 0x180003100. */
  setVariableDiff(
    module: string,
    label: string,
    value: number,
    frameCount: number,
    easing: number,
  ): void {
    return this.live().setVariableDiff(module, label, value, frameCount, easing);
  }

  /** Slot45, 0x180003110. */
  getVariableDiff(module: string, label: string): number {
    return this.live().getVariableDiff(module, label);
  }

  /** Slot46, 0x180003120. */
  setOuterForce(label: string, x: number, y: number, frameCount: number, easing: number): void {
    return this.live().setOuterForce(label, x, y, frameCount, easing);
  }

  /** Slot48, 0x1800031a0. */
  startWind(start: number, goal: number, speed: number, powerMin: number, powerMax: number): void {
    return this.live().startWind(start, goal, speed, powerMin, powerMax);
  }

  /** Slot49, 0x1800031b0. */
  stopWind(): void {
    return this.live().stopWind();
  }

  /** Slot50, 0x1800031e0. */
  countMainTimelines(): number {
    return this.live().countMainTimelines();
  }

  /** Slot51, 0x1800031f0. */
  getMainTimelineLabelAt(index: number): string {
    return this.live().getMainTimelineLabelAt(index);
  }

  /** Slot52, 0x180003220. */
  countDiffTimelines(): number {
    return this.live().countDiffTimelines();
  }

  /** Slot53, 0x180003230. */
  getDiffTimelineLabelAt(index: number): string {
    return this.live().getDiffTimelineLabelAt(index);
  }

  /** Slot54, 0x180003260. */
  countPlayingTimelines(): number {
    return this.live().countPlayingTimelines();
  }

  /** Slot55, 0x180003270. */
  getPlayingTimelineLabelAt(index: number): string {
    return this.live().getPlayingTimelineLabelAt(index);
  }

  /** Slot56, 0x1800032a0. */
  getPlayingTimelineFlagsAt(index: number): number {
    return this.live().getPlayingTimelineFlagsAt(index);
  }

  /** Slot57, 0x1800032b0. */
  isLoopTimeline(label: string): boolean {
    return this.live().isLoopTimeline(label);
  }

  /** Slot58, 0x180003370. */
  getTimelineTotalFrameCount(label: string): number {
    return this.live().getTimelineTotalFrameCount(label);
  }

  /** Slot59, 0x180003430. */
  playTimeline(label: string, flags: number): void {
    return this.live().playTimeline(label, flags);
  }

  /** Slot60, 0x1800034f0. */
  isTimelinePlaying(label: string): boolean {
    return this.live().isTimelinePlaying(label);
  }

  /** Slot61, 0x1800035b0. */
  stopTimeline(label: string): void {
    return this.live().stopTimeline(label);
  }

  /** Slot62, 0x180003670. */
  setTimelineBlendRatio(
    label: string,
    value: number,
    frameCount: number,
    easing: number,
    stopWhenBlendDone: boolean,
  ): void {
    return this.live().setTimelineBlendRatio(label, value, frameCount, easing, stopWhenBlendDone);
  }

  /** Slot63, 0x180003770. */
  getTimelineBlendRatio(label: string): number {
    return this.live().getTimelineBlendRatio(label);
  }

  /** Slot64, 0x180003830. */
  fadeInTimeline(label: string, frameCount: number, easing: number): void {
    return this.live().fadeInTimeline(label, frameCount, easing);
  }

  /** Slot65, 0x180003910. */
  fadeOutTimeline(label: string, frameCount: number, easing: number): void {
    return this.live().fadeOutTimeline(label, frameCount, easing);
  }

  /** Slot66, 0x1800039f0. */
  isAnimating(): boolean {
    return this.live().isAnimating();
  }

  /** Slot67, 0x180003a00. */
  skip(): void {
    return this.live().skip();
  }

  /** Slot68, 0x180003a10. */
  pass(): void {
    return this.live().pass();
  }

  /** Slot69, 0x180003a20. */
  step(): void {
    return this.live().step();
  }

  /** Slot70, 0x180003a30. */
  progress(frameCount: number): void {
    return this.live().progress(frameCount);
  }

  /** Slot71, 0x180003a40. */
  isModified(): boolean {
    return this.live().isModified();
  }

  /** Slot73, 0x180003b90. */
  setStereovisionEnabled(enabled: boolean): void {
    return this.live().setStereovisionEnabled(enabled);
  }

  /** Slot74, 0x180003ba0. */
  getStereovisionEnabled(): boolean {
    return this.live().getStereovisionEnabled();
  }

  /** Slot75, 0x180003bb0. */
  setStereovisionVolume(volume: number): void {
    return this.live().setStereovisionVolume(volume);
  }

  /** Slot76, 0x180003be0. */
  getStereovisionVolume(): number {
    return this.live().getStereovisionVolume();
  }

  /** Slot77, 0x180003bf0. */
  setStereovisionParallaxRatio(ratio: number): void {
    return this.live().setStereovisionParallaxRatio(ratio);
  }

  /** Slot78, 0x180003c20. */
  getStereovisionParallaxRatio(): number {
    return this.live().getStereovisionParallaxRatio();
  }

  /** Slot79, 0x180003c30. */
  setStereovisionRenderScreen(screen: number): void {
    return this.live().setStereovisionRenderScreen(screen);
  }

  /** Slot80, 0x180003c40. */
  getStereovisionRenderScreen(): number {
    return this.live().getStereovisionRenderScreen();
  }

  /** Slot81, 0x180003e80. */
  isCharaProfileAvailable(): boolean {
    return this.live().isCharaProfileAvailable();
  }

  /** Slot82, 0x180003e90. */
  getCharaHeight(): number {
    return this.live().getCharaHeight();
  }

  /** Slot83, 0x180003ea0. */
  countCharaProfiles(): number {
    return this.live().countCharaProfiles();
  }

  /** Slot84, 0x180003eb0. */
  getCharaProfileLabelAt(index: number): string {
    return this.live().getCharaProfileLabelAt(index);
  }

  /** Slot85, 0x180003ee0. */
  getCharaProfile(label: string): number {
    return this.live().getCharaProfile(label);
  }

  /** Slot86, 0x180003170. */
  setOuterRot(radians: number, frameCount: number, easing: number): void {
    return this.live().setOuterRot(radians, frameCount, easing);
  }

  /** Slot87, 0x180003180. */
  getOuterRot(): number {
    return this.live().getOuterRot();
  }

  /** Slot88, 0x180003c50. */
  startRecordAPILog(): void {
    return this.live().startRecordAPILog();
  }

  /** Slot89, 0x180003c60. */
  stopRecordAPILog(): void {
    return this.live().stopRecordAPILog();
  }

  /** Slot90, 0x180003c70. */
  isRecordingAPILog(): boolean {
    return this.live().isRecordingAPILog();
  }

  /** Slot91, 0x180003c80. */
  startReplayAPILog(): void {
    return this.live().startReplayAPILog();
  }

  /** Slot92, 0x180003c60. */
  stopReplayAPILog(): void {
    return this.live().stopReplayAPILog();
  }

  /** Slot93, 0x180003cb0. */
  isReplayingAPILog(): boolean {
    return this.live().isReplayingAPILog();
  }

  /** Slot94, 0x180003cc0. */
  clearAPILog(): void {
    return this.live().clearAPILog();
  }

  /** Slot95, 0x180003d10. */
  getAPILog(): string {
    return this.live().getAPILog();
  }

  /** Slot96, 0x180003dc0. */
  setAPILog(log: string): void {
    return this.live().setAPILog(log);
  }

  /** Slot97, 0x180002b70. */
  getSuitableClearColor(): number {
    return this.live().getSuitableClearColor();
  }

  /** Slot99, 0x180003fb0. */
  setBlinkEnabled(enabled: boolean): void {
    return this.live().setBlinkEnabled(enabled);
  }

  /** Slot100, 0x1800040a0. */
  getBlinkEnabled(): boolean {
    return this.live().getBlinkEnabled();
  }
}
