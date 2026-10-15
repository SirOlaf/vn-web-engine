/**
 * Draw devices (krkrz `visual/win32/DrawDevice.cpp`, `BasicDrawDevice.cpp`): the stage between
 * a window's layer managers and the screen. `tTVPDrawDevice` routes window input to the primary
 * layer manager and window requests back; `tTVPBasicDrawDevice` keeps the completed image in a
 * texture and presents it on the window's surface (natively a Direct3D 9 texture).
 *
 * The `interface` property of a draw device object is an interface pointer to its
 * `TvpDrawDeviceInterface` (`TvpMemory.handleOf`), as natively.
 */
import {throwTjsError, tjsMessage} from '../../tjs2/runtime/errors.js';
import type {TvpBaseBitmap} from './base-bitmap.js';
import {TvpRect} from './complex-rect.js';
import type {LayerNI} from './layer.js';
import {ltOpaque, type TvpLayerManagerInterface} from './layer-types.js';
import type {TvpLog} from '../log.js';

/** `iTVPWindow`: what a draw device asks of its window. */
export interface TvpWindowInterface {
  notifySrcResize(): void;
  setDefaultMouseCursor(): void;
  setMouseCursor(cursor: number): void;
  getCursorPos(): {x: number; y: number};
  setCursorPos(x: number, y: number): void;
  windowReleaseCapture(): void;
  setHintText(sender: unknown, text: string): void;
  setAttentionPoint(layer: object, l: number, t: number): void;
  disableAttentionPoint(): void;
  setImeMode(mode: number): void;
  resetImeMode(): void;
  requestUpdate(): void;
}

/**
 * The surface a draw device presents to: the window's client area in the host. `texture` is
 * written while the completion runs; `present` shows it scaled to `destRect`, clipped to
 * `clipRect`.
 */
export interface TvpPresentationSurface {
  /** (Re)creates the texture with the source size; returns its 32 bpp top-down bytes. */
  resizeTexture(width: number, height: number): Uint8Array;
  /** Shows the texture. `smooth`: linear filtering when zoomed (`-smoothzoom`). */
  present(destRect: TvpRect, clipRect: TvpRect, smooth: boolean): void;
}

/** `iTVPDrawDevice`. */
export interface TvpDrawDeviceInterface {
  destruct(): void;
  setWindowInterface(window: TvpWindowInterface | null): void;
  addLayerManager(manager: TvpLayerManagerInterface<LayerNI>): void;
  removeLayerManager(manager: TvpLayerManagerInterface<LayerNI>): void;
  setTargetWindow(surface: TvpPresentationSurface | null, isMain: boolean): void;
  setDestRectangle(rect: TvpRect): void;
  setClipRectangle(rect: TvpRect): void;
  getSrcSize(): {w: number; h: number};
  notifyLayerResize(manager: TvpLayerManagerInterface<LayerNI>): void;
  notifyLayerImageChange(manager: TvpLayerManagerInterface<LayerNI>): void;
  onClick(x: number, y: number): number;
  onDoubleClick(x: number, y: number): number;
  onMouseDown(x: number, y: number, mb: number, flags: number): number;
  onMouseUp(x: number, y: number, mb: number, flags: number): number;
  onMouseMove(x: number, y: number, flags: number): number;
  onReleaseCapture(): void;
  onMouseOutOfWindow(): number;
  onKeyDown(key: number, shift: number): number;
  onKeyUp(key: number, shift: number): number;
  onKeyPress(key: number): number;
  onMouseWheel(shift: number, delta: number, x: number, y: number): number;
  onTouchDown(x: number, y: number, cx: number, cy: number, id: number): number;
  onTouchUp(x: number, y: number, cx: number, cy: number, id: number): number;
  onTouchMove(x: number, y: number, cx: number, cy: number, id: number): number;
  onTouchScaling(startdist: number, curdist: number, cx: number, cy: number, flag: number): number;
  onTouchRotate(
    startangle: number,
    curangle: number,
    dist: number,
    cx: number,
    cy: number,
    flag: number,
  ): number;
  onMultiTouch(): number;
  onDisplayRotate(
    orientation: number,
    rotate: number,
    bpp: number,
    width: number,
    height: number,
  ): void;
  recheckInputState(): number;
  setDefaultMouseCursor(manager: TvpLayerManagerInterface<LayerNI>): void;
  setMouseCursor(manager: TvpLayerManagerInterface<LayerNI>, cursor: number): void;
  getCursorPos(manager: TvpLayerManagerInterface<LayerNI>): {x: number; y: number};
  setCursorPos(manager: TvpLayerManagerInterface<LayerNI>, x: number, y: number): void;
  windowReleaseCapture(manager: TvpLayerManagerInterface<LayerNI>): void;
  setHintText(manager: TvpLayerManagerInterface<LayerNI>, sender: unknown, text: string): void;
  setAttentionPoint(
    manager: TvpLayerManagerInterface<LayerNI>,
    layer: object,
    l: number,
    t: number,
  ): void;
  disableAttentionPoint(manager: TvpLayerManagerInterface<LayerNI>): void;
  setImeMode(manager: TvpLayerManagerInterface<LayerNI>, mode: number): void;
  resetImeMode(manager: TvpLayerManagerInterface<LayerNI>): void;
  getPrimaryLayer(): LayerNI | null;
  getFocusedLayer(): LayerNI | null;
  setFocusedLayer(layer: LayerNI | null): void;
  requestInvalidation(rect: TvpRect): void;
  update(): void;
  show(): void;
  startBitmapCompletion(manager: TvpLayerManagerInterface<LayerNI>): void;
  notifyBitmapCompleted(
    manager: TvpLayerManagerInterface<LayerNI>,
    x: number,
    y: number,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
    type: number,
    opacity: number,
  ): void;
  endBitmapCompletion(manager: TvpLayerManagerInterface<LayerNI>): void;
  dumpLayerStructure(): void;
  setShowUpdateRect(b: boolean): void;
  switchToFullScreen(
    w: number,
    h: number,
    bpp: number,
    color: number,
    changeResolution: boolean,
  ): boolean;
  revertFromFullScreen(w: number, h: number, bpp: number, color: number): void;
  waitForVBlank(): {inVBlank: boolean; delayed: boolean} | null;
}

