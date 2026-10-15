/**
 * `tTJSNI_BaseWindow` and the win32 `tTJSNI_Window` (krkrz `visual/WindowIntf.cpp`,
 * `visual/win32/WindowImpl.cpp`) with the parts of `TTVPWindowForm`
 * (`environ/win32/WindowFormUnit.cpp`) that scripts observe. The OS window is a
 * `WindowsTopLevelWindow` (`src/platform`); the host decides how it appears in the page.
 *
 * A window is the layer tree owner of its layers (`iTVPLayerTreeOwner`) and hands everything to
 * its draw device. Updates: a layer change requests a window update (`TVPPostWindowUpdate`);
 * the event system later calls `updateContent`, which completes the update region onto the
 * draw device and shows it.
 */
import {throwTjsError} from '../../tjs2/runtime/errors.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_S_OK,
  failed,
  type Dispatch,
} from '../../tjs2/runtime/interface.js';
import {
  NativeInstanceBase,
  getNativeInstance,
  registerNativeClass,
} from '../../tjs2/runtime/native.js';
import type {Suspender} from '../../tjs2/runtime/suspension.js';
import {VariantSlot, addRefVariant, releaseVariant} from '../../tjs2/runtime/slot.js';
import {
  NULL_OBJECT,
  VOID,
  asInteger,
  asObjectClosure,
  bool,
  int,
  integer,
  obj,
  real,
  str,
  type ObjectVariant,
  type Variant,
} from '../../tjs2/runtime/variant.js';
import {
  WS_BORDER,
  WS_CAPTION,
  WS_CLIPCHILDREN,
  WS_DLGFRAME,
  WS_EX_ACCEPTFILES,
  WS_EX_APPWINDOW,
  WS_EX_CONTROLPARENT,
  WS_EX_DLGMODALFRAME,
  WS_EX_TOOLWINDOW,
  WS_EX_WINDOWEDGE,
  WS_MAXIMIZEBOX,
  WS_MINIMIZEBOX,
  WS_OVERLAPPEDWINDOW,
  WS_POPUP,
  WS_SYSMENU,
  WS_THICKFRAME,
  WindowsTopLevelWindow,
} from '../../../../platform/windows-top-level-window.js';
import {
  TVP_EPT_IMMEDIATE,
  TVP_EPT_DISCARDABLE,
  type TvpEventSystem,
  type TvpUpdatableWindow,
} from '../events.js';
import type {TvpBaseBitmap} from './base-bitmap.js';
import {TvpRect} from './complex-rect.js';
import type {
  TvpDrawDeviceInterface,
  TvpPresentationSurface,
  TvpWindowInterface,
} from './draw-device.js';
import type {LayerNI} from './layer.js';
import {imClose, type TvpLayerManagerInterface, type TvpLayerTreeOwner} from './layer-types.js';
import type {TvpMemory} from './memory.js';

export const WINDOW_CLASS_ID = registerNativeClass('Window');

/** `tTVPBorderStyle`. */
export const bsNone = 0;
export const bsSingle = 1;
export const bsSizeable = 2;
export const bsDialog = 3;
export const bsToolWindow = 4;
export const bsSizeToolWin = 5;

/** `tTVPMouseCursorState`. */
export const mcsVisible = 0;
export const mcsTempHidden = 1;
export const mcsHidden = 2;

/** `tTVPUpdateType`. */
export const utNormal = 0;
export const utEntire = 1;

const DEFAULT_EX_STYLE = WS_EX_ACCEPTFILES | WS_EX_APPWINDOW;
/** `TTVPWindowForm::TVP_TOOLTIP_SHOW_DELAY`. */
const TOOLTIP_SHOW_DELAY = 500;

/** The page side of Kirikiri windows. */
export interface KirikiriWindowHost {
  /** A new top-level window (`CreateWindowEx`), hidden. */
  createWindow(
    caption: string,
    clientWidth: number,
    clientHeight: number,
    style: number,
    exStyle: number,
  ): WindowsTopLevelWindow;
  /** The presentation surface of a window's client area, or null (headless). */
  surfaceOf(window: WindowsTopLevelWindow): TvpPresentationSurface | null;
  /** `GetCursorPos` relative to the window's client area. */
  cursorPos(window: WindowsTopLevelWindow): {x: number; y: number};
  setCursorPos?(window: WindowsTopLevelWindow, x: number, y: number): void;
  /** Sets the mouse cursor shape (0 is the default cursor). */
  setCursor?(window: WindowsTopLevelWindow, cursor: number, visible: boolean): void;
  windowClosed?(window: WindowsTopLevelWindow): void;
}

/** A host without a page: windows keep their state, nothing is shown. */
export const HEADLESS_WINDOW_HOST: KirikiriWindowHost = {
  createWindow: (caption, w, h, style, exStyle) =>
    new WindowsTopLevelWindow(caption, w, h, style, exStyle),
  surfaceOf: () => null,
  cursorPos: () => ({x: 0, y: 0}),
};

/** What windows need from the core. */
export interface TvpWindowContext {
  readonly events: TvpEventSystem;
  readonly memory: TvpMemory;
  readonly host: KirikiriWindowHost;
  /** `Application->GetTitle()` (`System.title`). */
  title(): string;
  /** Creates the default draw device object (`new BasicDrawDevice()`), owned by the caller. */
  createDefaultDrawDevice(): Dispatch;
  /** `TVPMainWindowClosed`: the main window was closed. */
  mainWindowClosed(): void;
  /** Runs `task` from the message loop (`WM_PAINT` after `InvalidateRect`). */
  postPaint(task: () => void): void;
  readonly suspender: Suspender;
}

