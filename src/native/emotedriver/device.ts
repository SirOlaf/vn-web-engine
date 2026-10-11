import type {IDirect3DDevice9, IDirect3DTexture9} from '../d3d9/contract.js';
import {readEmoteModel, type EmoteModel} from '../../formats/kirikiri/emote-model.js';
import {EMOTE_PSB_KEYS, decryptPsbBody} from '../../formats/kirikiri/psb-filter.js';
import type {EmoteInitParam, IEmoteDevice, IEmotePlayer} from './contract.js';
import {EmoteDeviceCore} from './runtime/render/device-core.js';
import {EmoteMotionRenderer} from './runtime/render/renderer.js';
import type {EmoteShaderBlobs} from './runtime/render/shaders.js';

/** SHA-256 of the `emotedriver.dll` build this implementation reproduces. */
export const EMOTEDRIVER_SHA256 =
  'a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86';

/** What the player core receives for a new player (PEmotePlayer ctor 0x10001880). */
export interface EmotePlayerContext {
  /** The player's renderer (`AMotionRenderer`, 0xa0 bytes), sources of every file loaded. */
  readonly renderer: EmoteMotionRenderer;
  /** All motion files of the player in call order; the last one is `model`. */
  readonly models: readonly EmoteModel[];
}

/**
 * Creates a player for decrypted, typed motion data. Provided by the player core; `model` is
 * the motion file `MEmotePlayer` is constructed on (the last one passed).
 */
export type EmotePlayerFactory = (
  device: PEmoteDevice,
  model: EmoteModel,
  flag: number,
  context: EmotePlayerContext,
) => IEmotePlayer;

/**
 * `PEmoteDevice` (vtable 0x100716ec, 0x10 bytes: vtable, refcount, `IDirect3DDevice9*`,
 * `MMotionDevice*`). Created by `EmoteCreate` (0x10002bb0 → ctor 0x10001140).
 */
export class PEmoteDevice implements IEmoteDevice {
  private refCount = 1;
  readonly device: IDirect3DDevice9;
  /** +0xc. */
  readonly core: EmoteDeviceCore;

  constructor(
    param: EmoteInitParam,
    private readonly createPlayerCore: EmotePlayerFactory,
    shaders: EmoteShaderBlobs | null,
  ) {
    this.device = param.device;
    this.device.addRef();
    this.core = new EmoteDeviceCore(this.device, shaders);
  }

  /** Slot 0, 0x10001d90. */
  addRef(): number {
    return ++this.refCount;
  }

  /** Slot 1, 0x10001230; slot 22 (0x100011f0) at zero. */
  release(): number {
    const count = --this.refCount;
    if (count === 0) {
      this.core.destroy();
      this.device.release();
    }
    return count;
  }

  /** Slot 2, 0x10001250. */
  setMaskMode(mode: number): void {
    const core = this.core;
    core.maskMode = core.shaderLevel() === 0 && mode !== 0 ? 0 : mode;
  }

  /** Slot 3, 0x100012a0. */
  getMaskMode(): number {
    return this.core.maskMode;
  }

  /** Slot 4, 0x100012b0. */
  setMaskRegionClipping(enabled: boolean): void {
    this.core.maskRegionClipping = enabled;
  }

  /** Slot 5, 0x100012c0. */
  getMaskRegionClipping(): boolean {
    return this.core.maskRegionClipping;
  }

  /** Slot 6, 0x100012d0: shader level supported (+0x22c). */
  getAlphaMaskCapability(): number {
    return this.core.shaderLevelSupported;
  }

  /** Slot 7, 0x100012e0: shader level allowed (+0x228). */
  setAlphaMaskEnabled(value: number): void {
    const core = this.core;
    if (core.shaderLevelAllowed === value) return;
    core.shaderLevelAllowed = value;
    if (value === 0 && core.maskMode === 1) core.maskMode = 0;
  }

  /** Slot 8, 0x10001310. */
  getAlphaMaskEnabled(): number {
    return this.core.shaderLevelAllowed;
  }

  /** Slot 9, 0x10001320. */
  setMipMapEnabled(enabled: boolean): void {
    this.core.mipMapEnabled = enabled;
  }

  /** Slot 10, 0x10001330. */
  getMipMapEnabled(): boolean {
    return this.core.mipMapEnabled;
  }

  /** Slot 11, 0x10001340. */
  setAlphaOp(op: number): void {
    this.core.alphaOp = op;
  }

  /** Slot 12, 0x10001350. */
  getAlphaOp(): number {
    return this.core.alphaOp;
  }

  /** Slot 13, 0x10001360. */
  setProtectTranslucentTextureColor(enabled: boolean): void {
    this.core.protectTranslucentTextureColor = enabled;
  }

  /** Slot 14, 0x10001370. */
  getProtectTranslucentTextureColor(): boolean {
    return this.core.protectTranslucentTextureColor;
  }

  /** Slot 15, 0x10001380. */
  setPixelateDivision(division: number): void {
    this.core.pixelateDivision = division;
  }

  /** Slot 16, 0x10001390. */
  getPixelateDivision(): number {
    return this.core.pixelateDivision;
  }

  /** Slot 17, 0x100013a0: lowers caps +0x60/+0x64. */
  setMaxTextureSize(width: number, height: number): void {
    const core = this.core;
    if (width < core.maxTextureWidth) core.maxTextureWidth = width;
    if (height < core.maxTextureHeight) core.maxTextureHeight = height;
  }

  /**
   * Slot 18, 0x10001440 → PEmotePlayer ctor 0x10001880. Natively `CreatePlayer(count,
   * const uint8_t** data, const unsigned long* sizes, IEmotePlayer**)`: the first argument
   * is the number of motion files. Each file is decrypted (`StructCryptFilter`, key
   * "742877301") and its sources loaded into the new player's renderer (0x1002bb30); the
   * player core is built on the last file. `data` may be a list of `count` files.
   */
  createPlayerWithFlag(
    flag: number,
    data: Uint8Array | readonly Uint8Array[],
  ): IEmotePlayer | null {
    const files = data instanceof Uint8Array ? [data] : data.slice(0, flag);
    if (files.length === 0) return null;
    const key = EMOTE_PSB_KEYS.get(EMOTEDRIVER_SHA256)!;
    const renderer = new EmoteMotionRenderer(this.core);
    const models: EmoteModel[] = [];
    for (const file of files) {
      const model = readEmoteModel(decryptPsbBody(file, key));
      renderer.loadModelSources(model);
      models.push(model);
    }
    return this.createPlayerCore(this, models[models.length - 1]!, flag, {renderer, models});
  }

  /** Slot 19, 0x10001420: `CreatePlayer(1, &data, &size)`. */
  createPlayer(data: Uint8Array): IEmotePlayer | null {
    return this.createPlayerWithFlag(1, data);
  }

  /** Slot 20, 0x10001400 → 0x100559e0. */
  onDeviceLost(): void {
    this.core.onDeviceLost();
  }

  /**
   * Slot 21, 0x10001410: core +0x3b4, the pixelate source texture (an `IDirect3DTexture9*`
   * the compositor sets before Render; cleared after each Render). Numbers carry no texture
   * across this boundary; any number clears it.
   */
  setCore3b4(value: number | IDirect3DTexture9 | null): void {
    this.core.pixelateSource = typeof value === 'number' || value === null ? null : value;
  }
}
