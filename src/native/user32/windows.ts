/**
 * The window manager of `user32.dll`: window classes, the window tree, window procedures,
 * messages, window longs and properties, geometry, visibility, enabling and focus.
 *
 * A top-level window keeps its frame geometry, visibility, caption and top-most state in a
 * platform `WindowsTopLevelWindow` from the host; a child window keeps its rectangle in its
 * parent's client coordinates. Messages run synchronously through the window's current
 * procedure; posted messages run from the host's message loop.
 */
import {
  readWideString,
  writeWideString,
  type NativeProcess,
} from '../../platform/native-process.js';
import {
  adjustWindowRectEx,
  type WindowsTopLevelWindow,
} from '../../platform/windows-top-level-window.js';
import type {
  WindowsUserInterfaceHost,
  WindowsUserWindowView,
} from '../../platform/windows-user-interface.js';
import type {Kernel32Exports} from '../kernel32/contract.js';
import {
  ERROR_CANNOT_FIND_WND_CLASS,
  ERROR_CLASS_ALREADY_EXISTS,
  ERROR_INVALID_INDEX,
  ERROR_INVALID_PARAMETER,
  ERROR_INVALID_WINDOW_HANDLE,
  GWL_EXSTYLE,
  GWL_HINSTANCE,
  GWL_HWNDPARENT,
  GWL_ID,
  GWL_STYLE,
  GWL_USERDATA,
  GWL_WNDPROC,
  HWND_NOTOPMOST,
  HWND_TOPMOST,
  SW_HIDE,
  SW_MINIMIZE,
  SW_RESTORE,
  SW_SHOWMAXIMIZED,
  SW_SHOWMINIMIZED,
  SW_SHOWMINNOACTIVE,
  SW_SHOWNA,
  SW_SHOWNOACTIVATE,
  SWP_FRAMECHANGED,
  SWP_HIDEWINDOW,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  SWP_SHOWWINDOW,
  WM_CLOSE,
  WM_CREATE,
  WM_DESTROY,
  WM_ENABLE,
  WM_GETTEXT,
  WM_GETTEXTLENGTH,
  WM_KILLFOCUS,
  WM_MOVE,
  WM_NCCREATE,
  WM_NCDESTROY,
  WM_SETFOCUS,
  WM_SETICON,
  WM_SETTEXT,
  WM_SHOWWINDOW,
  WM_SIZE,
  WM_SYSCOMMAND,
  WM_WINDOWPOSCHANGED,
  WM_WINDOWPOSCHANGING,
  WS_CHILD,
  WS_DISABLED,
  WS_EX_TOPMOST,
  WS_MAXIMIZE,
  WS_MINIMIZE,
  WS_VISIBLE,
  type Point,
  type Rect,
  type WindowClassEx,
  type WindowProcedure,
} from './contract.js';

export const CW_USEDEFAULT = 0x80000000 | 0;
const SC_CLOSE = 0xf060;
const SIZE_RESTORED = 0;
const SIZE_MINIMIZED = 1;
const SIZE_MAXIMIZED = 2;
const ICON_BIG = 1;
const WM_STYLECHANGING = 0x007c;
const WM_STYLECHANGED = 0x007d;
const WM_PARENTNOTIFY = 0x0210;
const WS_EX_NOPARENTNOTIFY = 0x00000004;
const GWL_STYLE_FLAGS = new Set([GWL_STYLE, GWL_EXSTYLE]);

/** A registered window class. */
export interface WindowClass extends WindowClassEx {
  readonly atom: number;
  /** System classes are global and cannot be unregistered. */
  readonly system: boolean;
}

