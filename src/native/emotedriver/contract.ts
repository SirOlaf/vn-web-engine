import {defineNativeContract} from '../../platform/native-libraries.js';
import type {IDirect3DDevice9} from '../d3d9/contract.js';

/**
 * `emotedriver.dll`: the Direct3D E-mote runtime. It has no script bindings; a compositor
 * (`drawdeviceD3DZ.dll`) creates an `IEmoteDevice` on its own Direct3D device and draws
 * players inside its layer pass.
 *
 * Slot numbers and addresses refer to SHA-256 `a3b693b6…5e70b3a86`. Labels are the
 * runtime's narrow `const char*` strings; callers pass them as strings. Frame counts and
 * easing values are `float`. Calls are synchronous.
 */

/** `IEmoteDevice::InitParam`. */
export interface EmoteInitParam {
  /** The compositor's device. `EmoteCreate` takes a reference (`addRef`). */
  readonly device: IDirect3DDevice9;
  // The native struct also carries optional `malloc`/`free` overrides for the runtime's
  // heap. They select an allocator, not behaviour, and have no counterpart here.
}

export const EMOTE_MASK_MODE_STENCIL = 0;
export const EMOTE_MASK_MODE_ALPHA = 1;

export const EMOTE_TIMELINE_PLAY_PARALLEL = 1;
export const EMOTE_TIMELINE_PLAY_DIFFERENCE = 2;

/** `IEmoteDevice`, concrete vtable 0x100716ec. */
export interface IEmoteDevice {
  /** Slot 0. */
  addRef(): number;
  /** Slot 1. The device is destroyed (slot 22) and its Direct3D device released at zero. */
  release(): number;
  /** Slot 2. Mode 0 (stencil) is kept when the device cannot use alpha masks. */
  setMaskMode(mode: number): void;
  /** Slot 3. */
  getMaskMode(): number;
  /** Slot 4. */
  setMaskRegionClipping(enabled: boolean): void;
  /** Slot 5. */
  getMaskRegionClipping(): boolean;
  /** Slot 6. Device capability gating alpha mask mode (core +0x22c); unnamed. */
  getAlphaMaskCapability(): number;
  /** Slot 7. Alpha mask enable (core +0x228); clearing it resets mask mode 1 to 0. */
  setAlphaMaskEnabled(value: number): void;
  /** Slot 8. */
  getAlphaMaskEnabled(): number;
  /** Slot 9. */
  setMipMapEnabled(enabled: boolean): void;
  /** Slot 10. */
  getMipMapEnabled(): boolean;
  /** Slot 11. */
  setAlphaOp(op: number): void;
  /** Slot 12. */
  getAlphaOp(): number;
  /** Slot 13. */
  setProtectTranslucentTextureColor(enabled: boolean): void;
  /** Slot 14. */
  getProtectTranslucentTextureColor(): boolean;
  /** Slot 15. */
  setPixelateDivision(division: number): void;
  /** Slot 16. */
  getPixelateDivision(): number;
  /** Slot 17. Lowers the texture size limit; never raises it. */
  setMaxTextureSize(width: number, height: number): void;
  /**
   * Slot 18. Creates a player for a PSB file image. The caller keeps `data` unchanged while
   * any player created from it, or cloned from such a player, exists.
   */
  createPlayerWithFlag(flag: number, data: Uint8Array): IEmotePlayer | null;
  /** Slot 19. `createPlayerWithFlag(1, data)`. */
  createPlayer(data: Uint8Array): IEmotePlayer | null;
  /** Slot 20. Releases device-dependent resources; players skip drawing until the device is back. */
  onDeviceLost(): void;
  /** Slot 21. Sets core +0x3b4; its reader is not yet identified. */
  setCore3b4(value: number): void;
}

