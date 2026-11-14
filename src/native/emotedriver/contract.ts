import {defineNativeContract} from '../../platform/native-libraries.js';
import type {IDirect3DDevice9, IDirect3DTexture9} from '../d3d9/contract.js';
import type {
  ID3D11Device,
  ID3D11DeviceContext,
  ID3D11RenderTargetView,
  ID3D11DepthStencilView,
} from '../d3d11/contract.js';

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
   * Slot 18, natively `CreatePlayer(count, const uint8_t** data, const unsigned long* sizes,
   * IEmotePlayer**)`. Creates one player from `files.length` PSB file images: the sources of
   * every file are loaded and the motion comes from the last one. The caller keeps the
   * images unchanged while any player created from them, or cloned from such a player, exists.
   */
  createPlayers(files: readonly Uint8Array[]): IEmotePlayer | null;
  /** Slot 19. `createPlayers([data])`. */
  createPlayer(data: Uint8Array): IEmotePlayer | null;
  /** Slot 20. Releases device-dependent resources; players skip drawing until the device is back. */
  onDeviceLost(): void;
  /**
   * Slot 21. Pixelate source (core +0x3b4): the texture blend-mode-6 items sample, set by the
   * compositor before `render` and cleared after each `render`.
   */
  setPixelateSource(texture: IDirect3DTexture9 | null): void;
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

/**
 * D3D11 revision of `emotedriver.dll`, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`.
 * Slot numbers below include the deleting destructor at slot 0. They do not match
 * revision 1. Only the exact image identity selects this implementation.
 *
 * Native pointers to output scalars become plain result records. Narrow strings
 * become strings; float arguments/results keep native float32 rounding. No model,
 * clip, shader, draw list, browser object or rendering callback crosses this boundary.
 */

/**
 * `InitParam` default-allocator form (ctor 0x180001530). Offsets 0 and 8 hold the
 * device and immediate context. The runtime retains both. The remaining six native
 * words are zero: no swap chain, initial target, or allocator overrides. Bind the
 * target with `setRenderTarget` before rendering, as the native compositor does.
 */
export interface EmoteD3d11InitParam {
  readonly device: ID3D11Device;
  readonly context: ID3D11DeviceContext;
}

/** Native 4×4 float matrix, copied synchronously by the device setter. */
export type EmoteD3d11Matrix = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Audited D3D11 device subset; concrete vtable 0x180091280. */
export interface IEmoteD3d11Device {
  /** Slot 1, 0x180001800. EAX holds the incremented reference count. */
  addRef(): number;
  /** Slot 2, 0x180001810; destroys the device at zero. */
  release(): number;
  /** Slot 3, 0x180001520. */
  refCount(): number;
  /** Slot 5, 0x180001850. Shared MMotionDevice mask mode: stencil0 or alpha1 (initially1). */
  setMaskMode(mode: number): void;
  /** Slot 6, 0x180001860. Returns the shared signed32-bit mode word. */
  getMaskMode(): number;
  /**
   * Slot 9, 0x1800018c0. Native count, image-pointer and uint32-size arrays plus
   * an output player pointer. A successful output owns one reference. Images stay
   * unchanged while the player or its clones exist; the last image supplies motion.
   */
  createPlayers(files: readonly Uint8Array[]): IEmoteD3d11Player | null;
  /** Slot 10, 0x180001890; calls slot 9 with one image. */
  createPlayer(data: Uint8Array): IEmoteD3d11Player | null;
  /**
   * Slot 13, 0x180001b30 → 0x18005b2e0. Installs the compositor's native color
   * and optional depth view; does not replace the compositor's context bindings.
   */
  setRenderTarget(color: ID3D11RenderTargetView, depth: ID3D11DepthStencilView | null): void;
  /**
   * Slot 14, 0x180001ae0. Five signed int32 words, including the two stack
   * arguments omitted by thin-wrapper decompilation. Mode 1 is screen coordinates;
   * the native layer passes (0, 0, width, height, 1).
   */
  setScreenRect(x: number, y: number, width: number, height: number, mode: number): void;
  /** Slot 17, 0x180001b10. Automatic target-sized camera (enabled initially). */
  setAutomaticMatrix(enabled: boolean): void;
  /** Slot 18, 0x180001b20. */
  getAutomaticMatrix(): boolean;
  /** Slot 19, 0x180001b70. Copies 64 bytes to the device's world matrix. */
  setWorldMatrix(matrix: EmoteD3d11Matrix): void;
  /** Slot 20, 0x180001ba0. Copies 64 bytes to the device's view matrix. */
  setViewMatrix(matrix: EmoteD3d11Matrix): void;
  /** Slot 21, 0x180001be0. Copies 64 bytes to the device's projection matrix. */
  setProjectionMatrix(matrix: EmoteD3d11Matrix): void;
}

/**
 * D3D11 player, concrete vtable 0x180090f50. Unknown integer slots 15/16 and the
 * deleting destructor are deliberately absent. All other members map to native
 * operations, including native output getters expressed as plain result records.
 */