/** `tTVPDrawDevice`. */
export class TvpDrawDevice implements TvpDrawDeviceInterface {
  protected window: TvpWindowInterface | null = null;
  protected primaryLayerManagerIndex = 0;
  protected readonly managers: TvpLayerManagerInterface<LayerNI>[] = [];
  readonly destRect = new TvpRect();
  readonly clipRect = new TvpRect();

  destruct(): void {
    for (const m of this.managers.slice()) m.release();
  }

  layerManagerAt(index: number): TvpLayerManagerInterface<LayerNI> | null {
    return this.managers[index] ?? null;
  }

  protected get primaryManager(): TvpLayerManagerInterface<LayerNI> | null {
    return this.layerManagerAt(this.primaryLayerManagerIndex);
  }

  /** `TransformToPrimaryLayerManager` (integer). */
  transformToPrimary(x: number, y: number): {x: number; y: number} | null {
    const size = this.primaryManager?.getPrimaryLayerSize();
    if (!size) return null;
    const w = this.destRect.width,
      h = this.destRect.height;
    return {
      x: w ? Math.trunc((x * size.w) / w) : 0,
      y: h ? Math.trunc((y * size.h) / h) : 0,
    };
  }

  /** `TransformToPrimaryLayerManager` (real). */
  transformToPrimaryReal(x: number, y: number): {x: number; y: number} | null {
    const size = this.primaryManager?.getPrimaryLayerSize();
    if (!size) return null;
    const w = this.destRect.width,
      h = this.destRect.height;
    return {x: w ? (x * size.w) / w : 0, y: h ? (y * size.h) / h : 0};
  }

  transformFromPrimary(x: number, y: number): {x: number; y: number} | null {
    const size = this.primaryManager?.getPrimaryLayerSize();
    if (!size) return null;
    return {
      x: size.w ? Math.trunc((x * this.destRect.width) / size.w) : 0,
      y: size.h ? Math.trunc((y * this.destRect.height) / size.h) : 0,
    };
  }

  setWindowInterface(window: TvpWindowInterface | null): void {
    this.window = window;
  }

  addLayerManager(manager: TvpLayerManagerInterface<LayerNI>): void {
    this.managers.push(manager);
    manager.addRef();
  }

  removeLayerManager(manager: TvpLayerManagerInterface<LayerNI>): void {
    const i = this.managers.indexOf(manager);
    if (i < 0) throwTjsError('TVPInternalError');
    this.managers[i]!.release();
    this.managers.splice(i, 1);
  }

  setTargetWindow(_surface: TvpPresentationSurface | null, _isMain: boolean): void {}

  setDestRectangle(rect: TvpRect): void {
    this.destRect.assign(rect);
  }

  setClipRectangle(rect: TvpRect): void {
    this.clipRect.assign(rect);
  }