/** One window. */
export class Window {
  style: number;
  exStyle: number;
  text: string;
  parent: Window | null;
  owner: Window | null;
  /** Children, top of the z-order first. */
  readonly children: Window[] = [];
  /** Child id (`GWL_ID`) or the menu of a top-level window. */
  id: number;
  proc: WindowProcedure;
  userData = 0;
  readonly extra: DataView;
  readonly props = new Map<string, number>();
  /** Child windows: the window rectangle in the parent's client coordinates. */
  rect: Rect = {left: 0, top: 0, right: 0, bottom: 0};
  readonly top: WindowsTopLevelWindow | null;
  smallIcon = 0;
  bigIcon = 0;
  destroyed = false;
  /** State of a built-in control or a dialog, by its procedure. */
  state: unknown = null;

  constructor(
    readonly hwnd: number,
    readonly cls: WindowClass,
    readonly instance: number,
    init: {
      style: number;
      exStyle: number;
      text: string;
      parent: Window | null;
      owner: Window | null;
      id: number;
      top: WindowsTopLevelWindow | null;
    },
  ) {
    this.style = init.style >>> 0;
    this.exStyle = init.exStyle >>> 0;
    this.text = init.text;
    this.parent = init.parent;
    this.owner = init.owner;
    this.id = init.id;
    this.top = init.top;
    this.proc = cls.wndProc;
    this.extra = new DataView(new ArrayBuffer(Math.max(0, cls.wndExtra)));
  }

  get isChild(): boolean {
    return (this.style & WS_CHILD) !== 0;
  }
}

/** `CREATESTRUCTW` offsets. */
const CS_SIZE = 48;

export class WindowManager {
  readonly #classes = new Map<string, WindowClass>();
  readonly #classByAtom = new Map<number, WindowClass>();
  readonly #windows = new Map<number, Window>();
  /** Top-level windows, top of the z-order first. */
  readonly topLevel: Window[] = [];
  #nextHandle = 0x00010000;
  #nextAtom = 0xc000;
  /** Called with a new window before `WM_NCCREATE` (the dialog manager's setup). */
  creationHook: ((w: Window) => void) | null = null;
  focus: Window | null = null;
  active: Window | null = null;
  #locked: Window | null = null;

  constructor(
    readonly process: NativeProcess,
    readonly host: WindowsUserInterfaceHost,
    readonly kernel32: Kernel32Exports,
  ) {}

  setError(code: number): void {
    this.kernel32.SetLastError(code);
  }

  // --- classes ------------------------------------------------------------------------------