export interface IEmoteD3d11Player {
  /** Slot 1, 0x180001800. */
  addRef(): number;
  /** Slot 2, 0x180001810. */
  release(): number;
  /** Slot 3, 0x180001520. */
  refCount(): number;
  /** Slot 4, 0x180002800. */
  clone(): IEmoteD3d11Player | null;
  /** Slot 5, 0x180002840. */
  assignState(source: IEmoteD3d11Player): void;
  /** Slot 6, 0x180002850. */
  show(): void;
  /** Slot 7, 0x1800028a0. */
  hide(): void;
  /** Slot 8, 0x1800028f0. */
  isHidden(): boolean;
  /** Slot 9, 0x180002910. */
  setSmoothing(enabled: boolean): void;
  /** Slot 10, 0x180002920. */
  getSmoothing(): boolean;
  /** Slot 11, 0x180002930. */
  setMeshDivisionRatio(ratio: number): void;
  /** Slot 12, 0x180002960. */
  getMeshDivisionRatio(): number;
  /** Slot 13, 0x180002980. */
  setQueuing(enabled: boolean): void;
  /** Slot 14, 0x180002990. */
  getQueuing(): boolean;
  /** Slot 17, 0x1800029c0. */
  setHairScale(scale: number): void;
  /** Slot 18, 0x1800029d0. */
  getHairScale(): number;
  /** Slot 19, 0x1800029e0. */
  setPartsScale(scale: number): void;
  /** Slot 20, 0x1800029f0. */
  getPartsScale(): number;
  /** Slot 21, 0x180002a00. */
  setBustScale(scale: number): void;
  /** Slot 22, 0x180002a10. */
  getBustScale(): number;
  /** Slot 23, 0x180002a20. */
  setCoord(x: number, y: number, frameCount: number, easing: number): void;
  /** Slot 24, 0x180002a30. */
  getCoord(): {readonly x: number; readonly y: number};
  /** Slot 25, 0x180002a60. */
  setScale(scale: number, frameCount: number, easing: number): void;
  /** Slot 26, 0x180002a70. */
  getScale(): number;
  /** Slot 27, 0x180002a90. */
  setRot(radians: number, frameCount: number, easing: number): void;
  /** Slot 28, 0x180002aa0. */
  getRot(): number;
  /** Slot 29, 0x180002af0. */
  setColor(color: number, frameCount: number, easing: number): void;
  /** Slot 30, 0x180002b00. */
  getColor(): number;
  /** Slot 31, 0x180002b10. */
  setGrayscale(value: number, frameCount: number, easing: number): void;
  /** Slot 32, 0x180002b20. */
  getGrayscale(): number;
  /** Slot 33, 0x180002b50. */
  setAsOriginalScale(enabled: boolean): void;
  /** Slot 34, 0x180002b60. */
  isAsOriginalScale(): boolean;
  /** Slot 35, 0x180002b80. */
  getState(label: string): number;
  /** Slot 36, 0x180002f30. */
  countVariables(): number;
  /** Slot 37, 0x180002f40. */
  getVariableLabelAt(index: number): string;
  /** Slot 38, 0x180002f70. */
  countVariableFrameAt(index: number): number;
  /** Slot 39, 0x180002f90. */
  getVariableFrameLabelAt(index: number, frame: number): string;
  /** Slot 40, 0x180002fe0. */
  getVariableFrameValueAt(index: number, frame: number): number;
  /** Slot 41, 0x180003020. */
  addUserDefinedVariable(label: string): void;
  /** Slot 42, 0x1800030e0. */
  setVariable(label: string, value: number, frameCount: number, easing: number): void;
  /** Slot 43, 0x1800030f0. */
  getVariable(label: string): number;
  /** Slot 44, 0x180003100. */
  setVariableDiff(
    module: string,
    label: string,
    value: number,
    frameCount: number,
    easing: number,
  ): void;
  /** Slot 45, 0x180003110. */
  getVariableDiff(module: string, label: string): number;
  /** Slot 46, 0x180003120. */
  setOuterForce(label: string, x: number, y: number, frameCount: number, easing: number): void;
  /** Slot 47, 0x180003130. */
  getOuterForce(label: string): {readonly x: number; readonly y: number};
  /** Slot 48, 0x1800031a0. */
  startWind(start: number, goal: number, speed: number, powerMin: number, powerMax: number): void;
  /** Slot 49, 0x1800031b0. */
  stopWind(): void;
  /** Slot 50, 0x1800031e0. */
  countMainTimelines(): number;
  /** Slot 51, 0x1800031f0. */
  getMainTimelineLabelAt(index: number): string;
  /** Slot 52, 0x180003220. */
  countDiffTimelines(): number;
  /** Slot 53, 0x180003230. */
  getDiffTimelineLabelAt(index: number): string;
  /** Slot 54, 0x180003260. */
  countPlayingTimelines(): number;
  /** Slot 55, 0x180003270. */
  getPlayingTimelineLabelAt(index: number): string;
  /** Slot 56, 0x1800032a0. */
  getPlayingTimelineFlagsAt(index: number): number;
  /** Slot 57, 0x1800032b0. */
  isLoopTimeline(label: string): boolean;
  /** Slot 58, 0x180003370. */
  getTimelineTotalFrameCount(label: string): number;
  /** Slot 59, 0x180003430. */
  playTimeline(label: string, flags: number): void;
  /** Slot 60, 0x1800034f0. */
  isTimelinePlaying(label: string): boolean;
  /** Slot 61, 0x1800035b0. */
  stopTimeline(label: string): void;
  /** Slot 62, 0x180003670. */
  setTimelineBlendRatio(
    label: string,
    value: number,
    frameCount: number,
    easing: number,
    stopWhenBlendDone: boolean,
  ): void;
  /** Slot 63, 0x180003770. */
  getTimelineBlendRatio(label: string): number;
  /** Slot 64, 0x180003830. */
  fadeInTimeline(label: string, frameCount: number, easing: number): void;
  /** Slot 65, 0x180003910. */
  fadeOutTimeline(label: string, frameCount: number, easing: number): void;
  /** Slot 66, 0x1800039f0. */
  isAnimating(): boolean;
  /** Slot 67, 0x180003a00. */
  skip(): void;
  /** Slot 68, 0x180003a10. */
  pass(): void;
  /** Slot 69, 0x180003a20. */
  step(): void;
  /** Slot 70, 0x180003a30. */
  progress(frameCount: number): void;
  /** Slot 71, 0x180003a40. */
  isModified(): boolean;
  /** Slot 72, 0x180003b00. */
  render(): void;
  /** Slot 73, 0x180003b90. */
  setStereovisionEnabled(enabled: boolean): void;
  /** Slot 74, 0x180003ba0. */
  getStereovisionEnabled(): boolean;
  /** Slot 75, 0x180003bb0. */
  setStereovisionVolume(volume: number): void;
  /** Slot 76, 0x180003be0. */
  getStereovisionVolume(): number;
  /** Slot 77, 0x180003bf0. */
  setStereovisionParallaxRatio(ratio: number): void;
  /** Slot 78, 0x180003c20. */
  getStereovisionParallaxRatio(): number;
  /** Slot 79, 0x180003c30. */
  setStereovisionRenderScreen(screen: number): void;
  /** Slot 80, 0x180003c40. */
  getStereovisionRenderScreen(): number;
  /** Slot 81, 0x180003e80. */
  isCharaProfileAvailable(): boolean;
  /** Slot 82, 0x180003e90. */
  getCharaHeight(): number;
  /** Slot 83, 0x180003ea0. */
  countCharaProfiles(): number;
  /** Slot 84, 0x180003eb0. */
  getCharaProfileLabelAt(index: number): string;
  /** Slot 85, 0x180003ee0. */
  getCharaProfile(label: string): number;
  /** Slot 86, 0x180003170. */
  setOuterRot(radians: number, frameCount: number, easing: number): void;
  /** Slot 87, 0x180003180. */
  getOuterRot(): number;
  /** Slot 88, 0x180003c50. */
  startRecordAPILog(): void;
  /** Slot 89, 0x180003c60. */
  stopRecordAPILog(): void;
  /** Slot 90, 0x180003c70. */
  isRecordingAPILog(): boolean;
  /** Slot 91, 0x180003c80. */
  startReplayAPILog(): void;
  /** Slot 92, 0x180003c60. */
  stopReplayAPILog(): void;
  /** Slot 93, 0x180003cb0. */
  isReplayingAPILog(): boolean;
  /** Slot 94, 0x180003cc0. */
  clearAPILog(): void;
  /** Slot 95, 0x180003d10. */
  getAPILog(): string;
  /** Slot 96, 0x180003dc0. */
  setAPILog(log: string): void;
  /** Slot 97, 0x180002b70. */
  getSuitableClearColor(): number;
  /** Slot 98, 0x180002640. */
  initCore(): void;
  /** Slot 99, 0x180003fb0. */
  setBlinkEnabled(enabled: boolean): void;
  /** Slot 100, 0x1800040a0. */
  getBlinkEnabled(): boolean;
}

export interface EmoteDriverD3d11Exports {
  /** `?EmoteCreate@@YAPEAVIEmoteDevice@@AEBUInitParam@1@@Z`, 0x1800040f0; owned reference. */
  emoteCreate(param: EmoteD3d11InitParam): IEmoteD3d11Device;
  /** `?EmoteGetSDKVersion@@YAPEBDXZ`, 0x180004130. Metadata, never a build selector. */
  emoteGetSDKVersion(): string;
  /** `?EmoteGetBuildDateTime@@YAPEBDXZ`, 0x180004120. Metadata, never a build selector. */
  emoteGetBuildDateTime(): string;
}

export const EMOTE_DRIVER_D3D11 = defineNativeContract<EmoteDriverD3d11Exports>(
  'emotedriver.dll',
  '2',
);
