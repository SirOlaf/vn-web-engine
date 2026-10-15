/**
 * Types shared by layers, layer managers, layer tree owners and draw devices (krkrz
 * `visual/drawable.h`, `visual/LayerTreeOwner.h`, `visual/tvpinputdefs.h`, the enums of
 * `visual/LayerIntf.h`).
 */
import type {Dispatch} from '../../tjs2/runtime/interface.js';
import {TvpBaseBitmap} from './base-bitmap.js';
import {TvpRect} from './complex-rect.js';
import type {TvpFontSystem} from './font.js';
import type {TvpMemory} from './memory.js';

/** `tTVPLayerType`. */
export const ltBinder = 0;
export const ltOpaque = 1;
export const ltAlpha = 2;
export const ltAdditive = 3;
export const ltSubtractive = 4;
export const ltMultiplicative = 5;
export const ltEffect = 6;
export const ltFilter = 7;
export const ltDodge = 8;
export const ltDarken = 9;
export const ltLighten = 10;
export const ltScreen = 11;
export const ltAddAlpha = 12;
export const ltPsNormal = 13;
export const ltPsAdditive = 14;
export const ltPsSubtractive = 15;
export const ltPsMultiplicative = 16;
export const ltPsScreen = 17;
export const ltPsOverlay = 18;
export const ltPsHardLight = 19;
export const ltPsSoftLight = 20;
export const ltPsColorDodge = 21;
export const ltPsColorDodge5 = 22;
export const ltPsColorBurn = 23;
export const ltPsLighten = 24;
export const ltPsDarken = 25;
export const ltPsDifference = 26;
export const ltPsDifference5 = 27;
export const ltPsExclusion = 28;

export function isTypeUsingAlpha(type: number): boolean {
  return type === ltAlpha || (type >= ltPsNormal && type <= ltPsExclusion);
}

export function isTypeUsingAddAlpha(type: number): boolean {
  return type === ltAddAlpha;
}

export function isTypeUsingAlphaChannel(type: number): boolean {
  return isTypeUsingAddAlpha(type) || isTypeUsingAlpha(type);
}

/** `tTVPDrawFace`. */
export const dfAlpha = 0;
export const dfAddAlpha = 4;
export const dfOpaque = 1;
export const dfMask = 2;
export const dfProvince = 3;
export const dfAuto = 128;

/** `tTVPBlendOperationMode` (the values of the layer types they mirror). */
export const omPsNormal = ltPsNormal;
export const omPsAdditive = ltPsAdditive;
export const omPsSubtractive = ltPsSubtractive;
export const omPsMultiplicative = ltPsMultiplicative;
export const omPsScreen = ltPsScreen;
export const omPsOverlay = ltPsOverlay;
export const omPsHardLight = ltPsHardLight;
export const omPsSoftLight = ltPsSoftLight;
export const omPsColorDodge = ltPsColorDodge;
export const omPsColorDodge5 = ltPsColorDodge5;
export const omPsColorBurn = ltPsColorBurn;
export const omPsLighten = ltPsLighten;
export const omPsDarken = ltPsDarken;
export const omPsDifference = ltPsDifference;
export const omPsDifference5 = ltPsDifference5;
export const omPsExclusion = ltPsExclusion;
export const omAdditive = ltAdditive;
export const omSubtractive = ltSubtractive;
export const omMultiplicative = ltMultiplicative;
export const omDodge = ltDodge;
export const omDarken = ltDarken;
export const omLighten = ltLighten;
export const omScreen = ltScreen;
export const omAlpha = ltAlpha;
export const omAddAlpha = ltAddAlpha;
export const omOpaque = ltOpaque;
export const omAuto = 128;

/** `tTVPHitType`. */
export const htMask = 0;
export const htProvince = 1;

/** `tTVPImeMode`. */
export const imDisable = 0;
export const imClose = 1;

/** `tTVPMouseButton`. */
export const mbLeft = 0;
export const mbRight = 1;
export const mbMiddle = 2;
export const mbX1 = 3;
export const mbX2 = 4;

/** Shift state flags (`TVP_SS_*`). */
export const TVP_SS_SHIFT = 0x01;
export const TVP_SS_ALT = 0x02;
export const TVP_SS_CTRL = 0x04;
export const TVP_SS_LEFT = 0x08;
export const TVP_SS_RIGHT = 0x10;
export const TVP_SS_MIDDLE = 0x20;
export const TVP_SS_DOUBLE = 0x40;
export const TVP_SS_REPEAT = 0x80;

/** `TVPIsAnyMouseButtonPressedInShiftStateFlags`. */
export function isAnyMouseButtonPressed(flags: number): boolean {
  return (flags & (TVP_SS_LEFT | TVP_SS_RIGHT | TVP_SS_MIDDLE)) !== 0;
}

/** Colour key values of `loadImages`. */
export const TVP_clAdapt = 0x01ffffff;
export const TVP_clNone = 0x1fffffff;

/** `tTVPDrawable`. */
export interface TvpDrawable {
  /** A target bitmap of `rect`'s size; the drawn area is stored to `cliprect`. */
  getDrawTargetBitmap(rect: TvpRect, cliprect: TvpRect): TvpBaseBitmap;
  getTargetLayerType(): number;
  /** The image of `destrect` is in `bmp` at `cliprect`. */
  drawCompleted(
    destrect: TvpRect,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
    type: number,
    opacity: number,
  ): void;
}