/** `TVPWindowVector` and `TVPMainWindow`. */
export class TvpWindowList {
  readonly windows: WindowNI[] = [];
  mainWindow: WindowNI | null = null;

  register(window: WindowNI): void {
    if (!this.mainWindow && this.windows.length === 0) this.mainWindow = window;
    this.windows.push(window);
    for (const w of this.windows) w.postReleaseCaptureEvent();
  }

  unregister(window: WindowNI, ctx: TvpWindowContext): void {
    const i = this.windows.indexOf(window);
    if (i < 0) return;
    const wasMain = this.windows[i] === this.mainWindow;
    this.windows.splice(i, 1);
    if (wasMain) {
      ctx.mainWindowClosed();
      this.mainWindow = null;
    }
  }

  get count(): number {
    return this.windows.length;
  }
}

export function windowOf(object: Dispatch | null): WindowNI | null {
  return getNativeInstance<WindowNI>(object, WINDOW_CLASS_ID);
}

/** `TTVPWindowForm`: the window form and its OS window. */
class WindowForm {
  readonly hwnd: WindowsTopLevelWindow;
  ni: WindowNI | null;
  #borderStyle = bsSizeable;
  #focusable = true;
  #closing = false;
  #programClosing = false;
  #canCloseWork = false;
  #inMode = false;
  #modalResult = 0;
  minWidth = 0;
  minHeight = 0;
  maxWidth = 0;
  maxHeight = 0;
  #layerWidth = 32;
  #layerHeight = 32;
  zoomNumer = 1;
  zoomDenom = 1;
  #actualZoomNumer = 1;
  #actualZoomDenom = 1;
  #nextSetWindowHandleToDrawDevice = true;
  readonly #lastSentDrawDeviceDestRect = new TvpRect();
  #fullScreen = false;
  useMouseKey = false;
  trapKeys = false;
  mouseCursorState = mcsVisible;
  #currentMouseCursor = 0;
  defaultImeMode = imClose;
  hintDelay = TOOLTIP_SHOW_DELAY;
  enableTouch = true;
  #paintPosted = false;
  readonly receivers: {proc: number; userdata: number}[] = [];

  constructor(
    private readonly ctx: TvpWindowContext,
    ni: WindowNI,
    parent: WindowNI | null,
  ) {
    this.ni = ni;
    const exStyle = DEFAULT_EX_STYLE | (parent ? WS_EX_CONTROLPARENT : 0);
    this.hwnd = ctx.host.createWindow(
      ctx.title(),
      10,
      10,
      WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
      exStyle,
    );
    this.#hasParent = !!parent;
    this.setBorderStyle(bsSizeable);
  }

  #hasParent: boolean;

  get visible(): boolean {
    return this.hwnd.visible;
  }

  get formEnabled(): boolean {
    return true;
  }

  get windowActive(): boolean {
    return this.hwnd.foreground;
  }

  /** `SetVisible` (`ShowWindow`); showing a window paints it. */
  setVisible(b: boolean): void {
    this.hwnd.setVisible(b);
    if (b) this.invalidate();
  }