  /** Registers a class; system classes get the given atom. */
  registerClass(cls: WindowClassEx, system = false, atom?: number): number {
    const key = cls.className.toLowerCase();
    if (this.#classes.has(key)) {
      this.setError(ERROR_CLASS_ALREADY_EXISTS);
      return 0;
    }
    const record: WindowClass = {...cls, atom: atom ?? this.#nextAtom++, system};
    this.#classes.set(key, record);
    this.#classByAtom.set(record.atom, record);
    return record.atom;
  }

  unregisterClass(name: string): boolean {
    const record = this.#classes.get(name.toLowerCase());
    if (!record || record.system) {
      this.setError(ERROR_CANNOT_FIND_WND_CLASS);
      return false;
    }
    this.#classes.delete(name.toLowerCase());
    this.#classByAtom.delete(record.atom);
    return true;
  }

  findClass(name: string | number): WindowClass | null {
    return typeof name === 'number'
      ? (this.#classByAtom.get(name & 0xffff) ?? null)
      : (this.#classes.get(name.toLowerCase()) ?? null);
  }

  // --- windows ------------------------------------------------------------------------------

  /** The window of a handle, or null with `ERROR_INVALID_WINDOW_HANDLE`. */
  get(hwnd: number): Window | null {
    const w = this.#windows.get(hwnd >>> 0);
    if (!w || w.destroyed) {
      this.setError(ERROR_INVALID_WINDOW_HANDLE);
      return null;
    }
    return w;
  }

  /** The window of a handle without setting the last error. */
  peek(hwnd: number): Window | null {
    const w = this.#windows.get(hwnd >>> 0);
    return w && !w.destroyed ? w : null;
  }

  view(w: Window): WindowsUserWindowView {
    const r = this.windowRect(w);
    return {
      hwnd: w.hwnd,
      className: w.cls.className,
      parent: w.parent?.hwnd ?? 0,
      owner: w.owner?.hwnd ?? 0,
      style: w.style,
      exStyle: w.exStyle,
      text: w.text,
      id: w.isChild ? w.id : 0,
      left: r.left,
      top: r.top,
      width: r.right - r.left,
      height: r.bottom - r.top,
      visible: (w.style & WS_VISIBLE) !== 0,
      enabled: (w.style & WS_DISABLED) === 0,
    };
  }

  changed(w: Window): void {
    if (!w.destroyed) this.host.windowChanged?.(this.view(w));
  }

  /** `CreateWindowExW`. */
  create(
    exStyle: number,
    className: string | number,
    text: string,
    style: number,
    x: number,
    y: number,
    width: number,
    height: number,
    parentHandle: number,
    menu: number,
    instance: number,
    param: number,
  ): number {
    const cls = this.findClass(className);
    if (!cls) {
      this.setError(ERROR_CANNOT_FIND_WND_CLASS);
      return 0;
    }
    let parent: Window | null = null;
    let owner: Window | null = null;
    if (parentHandle) {
      const p = this.get(parentHandle);
      if (!p) return 0;
      if (style & WS_CHILD) parent = p;
      else owner = this.rootOwner(p);
    } else if (style & WS_CHILD) {
      this.setError(ERROR_INVALID_PARAMETER);
      return 0;
    }
    const hwnd = this.#nextHandle;
    this.#nextHandle += 2;
    const visible = (style & WS_VISIBLE) !== 0;
    style = (style & ~WS_VISIBLE) >>> 0;
    let top: WindowsTopLevelWindow | null = null;
    if (!(style & WS_CHILD)) {
      top = this.host.createTopLevelWindow(hwnd, text, 0, 0, style, exStyle);
      const area = this.host.screen;
      const nx = x === CW_USEDEFAULT ? 0 : x;
      const ny = x === CW_USEDEFAULT ? 0 : y;
      const nw = width === CW_USEDEFAULT ? Math.floor((area.width * 3) / 4) : width;
      const nh = width === CW_USEDEFAULT ? Math.floor((area.height * 3) / 4) : height;
      top.setWindowPos(nx, ny, nw, nh);
    }
    const w = new Window(hwnd, cls, instance, {
      style,
      exStyle,
      text: '',
      parent,
      owner,
      id: menu,
      top,
    });
    if (!top) {
      w.rect = {
        left: x === CW_USEDEFAULT ? 0 : x,
        top: x === CW_USEDEFAULT ? 0 : y,
        right: (x === CW_USEDEFAULT ? 0 : x) + (width === CW_USEDEFAULT ? 0 : width),
        bottom: (x === CW_USEDEFAULT ? 0 : y) + (width === CW_USEDEFAULT ? 0 : height),
      };
    }
    this.#windows.set(hwnd, w);
    if (parent) parent.children.unshift(w);
    else this.topLevel.unshift(w);

    this.creationHook?.(w);
    const cs = this.#createStruct(w, param, text, className);
    try {
      if (!this.send(w, WM_NCCREATE, 0, cs.address)) {
        this.#destroy(w);
        return 0;
      }
      if (this.send(w, WM_CREATE, 0, cs.address) === -1) {
        this.#destroy(w);
        return 0;
      }
    } finally {
      cs.free();
    }
    if (w.destroyed) return 0;
    this.host.windowCreated?.(this.view(w));
    const c = this.clientRect(w);
    this.send(w, WM_SIZE, SIZE_RESTORED, ((c.bottom & 0xffff) << 16) | (c.right & 0xffff));
    const origin = this.clientOriginInParent(w);
    this.send(w, WM_MOVE, 0, ((origin.y & 0xffff) << 16) | (origin.x & 0xffff));
    if (parent && !(exStyle & WS_EX_NOPARENTNOTIFY))
      this.send(parent, WM_PARENTNOTIFY, (w.id << 16) | WM_CREATE, hwnd);
    if (visible) this.showWindow(w, 5);
    return hwnd;
  }

  #createStruct(
    w: Window,
    param: number,
    text: string,
    className: string | number,
  ): {address: number; free(): void} {
    const mem = this.process.memory;
    const nameBytes = (text.length + 1) * 2;
    const classBytes = typeof className === 'string' ? (className.length + 1) * 2 : 0;
    const address = mem.allocate(CS_SIZE + nameBytes + classBytes, 'CREATESTRUCT');
    const dv = new DataView(mem.u8.buffer);
    const r = this.windowRect(w);
    dv.setUint32(address + 0, param >>> 0, true);
    dv.setUint32(address + 4, w.instance >>> 0, true);
    dv.setUint32(address + 8, w.id >>> 0, true);
    dv.setUint32(address + 12, (w.parent ?? w.owner)?.hwnd ?? 0, true);
    dv.setInt32(address + 16, r.bottom - r.top, true);
    dv.setInt32(address + 20, r.right - r.left, true);
    dv.setInt32(address + 24, r.top, true);
    dv.setInt32(address + 28, r.left, true);
    dv.setInt32(address + 32, w.style | 0, true);
    writeWideString(mem, address + CS_SIZE, text);
    dv.setUint32(address + 36, address + CS_SIZE, true);
    if (typeof className === 'string') {
      writeWideString(mem, address + CS_SIZE + nameBytes, className);
      dv.setUint32(address + 40, address + CS_SIZE + nameBytes, true);
    } else {
      dv.setUint32(address + 40, className & 0xffff, true);
    }
    dv.setUint32(address + 44, w.exStyle >>> 0, true);
    return {
      address,
      free: () => mem.free(address, CS_SIZE + nameBytes + classBytes),
    };
  }

  /** The top-level owner chain's root for an owner handle (`GW_OWNER` of a child). */
  rootOwner(w: Window): Window {
    let o = w;
    while (o.isChild && o.parent) o = o.parent;
    return o;
  }

  /** `DestroyWindow`. */
  destroy(hwnd: number): boolean {
    const w = this.get(hwnd);
    if (!w) return false;
    this.#destroy(w);
    return true;
  }

  #destroy(w: Window): void {
    if (w.destroyed) return;
    // Owned windows go first.
    for (const o of [...this.topLevel]) if (o.owner === w) this.#destroy(o);
    if (w.style & WS_VISIBLE) this.showWindow(w, SW_HIDE);
    if (w.parent && !(w.exStyle & WS_EX_NOPARENTNOTIFY))
      this.send(w.parent, WM_PARENTNOTIFY, (w.id << 16) | WM_DESTROY, w.hwnd);
    this.#sendDestroy(w);
    this.#ncDestroy(w);
  }

  #sendDestroy(w: Window): void {
    this.send(w, WM_DESTROY, 0, 0);
    for (const c of [...w.children]) this.#sendDestroy(c);
  }