/**
 * `tTVPTempBitmapHolder`: the initial layer image (32×32, transparent white) and the nested
 * temporary bitmaps of the drawing pipeline.
 */
export class TvpTempBitmapHolder {
  readonly initial: TvpBaseBitmap;
  readonly #temporaries: TvpBaseBitmap[] = [];
  #level = 0;

  constructor(
    private readonly fonts: TvpFontSystem,
    private readonly memory: TvpMemory,
  ) {
    this.initial = new TvpBaseBitmap(fonts, memory, 32, 32, 32);
    this.initial.fill(new TvpRect(0, 0, 32, 32), 0x00ffffff);
  }

  /** `GetTemp`: widths are rounded up to even unless `fit`. */
  getTemp(w: number, h: number, fit = false): TvpBaseBitmap {
    if (!fit) w += w & 1;
    this.#level++;
    if (this.#level > this.#temporaries.length) {
      const bmp = new TvpBaseBitmap(this.fonts, this.memory, w, h, 32);
      this.#temporaries.push(bmp);
      return bmp;
    }
    const bmp = this.#temporaries[this.#level - 1]!;
    if (!fit) {
      if (bmp.width < w || bmp.height < h)
        bmp.setSize(Math.max(bmp.width, w), Math.max(bmp.height, h), false);
    } else if (bmp.width !== w || bmp.height !== h) bmp.setSize(w, h, false);
    return bmp;
  }

  freeTemp(): void {
    if (this.#level === 0) return;
    this.#level--;
  }

  /** `OnCompact` at `TVP_COMPACT_LEVEL_DEACTIVATE` and above. */
  compact(): void {
    for (const b of this.#temporaries.splice(this.#level)) b.dispose();
  }
}

/**
 * `iTVPLayerManager`: a layer manager as layer tree owners and draw devices see it. `L` is the
 * layer native instance type, opaque to them.
 */
export interface TvpLayerManagerInterface<L extends object = object> {
  addRef(): void;
  release(): void;
  setDrawDeviceData(data: unknown): void;
  getDrawDeviceData(): unknown;
  /** The primary layer's size, or null without a primary layer. */
  getPrimaryLayerSize(): {w: number; h: number} | null;
  getPrimaryLayer(): L | null;
  getFocusedLayer(): L | null;
  setFocusedLayer(layer: L | null): void;
  notifyClick(x: number, y: number): number;
  notifyDoubleClick(x: number, y: number): number;
  notifyMouseDown(x: number, y: number, mb: number, flags: number): number;
  notifyMouseUp(x: number, y: number, mb: number, flags: number): number;
  notifyMouseMove(x: number, y: number, flags: number): number;
  releaseCapture(): void;
  notifyMouseOutOfWindow(): number;
  notifyKeyDown(key: number, shift: number): number;
  notifyKeyUp(key: number, shift: number): number;
  notifyKeyPress(key: number): number;
  notifyMouseWheel(shift: number, delta: number, x: number, y: number): number;
  notifyTouchDown(x: number, y: number, cx: number, cy: number, id: number): number;
  notifyTouchUp(x: number, y: number, cx: number, cy: number, id: number): number;
  notifyTouchMove(x: number, y: number, cx: number, cy: number, id: number): number;
  notifyTouchScaling(
    startdist: number,
    curdist: number,
    cx: number,
    cy: number,
    flag: number,
  ): number;
  notifyTouchRotate(
    startangle: number,
    curangle: number,
    dist: number,
    cx: number,
    cy: number,
    flag: number,
  ): number;
  notifyMultiTouch(): number;
  recheckInputState(): number;
  setDesiredLayerType(type: number): void;
  /** Draw device → layers: `r` of the primary layer must be redrawn. */
  requestInvalidation(r: TvpRect): void;
  /** Draw device → layers: completes the update region onto the draw device. */
  updateToDrawDevice(): void;
  dumpLayerStructure(): void;
}

/** `iTVPLayerTreeOwner`. Coordinates are in the primary layer manager's space. */
export interface TvpLayerTreeOwner {
  registerLayerManager(manager: TvpLayerManagerInterface): void;
  unregisterLayerManager(manager: TvpLayerManagerInterface): void;
  startBitmapCompletion(manager: TvpLayerManagerInterface): void;
  notifyBitmapCompleted(
    manager: TvpLayerManagerInterface,
    x: number,
    y: number,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
    type: number,
    opacity: number,
  ): void;
  endBitmapCompletion(manager: TvpLayerManagerInterface): void;
  setMouseCursor(manager: TvpLayerManagerInterface, cursor: number): void;
  getCursorPos(manager: TvpLayerManagerInterface): {x: number; y: number};
  setCursorPos(manager: TvpLayerManagerInterface, x: number, y: number): void;
  releaseMouseCapture(manager: TvpLayerManagerInterface): void;
  setHint(manager: TvpLayerManagerInterface, sender: Dispatch | null, hint: string): void;
  notifyLayerResize(manager: TvpLayerManagerInterface): void;
  notifyLayerImageChange(manager: TvpLayerManagerInterface): void;
  setAttentionPoint(manager: TvpLayerManagerInterface, layer: object, x: number, y: number): void;
  disableAttentionPoint(manager: TvpLayerManagerInterface): void;
  setImeMode(manager: TvpLayerManagerInterface, mode: number): void;
  resetImeMode(manager: TvpLayerManagerInterface): void;
  /** The TJS object owning the tree (the Window), without a reference. */
  getOwnerNoAddRef(): Dispatch | null;
}