  setVisibleFromScript(b: boolean): void {
    if (this.#focusable) this.setVisible(b);
    else this.setVisible(!this.visible ? true : false);
  }

  get caption(): string {
    return this.hwnd.caption;
  }

  setCaption(v: string): void {
    if (this.hwnd.caption !== v) this.hwnd.setCaption(v);
  }

  get borderStyle(): number {
    return this.#borderStyle;
  }

  /** `tTVPWindow::SetBorderStyle`. */
  setBorderStyle(st: number): void {
    const notStyle =
      WS_POPUP |
      WS_CAPTION |
      WS_BORDER |
      WS_THICKFRAME |
      WS_DLGFRAME |
      WS_MINIMIZEBOX |
      WS_MAXIMIZEBOX |
      WS_SYSMENU;
    let style = this.hwnd.style & ~notStyle;
    let exStyle = this.hwnd.exStyle & ~DEFAULT_EX_STYLE;
    if (this.#hasParent) exStyle |= WS_EX_CONTROLPARENT;
    this.#borderStyle = st;
    switch (st) {
      case bsDialog:
        style |= WS_DLGFRAME | WS_POPUP | WS_CAPTION | WS_SYSMENU;
        exStyle |= WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE;
        break;
      case bsSingle:
        style |= WS_CAPTION | WS_BORDER | WS_MINIMIZEBOX | WS_SYSMENU;
        break;
      case bsNone:
        style |= WS_POPUP | WS_MINIMIZEBOX;
        if (this.#hasParent) exStyle |= WS_EX_TOOLWINDOW;
        else style |= WS_SYSMENU;
        break;
      case bsSizeable:
        style |= WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
        break;
      case bsToolWindow:
        style |= WS_CAPTION | WS_BORDER | WS_SYSMENU;
        exStyle |= WS_EX_TOOLWINDOW;
        break;
      case bsSizeToolWin:
        style |= WS_CAPTION | WS_THICKFRAME | WS_SYSMENU;
        exStyle |= WS_EX_TOOLWINDOW;
        break;
      default:
        style = this.hwnd.style;
        exStyle = this.hwnd.exStyle;
    }
    this.hwnd.setStyles(style >>> 0, exStyle >>> 0);
    this.invalidate();
  }

  get left(): number {
    return this.hwnd.windowRect.left;
  }
  get top(): number {
    return this.hwnd.windowRect.top;
  }
  get width(): number {
    const r = this.hwnd.windowRect;
    return r.right - r.left;
  }
  get height(): number {
    const r = this.hwnd.windowRect;
    return r.bottom - r.top;
  }
  get innerWidth(): number {
    return this.hwnd.clientRect.right;
  }
  get innerHeight(): number {
    return this.hwnd.clientRect.bottom;
  }

  #afterResize(): void {
    this.ni?.postResizeEvent();
    this.invalidate();
  }

  setPosition(l: number, t: number): void {
    this.hwnd.setWindowPos(l, t, this.width, this.height);
  }
  setLeft(l: number): void {
    this.setPosition(l, this.top);
  }
  setTop(t: number): void {
    this.setPosition(this.left, t);
  }
  setSize(w: number, h: number): void {
    this.hwnd.setWindowPos(this.left, this.top, w, h);
    this.#afterResize();
  }
  setWidth(w: number): void {
    this.setSize(w, this.height);
  }
  setHeight(h: number): void {
    this.setSize(this.width, h);
  }
  setInnerSize(w: number, h: number): void {
    this.hwnd.setClientSize(w, h);
    this.#afterResize();
  }
  setInnerWidth(w: number): void {
    this.setInnerSize(w, this.innerHeight);
  }
  setInnerHeight(h: number): void {
    this.setInnerSize(this.innerWidth, h);
  }

  get stayOnTop(): boolean {
    return this.hwnd.topMost;
  }
  setStayOnTop(b: boolean): void {
    this.hwnd.setTopMost(b);
  }

  get fullScreenMode(): boolean {
    return this.#fullScreen;
  }

  /** `SetFullScreenMode`: the browser host does not change the display mode. */
  setFullScreenMode(b: boolean): void {
    this.#fullScreen = b;
    this.invalidate();
  }

  get focusable(): boolean {
    return this.#focusable;
  }
  setFocusable(b: boolean): void {
    this.#focusable = b;
  }

  bringToFront(): void {
    this.hwnd.bringToFront();
  }

  /** `AdjustNumerAndDenom` + `SetZoom`. */
  setZoom(numer: number, denom: number, setLogical = true): void {
    let a = numer,
      b = denom;
    while (b) {
      const t = b;
      b = a % b;
      a = t;
    }
    numer = Math.trunc(numer / a);
    denom = Math.trunc(denom / a);
    let changed = false;
    if (setLogical) {
      if (this.zoomNumer !== numer || this.zoomDenom !== denom) changed = true;
      this.zoomNumer = numer;
      this.zoomDenom = denom;
    }
    if (!this.#fullScreen) {
      this.#actualZoomDenom = denom;
      this.#actualZoomNumer = numer;
    }
    this.#setDrawDeviceDestRect();
    if (changed) this.invalidate();
  }

  /** `SetPaintBoxSize`: the primary layer's size. */
  setPaintBoxSize(w: number, h: number): void {
    this.#layerWidth = w;
    this.#layerHeight = h;
    this.#setDrawDeviceDestRect();
  }

  /** `SetDrawDeviceDestRect`. */
  #setDrawDeviceDestRect(): void {
    let w = mulDiv(this.#layerWidth, this.#actualZoomNumer, this.#actualZoomDenom);
    let h = mulDiv(this.#layerHeight, this.#actualZoomNumer, this.#actualZoomDenom);
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    const destrect = new TvpRect(0, 0, w, h);
    if (!this.#lastSentDrawDeviceDestRect.equals(destrect)) {
      const dd = this.ni?.drawDevice;
      if (dd) {
        dd.setClipRectangle(destrect);
        dd.setDestRectangle(destrect);
      }
      this.#lastSentDrawDeviceDestRect.assign(destrect);
    }
  }

  /** `InvalidateRect`: a visible window paints from the message loop. */
  invalidate(): void {
    if (this.#paintPosted || !this.visible) return;
    this.#paintPosted = true;
    this.ctx.postPaint(() => {
      this.#paintPosted = false;
      if (this.visible) this.onPaint();
    });
  }

  /** `OnPaint` (WM_PAINT). */
  onPaint(): void {
    const ni = this.ni;
    if (this.#nextSetWindowHandleToDrawDevice) {
      ni?.drawDevice?.setTargetWindow(this.ctx.host.surfaceOf(this.hwnd), ni.isMainWindow);
      this.#nextSetWindowHandleToDrawDevice = false;
    }
    this.#setDrawDeviceDestRect();
    if (ni) {
      const c = this.hwnd.clientRect;
      ni.notifyWindowExposureToLayer(new TvpRect(0, 0, c.right, c.bottom));
    }
  }

  /** `ResetDrawDevice`. */
  resetDrawDevice(): void {
    this.#nextSetWindowHandleToDrawDevice = true;
    this.#lastSentDrawDeviceDestRect.clear();
    this.invalidate();
  }

  /** `UpdateWindow`. */
  updateWindow(_type: number): number {
    const ni = this.ni;
    if (!ni) return TJS_S_OK;
    ni.notifyWindowExposureToLayer(new TvpRect(0, 0, this.#layerWidth, this.#layerHeight));
    return this.ctx.events.deliverWindowUpdateEvents();
  }

  /** `GetCursorPos` in client coordinates. */
  cursorPos(): {x: number; y: number} {
    return this.ctx.host.cursorPos(this.hwnd);
  }

  setCursorPos(x: number, y: number): void {
    this.ctx.host.setCursorPos?.(this.hwnd, x, y);
  }

  setDefaultMouseCursor(): void {
    if (this.#currentMouseCursor !== 0) {
      this.#currentMouseCursor = 0;
      if (this.mouseCursorState === mcsVisible) this.ctx.host.setCursor?.(this.hwnd, 0, true);
    }
  }

  setMouseCursor(cursor: number): void {
    if (this.#currentMouseCursor !== cursor) {
      this.#currentMouseCursor = cursor;
      if (this.mouseCursorState === mcsVisible) this.ctx.host.setCursor?.(this.hwnd, cursor, true);
    }
  }

  setMouseCursorState(mcs: number): void {
    if (this.mouseCursorState === mcsVisible && mcs !== mcsVisible) {
      this.ctx.host.setCursor?.(this.hwnd, this.#currentMouseCursor, false);
    } else if (this.mouseCursorState !== mcsVisible && mcs === mcsVisible) {
      this.ctx.host.setCursor?.(this.hwnd, this.#currentMouseCursor, true);
    }
    this.mouseCursorState = mcs;
  }

  hideMouseCursor(): void {
    this.setMouseCursorState(mcsTempHidden);
  }

  /** `Close`: closing by the `close` method. */
  close(): void {
    if (this.#closing) return;
    this.#programClosing = true;
    try {
      if (this.#onCloseQuery()) this.#onClose();
    } finally {
      this.#programClosing = false;
    }
  }

  /** `OnCloseQuery`. */
  #onCloseQuery(): boolean {
    const ni = this.ni;
    if (ni && (this.#modalResult === 0 || this.#modalResult === 2) /* mrCancel */) {
      const owner = ni.owner;
      if (!owner) return true;
      if (!this.#programClosing) {
        ni.postCloseInputEvent();
        this.#closing = true;
        return false;
      }
      this.#canCloseWork = true;
      ni.fireNow('onCloseQuery', [bool(true)]);
      return this.#canCloseWork;
    }
    return true;
  }

  /** `OnClose`. */
  #onClose(): void {
    if (!this.#programClosing) return;
    const ni = this.ni;
    if (!ni) return;
    this.setVisible(false);
    const owner = ni.owner;
    ni.notifyWindowClose();
    this.ni = null;
    owner?.invalidate(0, null, owner);
  }

  /** `OnCloseQueryCalled`: the `onCloseQuery` handler allowed (or refused) closing. */
  onCloseQueryCalled(b: boolean): void {
    if (!this.#programClosing) {
      if (b) {
        if (this.#inMode) this.#modalResult = 1;
        else this.setVisible(false);
        this.#closing = false;
        const ni = this.ni;
        if (ni && ni.isMainWindow) {
          const owner = ni.owner;
          owner?.invalidate(0, null, owner);
        }
      } else this.#closing = false;
    } else this.#canCloseWork = b;
  }

  /** `InvalidateClose`: closing by object invalidation. */
  invalidateClose(): void {
    this.ni = null;
    this.setVisible(false);
    this.ctx.host.windowClosed?.(this.hwnd);
  }

  /** The user asked to close the window (the close box): the form's `WM_CLOSE`. */
  userClose(): void {
    if (this.#closing) return;
    if (this.#onCloseQuery()) this.#onClose();
  }

  registerMessageReceiver(mode: number, proc: number, userdata: number): void {
    if (mode === 0) {
      if (!this.receivers.some((r) => r.proc === proc)) this.receivers.push({proc, userdata});
    } else if (mode === 1) {
      for (let i = this.receivers.length - 1; i >= 0; i--)
        if (this.receivers[i]!.proc === proc) this.receivers.splice(i, 1);
    }
  }
}

/** `MulDiv`: `a × b / c` rounded half away from zero, −1 for c = 0. */
function mulDiv(a: number, b: number, c: number): number {
  if (c === 0) return -1;
  const p = a * b;
  const q = Math.abs(p / c);
  const r = Math.floor(q + 0.5);
  return Math.sign(p) * Math.sign(c) < 0 ? -r : r;
}

/** `tTJSNI_Window` (with `tTJSNI_BaseWindow`). */
export class WindowNI extends NativeInstanceBase implements TvpWindowInterface, TvpUpdatableWindow {
  owner: Dispatch | null = null;
  #form: WindowForm | null = null;
  readonly #objectVector: ObjectVariant[] = [];
  #objectVectorLocked = false;
  #drawDeviceObject: Variant = VOID;
  drawDevice: TvpDrawDeviceInterface | null = null;
  #windowUpdating = false;
  waitVSync = false;
  touchScaleThreshold = 5;
  touchRotateThreshold = 5;

  constructor(
    private readonly ctx: TvpWindowContext,
    private readonly list: TvpWindowList,
  ) {
    super();
  }

  override construct(args: readonly Variant[], owner: Dispatch): number {
    this.owner = owner;
    this.list.register(this);
    const dd = this.ctx.createDefaultDrawDevice();
    try {
      this.setDrawDeviceObject(obj(dd, dd));
    } finally {
      dd.release();
    }
    let parent: WindowNI | null = null;
    if (args.length >= 1 && args[0]!.type === 1) {
      const clo = asObjectClosure(args[0]!);
      if (clo.object) {
        parent = windowOf(clo.object);
        if (!parent) throwTjsError('TVPSpecifyWindow');
      }
    }
    this.#form = new WindowForm(this.ctx, this, parent);
    return TJS_S_OK;
  }

  override invalidate(): void {
    const events = this.ctx.events;
    this.list.unregister(this, this.ctx);
    if (this.owner) events.cancelSourceEvents(this.owner);
    events.cancelInputEvents(this);
    events.removeWindowUpdate(this);
    this.#objectVectorLocked = true;
    for (const clo of this.#objectVector.splice(0)) {
      try {
        clo.object?.invalidate(0, null, clo.objthis ?? clo.object);
      } finally {
        releaseVariant(clo);
      }
    }
    if (this.owner) events.cancelSourceEvents(this.owner);
    events.cancelInputEvents(this);
    events.removeWindowUpdate(this);
    this.setDrawDeviceObject(VOID);
    if (this.#form) {
      this.#form.invalidateClose();
      this.#form = null;
    }
    if (this.owner) events.cancelSourceEvents(this.owner);
    events.cancelInputEvents(this);
    this.owner = null;
  }

  get form(): WindowForm | null {
    return this.#form;
  }

  get isMainWindow(): boolean {
    return this.list.mainWindow === this;
  }

  /** `CanDeliverEvents`. */
  get canDeliverEvents(): boolean {
    return !!this.#form && this.#form.visible && this.#form.formEnabled;
  }

  notifyWindowClose(): void {
    this.#form = null;
  }

  /** An immediate event to the window object, run without suspension. */
  fireNow(name: string, args: readonly Variant[] = []): void {
    const owner = this.owner;
    if (!owner) return;
    this.ctx.suspender.nonSuspending(() =>
      this.ctx.events.postEvent(owner, owner, name, 0, TVP_EPT_IMMEDIATE, args),
    );
  }

  #post(name: string, args: readonly Variant[] = [], flags = TVP_EPT_IMMEDIATE): number {
    const owner = this.owner;
    if (!owner) return TJS_S_OK;
    return this.ctx.events.postEvent(owner, owner, name, 0, flags, args);
  }

  // --- draw device ---------------------------------------------------------------------------

  get drawDeviceObject(): Variant {
    return this.#drawDeviceObject;
  }

  /** `SetDrawDeviceObject`. */
  setDrawDeviceObject(val: Variant): void {
    const old = this.#drawDeviceObject;
    if (old.type === 1 && old.object) old.object.invalidate(0, null, old.object);
    addRefVariant(val);
    this.#drawDeviceObject = val;
    releaseVariant(old);
    this.drawDevice = null;
    if (val.type === 1 && val.object) {
      const slot = new VariantSlot();
      let device: TvpDrawDeviceInterface | null;
      try {
        if (failed(val.object.propGet(0, 'interface', slot, val.objthis ?? val.object)))
          throwTjsError('TVPCannotRetriveInterfaceFromDrawDevice');
        device = this.ctx.memory.objectAt<TvpDrawDeviceInterface>(Number(asInteger(slot.value)));
      } finally {
        slot.clear();
      }
      if (!device) throwTjsError('TVPCannotRetriveInterfaceFromDrawDevice');
      this.drawDevice = device;
      device.setWindowInterface(this);
      this.resetDrawDevice();
    }
  }

  resetDrawDevice(): void {
    this.#form?.resetDrawDevice();
  }

  // --- input events (from the host, via input events) ----------------------------------------

  /** `OnClose`: the user asked to close the window. */
  onClose(): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    return this.#post('onCloseQuery', [bool(true)]);
  }

  postCloseInputEvent(): void {
    this.ctx.events.postInputEvent(
      {source: this, tag: 'onClose', deliver: () => this.onClose()},
      0,
    );
  }

  postResizeEvent(): void {
    this.ctx.events.postInputEvent(
      {source: this, tag: 'onResize', deliver: () => this.onResize()},
      0,
    );
  }

  onResize(): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    return this.#post('onResize');
  }

  onClick(x: number, y: number): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    const hr = this.#post('onClick', [int(x), int(y)]);
    if (failed(hr)) return hr;
    return this.drawDevice ? this.drawDevice.onClick(x, y) : TJS_S_OK;
  }

  onMouseDown(x: number, y: number, mb: number, flags: number): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    const hr = this.#post('onMouseDown', [
      int(x),
      int(y),
      integer(BigInt(mb)),
      integer(BigInt(flags >>> 0)),
    ]);
    if (failed(hr)) return hr;
    return this.drawDevice ? this.drawDevice.onMouseDown(x, y, mb, flags) : TJS_S_OK;
  }

  onMouseUp(x: number, y: number, mb: number, flags: number): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    const hr = this.#post('onMouseUp', [int(x), int(y), int(mb), int(flags)]);
    if (failed(hr)) return hr;
    return this.drawDevice ? this.drawDevice.onMouseUp(x, y, mb, flags) : TJS_S_OK;
  }

  onMouseMove(x: number, y: number, flags: number): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    const hr = this.#post(
      'onMouseMove',
      [int(x), int(y), integer(BigInt(flags >>> 0))],
      TVP_EPT_DISCARDABLE | TVP_EPT_IMMEDIATE,
    );
    if (failed(hr)) return hr;
    return this.drawDevice ? this.drawDevice.onMouseMove(x, y, flags) : TJS_S_OK;
  }

  onKeyDown(key: number, shift: number): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    const hr = this.#post('onKeyDown', [int(key), int(shift)]);
    if (failed(hr)) return hr;
    return this.drawDevice ? this.drawDevice.onKeyDown(key, shift) : TJS_S_OK;
  }

  onKeyUp(key: number, shift: number): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    const hr = this.#post('onKeyUp', [int(key), int(shift)]);
    if (failed(hr)) return hr;
    return this.drawDevice ? this.drawDevice.onKeyUp(key, shift) : TJS_S_OK;
  }

  onKeyPress(key: number): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    const hr = this.#post('onKeyPress', [str(String.fromCharCode(key))]);
    if (failed(hr)) return hr;
    return this.drawDevice ? this.drawDevice.onKeyPress(key) : TJS_S_OK;
  }

