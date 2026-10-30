/**
 * A Win32 top-level window as a game sees it: the window rectangle (`GetWindowRect`), the
 * client rectangle derived from the style (`AdjustWindowRectEx`), the minimum tracking size
 * `SetWindowPos` enforces, visibility, caption, top-most state and foreground state.
 *
 * Frame metrics are those Windows reports to an executable with subsystem version 5.x at
 * 96 DPI (no padded border): sizing frame 4, fixed frame 3, border 1, caption 23 (small caption
 * 23), minimum tracking size 136×39.
 *
 * The window decides nothing about the page. A host (`WindowsTopLevelWindowHost`) mirrors its
 * state into the page: a browser host shows the client area where the game draws, a headless
 * host keeps the state only.
 */

export const WS_OVERLAPPED = 0x00000000;
export const WS_POPUP = 0x80000000;
export const WS_CHILD = 0x40000000;
export const WS_MINIMIZE = 0x20000000;
export const WS_VISIBLE = 0x10000000;
export const WS_CLIPCHILDREN = 0x02000000;
export const WS_MAXIMIZE = 0x01000000;
export const WS_BORDER = 0x00800000;
export const WS_DLGFRAME = 0x00400000;
export const WS_CAPTION = WS_BORDER | WS_DLGFRAME;
export const WS_SYSMENU = 0x00080000;
export const WS_THICKFRAME = 0x00040000;
export const WS_MINIMIZEBOX = 0x00020000;
export const WS_MAXIMIZEBOX = 0x00010000;
export const WS_OVERLAPPEDWINDOW =
  WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;

export const WS_EX_DLGMODALFRAME = 0x00000001;
export const WS_EX_TOPMOST = 0x00000008;
export const WS_EX_ACCEPTFILES = 0x00000010;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_WINDOWEDGE = 0x00000100;
export const WS_EX_CLIENTEDGE = 0x00000200;
export const WS_EX_CONTROLPARENT = 0x00010000;
export const WS_EX_APPWINDOW = 0x00040000;

/** `GetSystemMetrics` values that frame computations use. */
export interface WindowsFrameMetrics {
  readonly sizeFrame: number;
  readonly fixedFrame: number;
  readonly border: number;
  readonly edge: number;
  readonly caption: number;
  readonly smallCaption: number;
  readonly menu: number;
  readonly minTrackWidth: number;
  readonly minTrackHeight: number;
}

export const LEGACY_SUBSYSTEM_FRAME_METRICS: WindowsFrameMetrics = {
  sizeFrame: 4,
  fixedFrame: 3,
  border: 1,
  edge: 2,
  caption: 23,
  smallCaption: 23,
  menu: 20,
  minTrackWidth: 136,
  minTrackHeight: 39,
};

/** A rectangle with exclusive right and bottom. */
export interface WindowsRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `AdjustWindowRectEx`: the window rectangle of a client rectangle. */
export function adjustWindowRectEx(
  rect: WindowsRect,
  style: number,
  menu: boolean,
  exStyle: number,
  m: WindowsFrameMetrics = LEGACY_SUBSYSTEM_FRAME_METRICS,
): WindowsRect {
  let frame = 0;
  if (style & WS_THICKFRAME) frame = m.sizeFrame;
  else if (style & WS_DLGFRAME || exStyle & WS_EX_DLGMODALFRAME) frame = m.fixedFrame;
  else if (style & WS_BORDER) frame = m.border;
  if (exStyle & WS_EX_CLIENTEDGE) frame += m.edge;
  let top = frame;
  if ((style & WS_CAPTION) === WS_CAPTION)
    top += exStyle & WS_EX_TOOLWINDOW ? m.smallCaption : m.caption;
  if (menu) top += m.menu;
  return {
    left: rect.left - frame,
    top: rect.top - top,
    right: rect.right + frame,
    bottom: rect.bottom + frame,
  };
}

/** Mirrors a window's state into the host page. Every member is optional. */
export interface WindowsTopLevelWindowHost {
  /** The window was shown or hidden. */
  visibilityChanged?(visible: boolean): void;
  captionChanged?(caption: string): void;
  /** The window rectangle or the client size changed. */
  boundsChanged?(window: WindowsRect, clientWidth: number, clientHeight: number): void;
  topMostChanged?(topMost: boolean): void;
  /** Bring the window to the front; returns whether it became the foreground window. */
  bringToFront?(): boolean;
}

/** The window state behind an `HWND`. */
export class WindowsTopLevelWindow {
  #style: number;
  #exStyle: number;
  #rect: WindowsRect;
  #visible = false;
  #caption: string;
  #foreground = false;
  #menu = false;