  #ncDestroy(w: Window): void {
    for (const c of [...w.children]) this.#ncDestroy(c);
    this.send(w, WM_NCDESTROY, 0, 0);
    w.destroyed = true;
    if (this.focus === w) this.focus = null;
    if (this.active === w) this.active = null;
    if (this.#locked === w) this.#locked = null;
    const list = w.parent ? w.parent.children : this.topLevel;
    const i = list.indexOf(w);
    if (i >= 0) list.splice(i, 1);
    this.#windows.delete(w.hwnd);
    this.host.windowDestroyed?.(w.hwnd);
  }

  // --- messages -----------------------------------------------------------------------------

  send(w: Window, msg: number, wParam: number, lParam: number): number {
    if (w.destroyed && msg !== WM_NCDESTROY) return 0;
    return w.proc(w.hwnd, msg >>> 0, wParam, lParam);
  }

  post(hwnd: number, msg: number, wParam: number, lParam: number): boolean {
    if (hwnd && !this.get(hwnd)) return false;
    this.host.post(() => {
      const w = this.peek(hwnd);
      if (w) this.send(w, msg, wParam, lParam);
    });
    return true;
  }

  /** `DefWindowProcW`. */
  defWindowProc(hwnd: number, msg: number, wParam: number, lParam: number): number {
    const w = this.peek(hwnd);
    if (!w) return 0;
    switch (msg) {
      case WM_NCCREATE: {
        const dv = new DataView(this.process.memory.u8.buffer);
        const name = dv.getUint32(lParam + 36, true);
        if (name) this.setText(w, readWideString(this.process.memory, name));
        return 1;
      }
      case WM_SETTEXT:
        this.setText(w, lParam ? readWideString(this.process.memory, lParam) : '');
        return 1;
      case WM_GETTEXT:
        return copyText(this.process, w.text, wParam, lParam);
      case WM_GETTEXTLENGTH:
        return w.text.length;
      case WM_CLOSE:
        this.#destroy(w);
        return 0;
      case WM_SYSCOMMAND:
        if ((wParam & 0xfff0) === SC_CLOSE) this.send(w, WM_CLOSE, 0, 0);
        return 0;
      case WM_SETICON: {
        const prev = wParam === ICON_BIG ? w.bigIcon : w.smallIcon;
        if (wParam === ICON_BIG) w.bigIcon = lParam;
        else w.smallIcon = lParam;
        return prev;
      }
      case WM_WINDOWPOSCHANGED: {
        const dv = new DataView(this.process.memory.u8.buffer);
        const flags = dv.getUint32(lParam + 24, true);
        if (!(flags & SWP_NOSIZE) || flags & SWP_FRAMECHANGED) {
          const c = this.clientRect(w);
          const kind =
            w.style & WS_MINIMIZE
              ? SIZE_MINIMIZED
              : w.style & WS_MAXIMIZE
                ? SIZE_MAXIMIZED
                : SIZE_RESTORED;
          this.send(w, WM_SIZE, kind, ((c.bottom & 0xffff) << 16) | (c.right & 0xffff));
        }
        if (!(flags & SWP_NOMOVE) || flags & SWP_FRAMECHANGED) {
          const o = this.clientOriginInParent(w);
          this.send(w, WM_MOVE, 0, ((o.y & 0xffff) << 16) | (o.x & 0xffff));
        }
        return 0;
      }
      default:
        return 0;
    }
  }