  getSrcSize(): {w: number; h: number} {
    return this.primaryManager?.getPrimaryLayerSize() ?? {w: 0, h: 0};
  }

  notifyLayerResize(manager: TvpLayerManagerInterface<LayerNI>): void {
    if (this.primaryManager === manager) this.window!.notifySrcResize();
  }

  notifyLayerImageChange(manager: TvpLayerManagerInterface<LayerNI>): void {
    if (this.primaryManager === manager) this.window!.requestUpdate();
  }

  #toPrimary(
    x: number,
    y: number,
    then: (m: TvpLayerManagerInterface<LayerNI>, x: number, y: number) => number,
  ): number {
    const p = this.transformToPrimary(x, y);
    if (!p) return 0;
    const m = this.primaryManager;
    return m ? then(m, p.x, p.y) : 0;
  }

  #toPrimaryReal(
    x: number,
    y: number,
    then: (m: TvpLayerManagerInterface<LayerNI>, x: number, y: number) => number,
  ): number {
    const p = this.transformToPrimaryReal(x, y);
    if (!p) return 0;
    const m = this.primaryManager;
    return m ? then(m, p.x, p.y) : 0;
  }

  onClick(x: number, y: number): number {
    return this.#toPrimary(x, y, (m, px, py) => m.notifyClick(px, py));
  }
  onDoubleClick(x: number, y: number): number {
    return this.#toPrimary(x, y, (m, px, py) => m.notifyDoubleClick(px, py));
  }
  onMouseDown(x: number, y: number, mb: number, flags: number): number {
    return this.#toPrimary(x, y, (m, px, py) => m.notifyMouseDown(px, py, mb, flags));
  }
  onMouseUp(x: number, y: number, mb: number, flags: number): number {
    return this.#toPrimary(x, y, (m, px, py) => m.notifyMouseUp(px, py, mb, flags));
  }
  onMouseMove(x: number, y: number, flags: number): number {
    return this.#toPrimary(x, y, (m, px, py) => m.notifyMouseMove(px, py, flags));
  }
  onReleaseCapture(): void {
    this.primaryManager?.releaseCapture();
  }
  onMouseOutOfWindow(): number {
    return this.primaryManager?.notifyMouseOutOfWindow() ?? 0;
  }
  onKeyDown(key: number, shift: number): number {
    return this.primaryManager?.notifyKeyDown(key, shift) ?? 0;
  }
  onKeyUp(key: number, shift: number): number {
    return this.primaryManager?.notifyKeyUp(key, shift) ?? 0;
  }
  onKeyPress(key: number): number {
    return this.primaryManager?.notifyKeyPress(key) ?? 0;
  }
  onMouseWheel(shift: number, delta: number, x: number, y: number): number {
    return this.#toPrimary(x, y, (m, px, py) => m.notifyMouseWheel(shift, delta, px, py));
  }
  onTouchDown(x: number, y: number, cx: number, cy: number, id: number): number {
    return this.#toPrimaryReal(x, y, (m, px, py) => m.notifyTouchDown(px, py, cx, cy, id));
  }
  onTouchUp(x: number, y: number, cx: number, cy: number, id: number): number {
    return this.#toPrimaryReal(x, y, (m, px, py) => m.notifyTouchUp(px, py, cx, cy, id));
  }
  onTouchMove(x: number, y: number, cx: number, cy: number, id: number): number {
    return this.#toPrimaryReal(x, y, (m, px, py) => m.notifyTouchMove(px, py, cx, cy, id));
  }
  onTouchScaling(startdist: number, curdist: number, cx: number, cy: number, flag: number): number {
    return this.primaryManager?.notifyTouchScaling(startdist, curdist, cx, cy, flag) ?? 0;
  }
  onTouchRotate(
    startangle: number,
    curangle: number,
    dist: number,
    cx: number,
    cy: number,
    flag: number,
  ): number {
    return this.primaryManager?.notifyTouchRotate(startangle, curangle, dist, cx, cy, flag) ?? 0;
  }
  onMultiTouch(): number {
    return this.primaryManager?.notifyMultiTouch() ?? 0;
  }
  onDisplayRotate(): void {}
  recheckInputState(): number {
    return this.primaryManager?.recheckInputState() ?? 0;
  }

  #isPrimary(manager: TvpLayerManagerInterface<LayerNI>): boolean {
    const p = this.primaryManager;
    return !!p && p === manager;
  }

  setDefaultMouseCursor(manager: TvpLayerManagerInterface<LayerNI>): void {
    if (this.#isPrimary(manager)) this.window!.setDefaultMouseCursor();
  }

  setMouseCursor(manager: TvpLayerManagerInterface<LayerNI>, cursor: number): void {
    if (this.#isPrimary(manager)) this.window!.setMouseCursor(cursor);
  }

  getCursorPos(manager: TvpLayerManagerInterface<LayerNI>): {x: number; y: number} {
    if (!this.primaryManager) return {x: 0, y: 0};
    const p = this.window!.getCursorPos();
    if (this.primaryManager !== manager) return {x: 0, y: 0};
    return this.transformToPrimary(p.x, p.y) ?? {x: 0, y: 0};
  }

  setCursorPos(manager: TvpLayerManagerInterface<LayerNI>, x: number, y: number): void {
    if (!this.#isPrimary(manager)) return;
    const p = this.transformFromPrimary(x, y);
    if (p) this.window!.setCursorPos(p.x, p.y);
  }

  windowReleaseCapture(manager: TvpLayerManagerInterface<LayerNI>): void {
    if (this.#isPrimary(manager)) this.window!.windowReleaseCapture();
  }

  setHintText(manager: TvpLayerManagerInterface<LayerNI>, sender: unknown, text: string): void {
    if (this.#isPrimary(manager)) this.window!.setHintText(sender, text);
  }

  setAttentionPoint(
    manager: TvpLayerManagerInterface<LayerNI>,
    layer: object,
    l: number,
    t: number,
  ): void {
    if (!this.#isPrimary(manager)) return;
    const p = this.transformFromPrimary(l, t);
    if (p) this.window!.setAttentionPoint(layer, p.x, p.y);
  }

  disableAttentionPoint(manager: TvpLayerManagerInterface<LayerNI>): void {
    if (this.#isPrimary(manager)) this.window!.disableAttentionPoint();
  }

  setImeMode(manager: TvpLayerManagerInterface<LayerNI>, mode: number): void {
    if (this.#isPrimary(manager)) this.window!.setImeMode(mode);
  }

  resetImeMode(manager: TvpLayerManagerInterface<LayerNI>): void {
    if (this.#isPrimary(manager)) this.window!.resetImeMode();
  }

  getPrimaryLayer(): LayerNI | null {
    return this.primaryManager?.getPrimaryLayer() ?? null;
  }

  getFocusedLayer(): LayerNI | null {
    return this.primaryManager?.getFocusedLayer() ?? null;
  }

  setFocusedLayer(layer: LayerNI | null): void {
    this.primaryManager?.setFocusedLayer(layer);
  }

  requestInvalidation(rect: TvpRect): void {
    const lt = this.transformToPrimary(rect.left, rect.top);
    if (!lt) return;
    const rb = this.transformToPrimary(rect.right, rect.bottom);
    if (!rb) return;
    const m = this.primaryManager;
    if (!m) return;
    m.requestInvalidation(new TvpRect(lt.x, lt.y, rb.x + 1, rb.y + 1));
  }

  update(): void {
    for (const m of this.managers) m.updateToDrawDevice();
  }

  show(): void {}

  waitForVBlank(): {inVBlank: boolean; delayed: boolean} | null {
    return null;
  }

  startBitmapCompletion(_manager: TvpLayerManagerInterface<LayerNI>): void {}

  notifyBitmapCompleted(
    _manager: TvpLayerManagerInterface<LayerNI>,
    _x: number,
    _y: number,
    _bmp: TvpBaseBitmap,
    _cliprect: TvpRect,
    _type: number,
    _opacity: number,
  ): void {}

  endBitmapCompletion(_manager: TvpLayerManagerInterface<LayerNI>): void {}

  dumpLayerStructure(): void {
    for (const m of this.managers) m.dumpLayerStructure();
  }

  setShowUpdateRect(_b: boolean): void {}

  /** `SwitchToFullScreen`: `ChangeDisplaySettings` is refused by the browser host. */
  switchToFullScreen(): boolean {
    return false;
  }

  revertFromFullScreen(): void {}
}

/** `tTVPBasicDrawDevice`: an opaque texture of the primary layer, presented on the surface. */
export class TvpBasicDrawDevice extends TvpDrawDevice {
  #surface: TvpPresentationSurface | null = null;
  #isMainWindow = false;
  #drawUpdateRectangle = false;
  #texture: Uint8Array | null = null;
  #textureWidth = 0;
  #textureHeight = 0;
  #locked = false;
  #shouldShow = false;
  /** `TVPZoomInterpolation` (`-smoothzoom`, default yes). */
  readonly #smooth: boolean;

  constructor(
    private readonly log: TvpLog,
    getCommandLine: (name: string) => string | null,
  ) {
    super();
    this.#smooth = getCommandLine('-smoothzoom') !== 'no';
  }

  override addLayerManager(manager: TvpLayerManagerInterface<LayerNI>): void {
    if (this.managers.length > 0)
      throwTjsError('TVPBasicDrawDeviceDoesNotSupporteLayerManagerMoreThanOne');
    super.addLayerManager(manager);
    manager.setDesiredLayerType(ltOpaque);
  }

  override setTargetWindow(surface: TvpPresentationSurface | null, isMain: boolean): void {
    this.#destroyDevice();
    this.#surface = surface;
    this.#isMainWindow = isMain;
  }

  get isMainWindow(): boolean {
    return this.#isMainWindow;
  }

  override setDestRectangle(rect: TvpRect): void {
    if (rect.width === this.destRect.width && rect.height === this.destRect.height) {
      super.setDestRectangle(rect);
      return;
    }
    super.setDestRectangle(rect);
    this.ensureDevice();
  }

  override notifyLayerResize(manager: TvpLayerManagerInterface<LayerNI>): void {
    super.notifyLayerResize(manager);
    this.#createTexture();
  }

  /** `EnsureDevice`: the texture exists once there is a surface and a source size. */
  ensureDevice(): void {
    if (this.#surface && !this.#texture) this.#createTexture();
  }

  /** `SetToRecreateDrawer` + `EnsureDevice` (`recreate`). */
  recreate(): void {
    this.#destroyDevice();
    this.ensureDevice();
  }

  #createTexture(): void {
    this.#texture = null;
    if (!this.#surface) return;
    const {w, h} = this.getSrcSize();
    if (w <= 0 || h <= 0) return;
    this.#textureWidth = w;
    this.#textureHeight = h;
    this.#texture = this.#surface.resizeTexture(w, h);
    this.#shouldShow = true;
  }

  #destroyDevice(): void {
    this.#texture = null;
    this.#textureWidth = this.#textureHeight = 0;
  }

  override show(): void {
    if (!this.#surface || !this.#texture || !this.#shouldShow) return;
    this.#shouldShow = false;
    this.#surface.present(this.destRect, this.clipRect, this.#smooth);
  }

  override startBitmapCompletion(_manager: TvpLayerManagerInterface<LayerNI>): void {
    this.ensureDevice();
    if (this.#texture && this.#surface) {
      if (this.#locked)
        this.log.add(tjsMessage('TVPBasicDrawDeviceTextureHasAlreadyBeenLocked'), true);
      this.#locked = true;
    }
  }

  /** Copies `cliprect` of the completed bitmap to (`x`, `y`) of the texture. */
  override notifyBitmapCompleted(
    _manager: TvpLayerManagerInterface<LayerNI>,
    x: number,
    y: number,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
  ): void {
    const {w, h} = this.getSrcSize();
    const tex = this.#texture;
    if (
      !this.#locked ||
      !tex ||
      !this.#surface ||
      x < 0 ||
      y < 0 ||
      x + cliprect.width > w ||
      y + cliprect.height > h ||
      cliprect.left < 0 ||
      cliprect.top < 0 ||
      cliprect.right > bmp.width ||
      cliprect.bottom > bmp.height
    )
      return;
    this.#shouldShow = true;
    const u8 = bmp.memory.u8;
    const widthBytes = cliprect.width * 4;
    const pitch = this.#textureWidth * 4;
    for (let sy = cliprect.top, dy = y; sy < cliprect.bottom; sy++, dy++) {
      const s = bmp.scanLine(sy) + cliprect.left * 4;
      tex.set(u8.subarray(s, s + widthBytes), pitch * dy + x * 4);
    }
  }

  override endBitmapCompletion(_manager: TvpLayerManagerInterface<LayerNI>): void {
    if (!this.#surface || !this.#texture || !this.#locked) return;
    this.#locked = false;
  }

  override setShowUpdateRect(b: boolean): void {
    this.#drawUpdateRectangle = b;
  }

  get showUpdateRect(): boolean {
    return this.#drawUpdateRectangle;
  }

  /** The texture bytes (32 bpp, top-down) and size, for state dumps. */
  get texture(): {bytes: Uint8Array; width: number; height: number} | null {
    return this.#texture
      ? {bytes: this.#texture, width: this.#textureWidth, height: this.#textureHeight}
      : null;
  }
}