  constructor(
    caption: string,
    clientWidth: number,
    clientHeight: number,
    style: number,
    exStyle: number,
    private readonly host: WindowsTopLevelWindowHost = {},
    private readonly metrics: WindowsFrameMetrics = LEGACY_SUBSYSTEM_FRAME_METRICS,
    /** `CW_USEDEFAULT` position. */
    position: {x: number; y: number} = {x: 0, y: 0},
  ) {
    this.#caption = caption;
    this.#style = style;
    this.#exStyle = exStyle;
    const r = adjustWindowRectEx(
      {left: 0, top: 0, right: clientWidth, bottom: clientHeight},
      style,
      false,
      exStyle,
      metrics,
    );
    this.#rect = {left: position.x, top: position.y, right: position.x, bottom: position.y};
    this.#setSize(r.right - r.left, r.bottom - r.top);
  }

  get style(): number {
    return this.#style;
  }
  get exStyle(): number {
    return this.#exStyle;
  }

  /** `SetWindowLong(GWL_STYLE)` + `SetWindowLong(GWL_EXSTYLE)` + `SWP_FRAMECHANGED`. */
  setStyles(style: number, exStyle: number): void {
    this.#style = style;
    this.#exStyle = exStyle;
    this.#notifyBounds();
  }

  /** `GetWindowRect`. */
  get windowRect(): WindowsRect {
    return {...this.#rect};
  }

  #frame(): WindowsRect {
    return adjustWindowRectEx(
      {left: 0, top: 0, right: 0, bottom: 0},
      this.#style,
      this.#menu,
      this.#exStyle,
      this.metrics,
    );
  }

  /** `GetClientRect` (origin 0, 0). */
  get clientRect(): WindowsRect {
    const f = this.#frame();
    const w = this.#rect.right - this.#rect.left - (f.right - f.left);
    const h = this.#rect.bottom - this.#rect.top - (f.bottom - f.top);
    return {left: 0, top: 0, right: Math.max(0, w), bottom: Math.max(0, h)};
  }

  /** The client area's origin in screen coordinates (`ClientToScreen` of 0, 0). */
  get clientOrigin(): {x: number; y: number} {
    const f = this.#frame();
    return {x: this.#rect.left - f.left, y: this.#rect.top - f.top};
  }

  /** The minimum tracking size applies to windows with a caption or a sizing frame. */
  #setSize(w: number, h: number): void {
    if ((this.#style & WS_CAPTION) === WS_CAPTION || this.#style & WS_THICKFRAME) {
      w = Math.max(w, this.metrics.minTrackWidth);
      h = Math.max(h, this.metrics.minTrackHeight);
    }
    this.#rect.right = this.#rect.left + w;
    this.#rect.bottom = this.#rect.top + h;
  }

  /** `SetWindowPos` without z-order changes. */
  setWindowPos(x: number, y: number, w: number, h: number): void {
    this.#rect.left = x;
    this.#rect.top = y;
    this.#setSize(w, h);
    this.#notifyBounds();
  }

  /** `AdjustWindowRectEx` + `SetWindowPos` (`SetClientSize`). */
  setClientSize(w: number, h: number): void {
    const r = adjustWindowRectEx(
      {left: 0, top: 0, right: w, bottom: h},
      this.#style,
      this.#menu,
      this.#exStyle,
      this.metrics,
    );
    this.setWindowPos(this.#rect.left, this.#rect.top, r.right - r.left, r.bottom - r.top);
  }

  #notifyBounds(): void {
    const c = this.clientRect;
    this.host.boundsChanged?.(this.windowRect, c.right, c.bottom);
  }

  /** `IsWindowVisible`. */
  get visible(): boolean {
    return this.#visible;
  }

  /** `ShowWindow(SW_SHOW / SW_HIDE)`. */
  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    if (visible) this.#foreground = true;
    this.host.visibilityChanged?.(visible);
  }

  get caption(): string {
    return this.#caption;
  }

  /** `SetWindowText`. */
  setCaption(caption: string): void {
    this.#caption = caption;
    this.host.captionChanged?.(caption);
  }

  get topMost(): boolean {
    return (this.#exStyle & WS_EX_TOPMOST) !== 0;
  }

  /** `SetWindowPos(HWND_TOPMOST / HWND_NOTOPMOST)`. */
  setTopMost(b: boolean): void {
    this.#exStyle = b ? this.#exStyle | WS_EX_TOPMOST : this.#exStyle & ~WS_EX_TOPMOST;
    this.host.topMostChanged?.(b);
  }

  /** `GetForegroundWindow() == hwnd`. */
  get foreground(): boolean {
    return this.#foreground;
  }

  setForeground(b: boolean): void {
    this.#foreground = b;
  }

  bringToFront(): void {
    this.#visible = true;
    if (this.host.bringToFront?.() ?? true) this.#foreground = true;
  }
}