  setText(w: Window, text: string): void {
    w.text = text;
    w.top?.setCaption(text);
    this.changed(w);
  }

  // --- longs and properties -----------------------------------------------------------------

  getLong(w: Window, index: number): number {
    switch (index) {
      case GWL_WNDPROC:
        return this.process.code.pointerOf(w.proc) | 0;
      case GWL_HINSTANCE:
        return w.instance | 0;
      case GWL_HWNDPARENT:
        return (w.isChild ? (w.parent?.hwnd ?? 0) : (w.owner?.hwnd ?? 0)) | 0;
      case GWL_STYLE:
        return w.style | 0;
      case GWL_EXSTYLE:
        return w.exStyle | 0;
      case GWL_USERDATA:
        return w.userData | 0;
      case GWL_ID:
        return w.id | 0;
    }
    if (index < 0 || index + 4 > w.extra.byteLength) {
      this.setError(ERROR_INVALID_INDEX);
      return 0;
    }
    return w.extra.getInt32(index, true);
  }

  setLong(w: Window, index: number, value: number): number {
    const prev = this.getLong(w, index);
    switch (index) {
      case GWL_WNDPROC: {
        const proc = this.process.code.functionAt<WindowProcedure>(value);
        if (!proc) {
          this.setError(ERROR_INVALID_PARAMETER);
          return 0;
        }
        w.proc = proc;
        return prev;
      }
      case GWL_HINSTANCE:
        return prev;
      case GWL_HWNDPARENT:
        if (!w.isChild) w.owner = value ? this.peek(value) : null;
        return prev;
      case GWL_USERDATA:
        w.userData = value | 0;
        return prev;
      case GWL_ID:
        w.id = value | 0;
        return prev;
    }
    if (GWL_STYLE_FLAGS.has(index)) {
      const which = index === GWL_STYLE ? -16 : -20;
      const ss = this.process.memory.allocate(8, 'STYLESTRUCT');
      const dv = new DataView(this.process.memory.u8.buffer);
      dv.setUint32(ss, prev >>> 0, true);
      dv.setUint32(ss + 4, value >>> 0, true);
      try {
        this.send(w, WM_STYLECHANGING, which, ss);
        const next = dv.getUint32(ss + 4, true);
        if (index === GWL_STYLE) w.style = next;
        else w.exStyle = next;
        w.top?.setStyles(w.style, w.exStyle);
        this.send(w, WM_STYLECHANGED, which, ss);
      } finally {
        this.process.memory.free(ss, 8);
      }
      this.changed(w);
      return prev;
    }
    if (index < 0 || index + 4 > w.extra.byteLength) {
      this.setError(ERROR_INVALID_INDEX);
      return 0;
    }
    w.extra.setInt32(index, value | 0, true);
    return prev;
  }