/** `IEmotePlayer`, concrete vtable 0x1007174c. */
export interface IEmotePlayer {
  /** Slot 0. */
  addRef(): number;
  /** Slot 1. */
  release(): number;
  /** Slot 2. New player sharing the model, with a copy of this player's state. */
  clone(): IEmotePlayer;
  /** Slot 3. Copies motion state from a player of the same device. */
  assignState(source: IEmotePlayer): void;
  /** Slot 4. */
  show(): void;
  /** Slot 5. */
  hide(): void;
  /** Slot 6. */
  isHidden(): boolean;
  /** Slot 7. */
  setSmoothing(enabled: boolean): void;
  /** Slot 8. */
  getSmoothing(): boolean;
  /** Slot 9. */
  setMeshDivisionRatio(ratio: number): void;
  /** Slot 10. */
  getMeshDivisionRatio(): number;
  /** Slot 11. */
  setQueuing(enabled: boolean): void;
  /** Slot 12. */
  getQueuing(): boolean;
  /** Slot 13. */
  setHairScale(scale: number): void;
  /** Slot 14. */
  getHairScale(): number;
  /** Slot 15. */
  setPartsScale(scale: number): void;
  /** Slot 16. */
  getPartsScale(): number;
  /** Slot 17. */
  setBustScale(scale: number): void;
  /** Slot 18. */
  getBustScale(): number;
  /** Slot 19. */
  setCoord(x: number, y: number, frameCount: number, easing: number): void;
  /** Slot 20. */
  getCoord(): {readonly x: number; readonly y: number};
  /** Slot 21. */
  setScale(scale: number, frameCount: number, easing: number): void;
  /** Slot 22. */
  getScale(): number;
  /** Slot 23. */
  setRot(rot: number, frameCount: number, easing: number): void;
  /** Slot 24. */
  getRot(): number;
  /** Slot 25. `argb` is a 32-bit colour. */
  setColor(argb: number, frameCount: number, easing: number): void;
  /** Slot 26. */
  getColor(): number;
  /** Slot 27. */
  countVariables(): number;
  /** Slot 28. Empty for an out-of-range index. */
  getVariableLabelAt(index: number): string;
  /** Slot 29. */
  countVariableFrameAt(index: number): number;
  /** Slot 30. */
  getVariableFrameLabelAt(index: number, frame: number): string;
  /** Slot 31. 0 for an out-of-range index or frame. */
  getVariableFrameValueAt(index: number, frame: number): number;
  /** Slot 32. */
  setVariable(label: string, value: number, frameCount: number, easing: number): void;
  /** Slot 33. */
  getVariable(label: string): number;
  /** Slot 34. */
  startWind(start: number, goal: number, speed: number, powerMin: number, powerMax: number): void;
  /** Slot 35. */
  stopWind(): void;
  /** Slot 36. */
  countMainTimelines(): number;
  /** Slot 37. */
  getMainTimelineLabelAt(index: number): string;
  /** Slot 38. */
  countDiffTimelines(): number;
  /** Slot 39. */
  getDiffTimelineLabelAt(index: number): string;
  /** Slot 40. */
  countPlayingTimelines(): number;
  /** Slot 41. */
  getPlayingTimelineLabelAt(index: number): string;
  /** Slot 42. */
  getPlayingTimelineFlagsAt(index: number): number;
  /** Slot 43. */
  isLoopTimeline(label: string): boolean;
  /** Slot 44. `flags` combines `EMOTE_TIMELINE_PLAY_*`. */
  playTimeline(label: string, flags: number): void;
  /** Slot 45. */
  isTimelinePlaying(label: string): boolean;
  /** Slot 46. */
  stopTimeline(label: string): void;
  /** Slot 47. */
  setTimelineBlendRatio(
    label: string,
    value: number,
    frameCount: number,
    easing: number,
    stopWhenBlendDone: boolean,
  ): void;
  /** Slot 48. */
  getTimelineBlendRatio(label: string): number;
  /** Slot 49. Starts the timeline (parallel, difference) at ratio 0 if needed, then blends to 1. */
  fadeInTimeline(label: string, frameCount: number, easing: number): void;
  /** Slot 50. Blends to 0 and stops the timeline when done. */
  fadeOutTimeline(label: string, frameCount: number, easing: number): void;
  /** Slot 51. */
  isAnimating(): boolean;
  /** Slot 52. */
  skip(): void;
  /** Slot 53. */
  pass(): void;
  /** Slot 54. Advances the motion by `frameCount` frames. */
  progress(frameCount: number): void;
  /** Slot 55. */
  isModified(): boolean;
  /**
   * Slot 56. Draws into the render target and transforms the compositor has bound on the
   * shared device. Skipped while the device is lost.
   */
  render(): void;
}

export interface EmoteDriverExports {
  /** `?EmoteCreate@@YAPAVIEmoteDevice@@ABUInitParam@1@@Z` (0x10002bb0). Reference count 1. */
  emoteCreate(param: EmoteInitParam): IEmoteDevice;
  /**
   * `?EmoteFilterTexture@@YAXPAEKP6AX0K@Z@Z` (0x10002c20). Decrypts the PSB image in `data`
   * and calls `filter` on the pixel bytes of every `RGBA8` source texture and its mip levels.
   * Changes `filter` makes to a view are written back into `data`.
   */
  emoteFilterTexture(data: Uint8Array, filter: (pixels: Uint8Array) => void): void;
}

export const EMOTE_DRIVER = defineNativeContract<EmoteDriverExports>('emotedriver.dll', '1');