  onMouseWheel(shift: number, delta: number, x: number, y: number): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    const hr = this.#post('onMouseWheel', [int(shift), int(delta), int(x), int(y)]);
    if (failed(hr)) return hr;
    return this.drawDevice ? this.drawDevice.onMouseWheel(shift, delta, x, y) : TJS_S_OK;
  }

  onActivate(activate: boolean): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    if ((this.#form?.windowActive ?? false) !== activate) return TJS_S_OK;
    return this.#post(activate ? 'onActivate' : 'onDeactivate');
  }

  postReleaseCaptureEvent(): void {
    this.ctx.events.postInputEvent(
      {source: this, tag: 'onReleaseCapture', deliver: () => this.onReleaseCapture()},
      0,
    );
  }

  onReleaseCapture(): number {
    if (!this.canDeliverEvents) return TJS_S_OK;
    this.drawDevice?.onReleaseCapture();
    return TJS_S_OK;
  }

  /** `layerTreeOwnerInterface`: the window as the owner of its layer trees. */
  readonly layerTreeOwner: TvpLayerTreeOwner = new WindowLayerTreeOwner(this);

  setMouseCursor(cursor: number): void {
    this.#form?.setMouseCursor(cursor);
  }

  getCursorPos(): {x: number; y: number} {
    return this.#form ? this.#form.cursorPos() : {x: 0, y: 0};
  }

  setCursorPos(x: number, y: number): void {
    this.#form?.setCursorPos(x, y);
  }

  setAttentionPoint(_layer: object, _l: number, _t: number): void {}

  disableAttentionPoint(): void {}

  setImeMode(_mode: number): void {}

  resetImeMode(): void {}

  // --- window interface (draw device → window) ----------------------------------------------

  notifySrcResize(): void {
    if (this.#windowUpdating) throwTjsError('TVPInvalidMethodInUpdating');
    const {w, h} = this.drawDevice!.getSrcSize();
    this.#form?.setPaintBoxSize(w, h);
  }

  setDefaultMouseCursor(): void {
    this.#form?.setDefaultMouseCursor();
  }

  windowReleaseCapture(): void {}

  setHintText(_sender: unknown, _text: string): void {}

  requestUpdate(): void {
    this.ctx.events.postWindowUpdate(this);
  }

  notifyWindowExposureToLayer(cliprect: TvpRect): void {
    this.drawDevice?.requestInvalidation(cliprect);
  }

  /** `UpdateContent`: completes the update region onto the draw device and shows it. */
  updateContent(): number {
    const dd = this.drawDevice;
    if (dd) {
      dd.update();
      if (!this.waitVSync) dd.show();
      this.#windowUpdating = false;
    }
    return TJS_S_OK;
  }

  dumpPrimaryLayerStructure(): void {
    this.drawDevice?.dumpLayerStructure();
  }

  recheckInputState(): number {
    return this.drawDevice ? this.drawDevice.recheckInputState() : TJS_S_OK;
  }

  // --- object vector -------------------------------------------------------------------------

  add(clo: ObjectVariant): void {
    if (this.#objectVectorLocked) return;
    if (this.#objectVector.some((c) => c.object === clo.object && c.objthis === clo.objthis))
      return;
    addRefVariant(clo);
    this.#objectVector.push(clo);
  }

  remove(clo: ObjectVariant): void {
    if (this.#objectVectorLocked) return;
    const i = this.#objectVector.findIndex(
      (c) => c.object === clo.object && c.objthis === clo.objthis,
    );
    if (i < 0) return;
    releaseVariant(this.#objectVector[i]!);
    this.#objectVector.splice(i, 1);
  }

  // --- form access ---------------------------------------------------------------------------

  #fullScreenGuard(): void {
    if (this.#form?.fullScreenMode) throwTjsError('TVPInvalidPropertyInFullScreen');
  }

  close(): void {
    this.#form?.close();
  }

  onCloseQueryCalled(b: boolean): void {
    this.#form?.onCloseQueryCalled(b);
  }

  bringToFront(): void {
    this.#form?.bringToFront();
  }

  update(type: number): number {
    return this.#form ? this.#form.updateWindow(type) : TJS_S_OK;
  }

  hideMouseCursor(): void {
    this.#form?.hideMouseCursor();
  }

  get visible(): boolean {
    return this.#form ? this.#form.visible : false;
  }

  setVisible(b: boolean): void {
    this.#fullScreenGuard();
    this.#form?.setVisibleFromScript(b);
  }

  get caption(): string {
    return this.#form ? this.#form.caption : '';
  }

  setCaption(v: string): void {
    this.#form?.setCaption(v);
  }

  #guarded<T>(fn: (f: WindowForm) => T): void {
    this.#fullScreenGuard();
    if (this.#form) fn(this.#form);
  }

  get width(): number {
    return this.#form?.width ?? 0;
  }
  setWidth(w: number): void {
    this.#guarded((f) => f.setWidth(w));
  }
  get height(): number {
    return this.#form?.height ?? 0;
  }
  setHeight(h: number): void {
    this.#guarded((f) => f.setHeight(h));
  }
  get left(): number {
    return this.#form?.left ?? 0;
  }
  setLeft(l: number): void {
    this.#guarded((f) => f.setLeft(l));
  }
  get top(): number {
    return this.#form?.top ?? 0;
  }
  setTop(t: number): void {
    this.#guarded((f) => f.setTop(t));
  }
  setSize(w: number, h: number): void {
    this.#guarded((f) => f.setSize(w, h));
  }
  setPosition(l: number, t: number): void {
    this.#guarded((f) => f.setPosition(l, t));
  }
  get minWidth(): number {
    return this.#form?.minWidth ?? 0;
  }
  setMinWidth(v: number): void {
    this.#guarded((f) => (f.minWidth = v));
  }
  get minHeight(): number {
    return this.#form?.minHeight ?? 0;
  }
  setMinHeight(v: number): void {
    this.#guarded((f) => (f.minHeight = v));
  }
  setMinSize(w: number, h: number): void {
    this.#guarded((f) => {
      f.minWidth = w;
      f.minHeight = h;
    });
  }
  get maxWidth(): number {
    return this.#form?.maxWidth ?? 0;
  }
  setMaxWidth(v: number): void {
    this.#guarded((f) => (f.maxWidth = v));
  }
  get maxHeight(): number {
    return this.#form?.maxHeight ?? 0;
  }
  setMaxHeight(v: number): void {
    this.#guarded((f) => (f.maxHeight = v));
  }
  setMaxSize(w: number, h: number): void {
    this.#guarded((f) => {
      f.maxWidth = w;
      f.maxHeight = h;
    });
  }
  get innerWidth(): number {
    return this.#form?.innerWidth ?? 0;
  }
  setInnerWidth(w: number): void {
    this.#guarded((f) => f.setInnerWidth(w));
  }
  get innerHeight(): number {
    return this.#form?.innerHeight ?? 0;
  }
  setInnerHeight(h: number): void {
    this.#guarded((f) => f.setInnerHeight(h));
  }
  setInnerSize(w: number, h: number): void {
    this.#guarded((f) => f.setInnerSize(w, h));
  }
  get borderStyle(): number {
    return this.#form?.borderStyle ?? bsNone;
  }
  setBorderStyle(st: number): void {
    this.#guarded((f) => f.setBorderStyle(st));
  }
  get stayOnTop(): boolean {
    return this.#form?.stayOnTop ?? false;
  }
  setStayOnTop(b: boolean): void {
    this.#form?.setStayOnTop(b);
  }
  get fullScreen(): boolean {
    return this.#form?.fullScreenMode ?? false;
  }
  setFullScreen(b: boolean): void {
    this.#form?.setFullScreenMode(b);
  }
  get useMouseKey(): boolean {
    return this.#form?.useMouseKey ?? false;
  }
  setUseMouseKey(b: boolean): void {
    if (this.#form) this.#form.useMouseKey = b;
  }
  get trapKey(): boolean {
    return this.#form?.trapKeys ?? false;
  }
  setTrapKey(b: boolean): void {
    if (this.#form) this.#form.trapKeys = b;
  }
  get mouseCursorState(): number {
    return this.#form?.mouseCursorState ?? mcsVisible;
  }
  setMouseCursorState(mcs: number): void {
    this.#form?.setMouseCursorState(mcs);
  }
  get focusable(): boolean {
    return this.#form?.focusable ?? false;
  }
  setFocusable(b: boolean): void {
    this.#form?.setFocusable(b);
  }
  setZoom(numer: number, denom: number): void {
    this.#guarded((f) => f.setZoom(numer, denom));
  }
  get zoomNumer(): number {
    return this.#form?.zoomNumer ?? 1;
  }
  setZoomNumer(n: number): void {
    this.#guarded((f) => f.setZoom(n, f.zoomDenom));
  }
  get zoomDenom(): number {
    return this.#form?.zoomDenom ?? 1;
  }
  setZoomDenom(d: number): void {
    this.#guarded((f) => f.setZoom(f.zoomNumer, d));
  }
  get defaultImeMode(): number {
    return this.#form?.defaultImeMode ?? imClose;
  }
  setDefaultImeMode(mode: number): void {
    if (this.#form) this.#form.defaultImeMode = mode;
  }
  get hintDelay(): number {
    return this.#form?.hintDelay ?? 0;
  }
  setHintDelay(d: number): void {
    if (this.#form) this.#form.hintDelay = d;
  }
  get enableTouch(): boolean {
    return this.#form?.enableTouch ?? false;
  }
  setEnableTouch(b: boolean): void {
    if (this.#form) this.#form.enableTouch = b;
  }
  registerMessageReceiver(mode: number, proc: number, userdata: number): void {
    this.#form?.registerMessageReceiver(mode, proc, userdata);
  }
  /** The `HWND` property: the window's handle in the core memory. */
  get hwndHandle(): number {
    return this.#form ? this.ctx.memory.handleOf(this.#form.hwnd) : 0;
  }

  /** `PostInputEvent`. */
  postInputEvent(name: string, params: Dispatch | null): void {
    if (!this.#form) return;
    let type: 'down' | 'up' | 'press';
    if (name === 'onKeyDown') type = 'down';
    else if (name === 'onKeyUp') type = 'up';
    else if (name === 'onKeyPress') type = 'press';
    else throwTjsError('TVPSpecifiedEventNameIsUnknown', name);
    if (!params) throwTjsError('TVPSpecifiedEventNeedsParameter', name);
    const read = (member: string): number => {
      const slot = new VariantSlot();
      try {
        if (failed(params.propGet(0, member, slot, params)))
          throwTjsError('TVPSpecifiedEventNeedsParameter2', name, member);
        return Number(BigInt.asIntN(32, asInteger(slot.value)));
      } finally {
        slot.clear();
      }
    };
    const key = read('key');
    if (type === 'press') {
      const k = key & 0xff;
      this.ctx.events.postInputEvent(
        {source: this, tag: 'onKeyPress', deliver: () => this.onKeyPress(k)},
        0,
      );
      return;
    }
    const shift = read('shift');
    const k = key & 0xffff;
    this.ctx.events.postInputEvent(
      {
        source: this,
        tag: type === 'down' ? 'onKeyDown' : 'onKeyUp',
        deliver: () => (type === 'down' ? this.onKeyDown(k, shift) : this.onKeyUp(k, shift)),
      },
      0,
    );
  }
}

/** `iTVPLayerTreeOwner` of a window: every call goes to the window's draw device. */
class WindowLayerTreeOwner implements TvpLayerTreeOwner {
  constructor(private readonly w: WindowNI) {}
  #dd(): TvpDrawDeviceInterface | null {
    return this.w.drawDevice;
  }
  getOwnerNoAddRef(): Dispatch | null {
    return this.w.owner;
  }
  registerLayerManager(m: TvpLayerManagerInterface): void {
    this.#dd()?.addLayerManager(m as LM);
  }
  unregisterLayerManager(m: TvpLayerManagerInterface): void {
    this.#dd()?.removeLayerManager(m as LM);
  }
  startBitmapCompletion(m: TvpLayerManagerInterface): void {
    this.#dd()?.startBitmapCompletion(m as LM);
  }
  notifyBitmapCompleted(
    m: TvpLayerManagerInterface,
    x: number,
    y: number,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
    type: number,
    opacity: number,
  ): void {
    this.#dd()?.notifyBitmapCompleted(m as LM, x, y, bmp, cliprect, type, opacity);
  }
  endBitmapCompletion(m: TvpLayerManagerInterface): void {
    this.#dd()?.endBitmapCompletion(m as LM);
  }
  setMouseCursor(m: TvpLayerManagerInterface, cursor: number): void {
    const dd = this.#dd();
    if (!dd) return;
    if (cursor === 0) dd.setDefaultMouseCursor(m as LM);
    else dd.setMouseCursor(m as LM, cursor);
  }
  getCursorPos(m: TvpLayerManagerInterface): {x: number; y: number} {
    return this.#dd()?.getCursorPos(m as LM) ?? {x: 0, y: 0};
  }
  setCursorPos(m: TvpLayerManagerInterface, x: number, y: number): void {
    this.#dd()?.setCursorPos(m as LM, x, y);
  }
  releaseMouseCapture(m: TvpLayerManagerInterface): void {
    this.#dd()?.windowReleaseCapture(m as LM);
  }
  setHint(m: TvpLayerManagerInterface, sender: Dispatch | null, hint: string): void {
    this.#dd()?.setHintText(m as LM, sender, hint);
  }
  notifyLayerResize(m: TvpLayerManagerInterface): void {
    this.#dd()?.notifyLayerResize(m as LM);
  }
  notifyLayerImageChange(m: TvpLayerManagerInterface): void {
    this.#dd()?.notifyLayerImageChange(m as LM);
  }
  setAttentionPoint(m: TvpLayerManagerInterface, layer: object, x: number, y: number): void {
    this.#dd()?.setAttentionPoint(m as LM, layer, x, y);
  }
  disableAttentionPoint(m: TvpLayerManagerInterface): void {
    this.#dd()?.disableAttentionPoint(m as LM);
  }
  setImeMode(m: TvpLayerManagerInterface, mode: number): void {
    this.#dd()?.setImeMode(m as LM, mode);
  }
  resetImeMode(m: TvpLayerManagerInterface): void {
    this.#dd()?.resetImeMode(m as LM);
  }
}

type LM = TvpLayerManagerInterface<LayerNI>;