  // --- geometry -----------------------------------------------------------------------------

  /** The window rectangle: screen coordinates for every window (`GetWindowRect`). */
  windowRect(w: Window): Rect {
    if (w.top) return w.top.windowRect;
    const o = w.parent ? this.clientToScreen(w.parent, {x: 0, y: 0}) : {x: 0, y: 0};
    return {
      left: w.rect.left + o.x,
      top: w.rect.top + o.y,
      right: w.rect.right + o.x,
      bottom: w.rect.bottom + o.y,
    };
  }

  /** The frame around the client area of a child window. */
  #childFrame(w: Window): Rect {
    return adjustWindowRectEx(
      {left: 0, top: 0, right: 0, bottom: 0},
      w.style,
      false,
      w.exStyle,
      this.host.metrics,
    );
  }

  /** `GetClientRect`. */
  clientRect(w: Window): Rect {
    if (w.top) return w.top.clientRect;
    const f = this.#childFrame(w);
    const width = w.rect.right - w.rect.left - (f.right - f.left);
    const height = w.rect.bottom - w.rect.top - (f.bottom - f.top);
    return {left: 0, top: 0, right: Math.max(0, width), bottom: Math.max(0, height)};
  }

  clientToScreen(w: Window, p: Point): Point {
    if (w.top) {
      const o = w.top.clientOrigin;
      return {x: p.x + o.x, y: p.y + o.y};
    }
    const f = this.#childFrame(w);
    const r = this.windowRect(w);
    return {x: p.x + r.left - f.left, y: p.y + r.top - f.top};
  }

  screenToClient(w: Window, p: Point): Point {
    const o = this.clientToScreen(w, {x: 0, y: 0});
    return {x: p.x - o.x, y: p.y - o.y};
  }

  /** The client origin relative to the parent's client area (screen for top-level windows). */
  clientOriginInParent(w: Window): Point {
    const s = this.clientToScreen(w, {x: 0, y: 0});
    return w.parent ? this.screenToClient(w.parent, s) : s;
  }

  /** `SetWindowPos`. */
  setWindowPos(
    w: Window,
    insertAfter: number,
    x: number,
    y: number,
    cx: number,
    cy: number,
    flags: number,
  ): boolean {
    const mem = this.process.memory;
    const wp = mem.allocate(28, 'WINDOWPOS');
    const dv = new DataView(mem.u8.buffer);
    const cur = w.top ? w.top.windowRect : w.rect;
    dv.setUint32(wp, w.hwnd, true);
    dv.setInt32(wp + 4, insertAfter | 0, true);
    dv.setInt32(wp + 8, flags & SWP_NOMOVE ? cur.left : x, true);
    dv.setInt32(wp + 12, flags & SWP_NOMOVE ? cur.top : y, true);
    dv.setInt32(wp + 16, flags & SWP_NOSIZE ? cur.right - cur.left : cx, true);
    dv.setInt32(wp + 20, flags & SWP_NOSIZE ? cur.bottom - cur.top : cy, true);
    dv.setUint32(wp + 24, flags >>> 0, true);
    try {
      this.send(w, WM_WINDOWPOSCHANGING, 0, wp);
      const nx = dv.getInt32(wp + 8, true);
      const ny = dv.getInt32(wp + 12, true);
      const nw = dv.getInt32(wp + 16, true);
      const nh = dv.getInt32(wp + 20, true);
      const f = dv.getUint32(wp + 24, true);
      if (!(f & SWP_NOMOVE) || !(f & SWP_NOSIZE)) {
        if (w.top) w.top.setWindowPos(nx, ny, nw, nh);
        else w.rect = {left: nx, top: ny, right: nx + nw, bottom: ny + nh};
      } else if (f & SWP_FRAMECHANGED) {
        w.top?.setStyles(w.style, w.exStyle);
      }
      if (!(f & SWP_NOZORDER)) this.#zOrder(w, insertAfter);
      if (f & SWP_SHOWWINDOW) this.#setVisible(w, true, !(f & SWP_NOACTIVATE));
      else if (f & SWP_HIDEWINDOW) this.#setVisible(w, false, false);
      // The final position (a top-level window enforces its minimum tracking size).
      const r = w.top ? w.top.windowRect : w.rect;
      dv.setInt32(wp + 8, r.left, true);
      dv.setInt32(wp + 12, r.top, true);
      dv.setInt32(wp + 16, r.right - r.left, true);
      dv.setInt32(wp + 20, r.bottom - r.top, true);
      this.send(w, WM_WINDOWPOSCHANGED, 0, wp);
    } finally {
      mem.free(wp, 28);
    }
    this.changed(w);
    return true;
  }

  #zOrder(w: Window, insertAfter: number): void {
    const list = w.parent ? w.parent.children : this.topLevel;
    const i = list.indexOf(w);
    if (i < 0) return;
    if (insertAfter === HWND_TOPMOST || insertAfter === HWND_NOTOPMOST) {
      if (w.top) w.top.setTopMost(insertAfter === HWND_TOPMOST);
      w.exStyle =
        insertAfter === HWND_TOPMOST
          ? (w.exStyle | WS_EX_TOPMOST) >>> 0
          : w.exStyle & ~WS_EX_TOPMOST;
      if (insertAfter === HWND_NOTOPMOST) return;
    }
    list.splice(i, 1);
    if (insertAfter === 1) list.push(w);
    else if (insertAfter === 0 || insertAfter < 0) list.unshift(w);
    else {
      const j = list.findIndex((o) => o.hwnd === insertAfter >>> 0);
      list.splice(j < 0 ? 0 : j + 1, 0, w);
    }
  }

  // --- visibility, enabling, focus ---------------------------------------------------------

  /** `ShowWindow`: returns whether the window was visible. */
  showWindow(w: Window, cmd: number): boolean {
    const was = (w.style & WS_VISIBLE) !== 0;
    const show = cmd !== SW_HIDE;
    if (cmd === SW_MINIMIZE || cmd === SW_SHOWMINIMIZED || cmd === SW_SHOWMINNOACTIVE)
      w.style = ((w.style | WS_MINIMIZE) & ~WS_MAXIMIZE) >>> 0;
    else if (cmd === SW_SHOWMAXIMIZED) w.style = ((w.style | WS_MAXIMIZE) & ~WS_MINIMIZE) >>> 0;
    else if (cmd === SW_RESTORE || cmd === 1) w.style = w.style & ~(WS_MINIMIZE | WS_MAXIMIZE);
    const activate =
      show &&
      cmd !== SW_SHOWNOACTIVATE &&
      cmd !== SW_SHOWNA &&
      cmd !== SW_SHOWMINNOACTIVE &&
      cmd !== SW_MINIMIZE;
    this.#setVisible(w, show, activate);
    return was;
  }

  #setVisible(w: Window, show: boolean, activate: boolean): void {
    const was = (w.style & WS_VISIBLE) !== 0;
    if (was !== show) {
      this.send(w, WM_SHOWWINDOW, show ? 1 : 0, 0);
      w.style = show ? (w.style | WS_VISIBLE) >>> 0 : w.style & ~WS_VISIBLE;
      w.top?.setVisible(show);
      this.changed(w);
    }
    if (show && activate && w.top) this.activate(w);
    if (!show && this.active === w) this.active = null;
  }

  /** Makes a top-level window the active and foreground window. */
  activate(w: Window): void {
    for (const o of this.topLevel) o.top?.setForeground(o === w);
    this.active = w;
    const i = this.topLevel.indexOf(w);
    if (i > 0) {
      this.topLevel.splice(i, 1);
      this.topLevel.unshift(w);
    }
  }

  isVisible(w: Window): boolean {
    for (let o: Window | null = w; o; o = o.isChild ? o.parent : null)
      if (!(o.style & WS_VISIBLE)) return false;
    return true;
  }

  /** `EnableWindow`: returns whether the window was disabled. */
  enable(w: Window, enable: boolean): boolean {
    const wasDisabled = (w.style & WS_DISABLED) !== 0;
    if (wasDisabled === !enable) return wasDisabled;
    if (!enable && this.focus && (this.focus === w || this.isAncestor(w, this.focus)))
      this.setFocus(null);
    w.style = enable ? w.style & ~WS_DISABLED : (w.style | WS_DISABLED) >>> 0;
    this.send(w, WM_ENABLE, enable ? 1 : 0, 0);
    this.changed(w);
    return wasDisabled;
  }

  isAncestor(ancestor: Window, w: Window): boolean {
    for (let p = w.parent; p; p = p.parent) if (p === ancestor) return true;
    return false;
  }

  /** `SetFocus`: returns the window that had the focus. */
  setFocus(w: Window | null): Window | null {
    const prev = this.focus;
    if (prev === w) return prev;
    if (w && w.style & WS_DISABLED) return prev;
    if (prev && !prev.destroyed) this.send(prev, WM_KILLFOCUS, w?.hwnd ?? 0, 0);
    this.focus = w;
    if (w) {
      const root = this.rootOwner(w);
      if (root.top && this.active !== root) this.activate(root);
      this.send(w, WM_SETFOCUS, prev?.hwnd ?? 0, 0);
    }
    return prev;
  }

  /** `LockWindowUpdate`: one window at a time. */
  lockUpdate(w: Window | null): boolean {
    if (w && this.#locked) return false;
    this.#locked = w;
    return true;
  }

  /** Every descendant of `w`, depth first in z-order. */
  *descendants(w: Window): Generator<Window> {
    for (const c of w.children) {
      yield c;
      yield* this.descendants(c);
    }
  }
}

/** `WM_GETTEXT`: copies up to `max - 1` characters and a NUL; returns the count copied. */
export function copyText(
  process: NativeProcess,
  text: string,
  max: number,
  address: number,
): number {
  if (!address || max <= 0) return 0;
  const s = text.slice(0, max - 1);
  writeWideString(process.memory, address, s);
  return s.length;
}
