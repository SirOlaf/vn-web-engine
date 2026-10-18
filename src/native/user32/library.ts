/**
 * `user32.dll` on a `WindowsUserInterfaceHost`: the window manager (`windows.ts`), the dialog
 * manager (`dialogs.ts`) and the predefined controls (`controls.ts`). One instance serves the
 * process; every library that imports it shares the windows.
 */
import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {SYSTEM_DIALOG_BASE_UNITS} from '../../platform/windows-dialog-units.js';
import type {WindowsUserInterfaceHost} from '../../platform/windows-user-interface.js';
import {adjustWindowRectEx} from '../../platform/windows-top-level-window.js';
import {BI_RGB, GDI32, type Gdi32Exports} from '../gdi32/contract.js';
import {KERNEL32, type Kernel32Exports} from '../kernel32/contract.js';
import {
  ERROR_INVALID_PARAMETER,
  ERROR_RESOURCE_NAME_NOT_FOUND,
  SB_CTL,
  SB_HORZ,
  USER32,
  WS_DISABLED,
  type User32Exports,
  type WindowProcedure,
} from './contract.js';
import {registerControlClasses, ScrollState} from './controls.js';
import {DialogManager, DIALOG_CLASS_ATOM, DIALOG_CLASS_NAME, DLGWINDOWEXTRA} from './dialogs.js';
import {WindowManager, type Window} from './windows.js';

/** `IDI_*` system icons and their handles. */
const SYSTEM_ICONS: ReadonlyMap<number, number> = new Map([
  [32512, 0x00010003], // IDI_APPLICATION
  [32513, 0x00010005], // IDI_HAND
  [32514, 0x00010007], // IDI_QUESTION
  [32515, 0x00010009], // IDI_EXCLAMATION
  [32516, 0x0001000b], // IDI_ASTERISK
  [32517, 0x0001000d], // IDI_WINLOGO
  [32518, 0x0001000f], // IDI_SHIELD
]);

/** `GetSystemMetrics` of the reference system (96 DPI, frame metrics from the host). */
function systemMetric(host: WindowsUserInterfaceHost, index: number): number {
  const m = host.metrics;
  switch (index) {
    case 0: // SM_CXSCREEN
    case 16: // SM_CXFULLSCREEN
    case 78: // SM_CXVIRTUALSCREEN
      return host.screen.width;
    case 1: // SM_CYSCREEN
    case 79: // SM_CYVIRTUALSCREEN
      return host.screen.height;
    case 17: // SM_CYFULLSCREEN: the screen without the caption
      return host.screen.height - m.caption;
    case 2: // SM_CXVSCROLL
    case 3: // SM_CYHSCROLL
    case 20: // SM_CYVSCROLL
    case 21: // SM_CXHSCROLL
      return 17;
    case 4: // SM_CYCAPTION
      return m.caption;
    case 5: // SM_CXBORDER
    case 6: // SM_CYBORDER
      return m.border;
    case 7: // SM_CXFIXEDFRAME
    case 8: // SM_CYFIXEDFRAME
      return m.fixedFrame;
    case 11: // SM_CXICON
    case 12: // SM_CYICON
    case 13: // SM_CXCURSOR
    case 14: // SM_CYCURSOR
      return 32;
    case 15: // SM_CYMENU
      return m.menu;
    case 19: // SM_MOUSEPRESENT
      return 1;
    case 28: // SM_CXMIN
    case 34: // SM_CXMINTRACK
      return m.minTrackWidth;
    case 29: // SM_CYMIN
    case 35: // SM_CYMINTRACK
      return m.minTrackHeight;
    case 32: // SM_CXFRAME
    case 33: // SM_CYFRAME
      return m.sizeFrame;
    case 36: // SM_CXDOUBLECLK
    case 37: // SM_CYDOUBLECLK
      return 4;
    case 45: // SM_CXEDGE
    case 46: // SM_CYEDGE
      return m.edge;
    case 49: // SM_CXSMICON
    case 50: // SM_CYSMICON
      return 16;
    case 51: // SM_CYSMCAPTION
      return m.smallCaption;
    case 80: // SM_CMONITORS
      return 1;
    default:
      return 0;
  }
}

/** A window's client surface behind `GetDC`. */
interface Surface {
  readonly hdc: number;
  readonly bitmap: number;
  readonly width: number;
  readonly height: number;
}

/** An icon from `CreateIconIndirect`: a copy of its colour bitmap's pixels. */
interface Icon {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

class User32 implements User32Exports {
  readonly #wm: WindowManager;
  readonly #dialogs: DialogManager;
  readonly #scroll = new WeakMap<Window, {h: ScrollState; v: ScrollState}>();
  readonly #surfaces = new WeakMap<Window, Surface>();
  readonly #icons = new Map<number, Icon>();
  #nextIcon = 0x00030011;

  constructor(
    wm: WindowManager,
    private readonly gdi: Gdi32Exports,
  ) {
    this.#wm = wm;
    this.#dialogs = new DialogManager(wm);
    wm.registerClass(
      {
        style: 0,
        wndProc: this.#dialogs.defDlgProc,
        clsExtra: 0,
        wndExtra: DLGWINDOWEXTRA,
        instance: 0,
        icon: 0,
        cursor: 0,
        background: 0,
        menuName: null,
        className: DIALOG_CLASS_NAME,
        iconSmall: 0,
      },
      true,
      DIALOG_CLASS_ATOM,
    );
    registerControlClasses(wm);
  }

  #w(hwnd: number): Window | null {
    return this.#wm.get(hwnd);
  }

  // Classes.
  RegisterClassExW: User32Exports['RegisterClassExW'] = (cls) => this.#wm.registerClass(cls);
  UnregisterClassW: User32Exports['UnregisterClassW'] = (name) => this.#wm.unregisterClass(name);
  GetClassInfoExW: User32Exports['GetClassInfoExW'] = (_instance, name) => {
    const cls = this.#wm.findClass(name);
    if (!cls) return null;
    const {atom: _atom, system: _system, ...info} = cls;
    return info;
  };
  GetClassNameW: User32Exports['GetClassNameW'] = (hwnd) => this.#w(hwnd)?.cls.className ?? null;

  // Windows.
  CreateWindowExW: User32Exports['CreateWindowExW'] = (...args) => this.#wm.create(...args);
  DestroyWindow: User32Exports['DestroyWindow'] = (hwnd) => this.#wm.destroy(hwnd);
  IsWindow: User32Exports['IsWindow'] = (hwnd) => this.#wm.peek(hwnd) !== null;
  IsWindowVisible: User32Exports['IsWindowVisible'] = (hwnd) => {
    const w = this.#wm.peek(hwnd);
    return w ? this.#wm.isVisible(w) : false;
  };
  IsWindowEnabled: User32Exports['IsWindowEnabled'] = (hwnd) => {
    const w = this.#wm.peek(hwnd);
    return w ? !(w.style & WS_DISABLED) : false;
  };
  EnableWindow: User32Exports['EnableWindow'] = (hwnd, enable) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.enable(w, enable) : false;
  };
  ShowWindow: User32Exports['ShowWindow'] = (hwnd, cmd) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.showWindow(w, cmd) : false;
  };
  UpdateWindow: User32Exports['UpdateWindow'] = (hwnd) => this.#w(hwnd) !== null;
  InvalidateRect: User32Exports['InvalidateRect'] = (hwnd, _rect, _erase) => {
    if (!hwnd) return true;
    const w = this.#w(hwnd);
    if (w) this.#wm.changed(w);
    return w !== null;
  };
  LockWindowUpdate: User32Exports['LockWindowUpdate'] = (hwnd) => {
    if (!hwnd) return this.#wm.lockUpdate(null);
    const w = this.#w(hwnd);
    return w ? this.#wm.lockUpdate(w) : false;
  };
  IsIconic: User32Exports['IsIconic'] = (hwnd) =>
    ((this.#wm.peek(hwnd)?.style ?? 0) & 0x20000000) !== 0;
  IsZoomed: User32Exports['IsZoomed'] = (hwnd) =>
    ((this.#wm.peek(hwnd)?.style ?? 0) & 0x01000000) !== 0;
  GetParent: User32Exports['GetParent'] = (hwnd) => {
    const w = this.#w(hwnd);
    if (!w) return 0;
    if (w.isChild) return w.parent?.hwnd ?? 0;
    return w.style & 0x80000000 ? (w.owner?.hwnd ?? 0) : 0;
  };
  SetParent: User32Exports['SetParent'] = (hwnd, parentHandle) => {
    const w = this.#w(hwnd);
    if (!w) return 0;
    const parent = parentHandle ? this.#w(parentHandle) : null;
    if (parentHandle && !parent) return 0;
    const prev = w.isChild ? (w.parent?.hwnd ?? 0) : 0;
    const from = w.parent ? w.parent.children : this.#wm.topLevel;
    const i = from.indexOf(w);
    if (i >= 0) from.splice(i, 1);
    w.parent = parent;
    (parent ? parent.children : this.#wm.topLevel).unshift(w);
    this.#wm.changed(w);
    return prev;
  };
  GetDlgCtrlID: User32Exports['GetDlgCtrlID'] = (hwnd) => {
    const w = this.#w(hwnd);
    return w && w.isChild ? w.id : 0;
  };
  EnumChildWindows: User32Exports['EnumChildWindows'] = (parent, callback) => {
    const w = this.#w(parent);
    if (!w) return false;
    for (const c of [...this.#wm.descendants(w)])
      if (!c.destroyed && !callback(c.hwnd)) return false;
    return true;
  };
  EnumThreadWindows: User32Exports['EnumThreadWindows'] = (callback) => {
    for (const w of [...this.#wm.topLevel]) if (!w.destroyed && !callback(w.hwnd)) return false;
    return true;
  };
  GetWindowLongW: User32Exports['GetWindowLongW'] = (hwnd, index) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.getLong(w, index) : 0;
  };
  SetWindowLongW: User32Exports['SetWindowLongW'] = (hwnd, index, value) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.setLong(w, index, value) : 0;
  };
  GetPropW: User32Exports['GetPropW'] = (hwnd, name) =>
    this.#wm.peek(hwnd)?.props.get(name.toLowerCase()) ?? 0;
  SetPropW: User32Exports['SetPropW'] = (hwnd, name, value) => {
    const w = this.#w(hwnd);
    if (!w) return false;
    w.props.set(name.toLowerCase(), value);
    return true;
  };
  RemovePropW: User32Exports['RemovePropW'] = (hwnd, name) => {
    const w = this.#wm.peek(hwnd);
    if (!w) return 0;
    const v = w.props.get(name.toLowerCase()) ?? 0;
    w.props.delete(name.toLowerCase());
    return v;
  };
  GetWindowTextW: User32Exports['GetWindowTextW'] = (hwnd) => {
    const w = this.#w(hwnd);
    if (!w) return '';
    const len = this.#wm.send(w, 0x000e, 0, 0);
    if (len <= 0) return '';
    const mem = this.#wm.process.memory;
    const buf = mem.allocate((len + 1) * 2, 'GetWindowTextW');
    try {
      const n = this.#wm.send(w, 0x000d, len + 1, buf);
      let s = '';
      for (let i = 0; i < n; i++)
        s += String.fromCharCode(mem.u8[buf + 2 * i]! | (mem.u8[buf + 2 * i + 1]! << 8));
      return s;
    } finally {
      mem.free(buf, (len + 1) * 2);
    }
  };
  GetWindowTextLengthW: User32Exports['GetWindowTextLengthW'] = (hwnd) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.send(w, 0x000e, 0, 0) : 0;
  };
  SetWindowTextW: User32Exports['SetWindowTextW'] = (hwnd, text) => {
    const w = this.#w(hwnd);
    if (!w) return false;
    const mem = this.#wm.process.memory;
    const size = (text.length + 1) * 2;
    const buf = mem.allocate(size, 'SetWindowTextW');
    try {
      for (let i = 0; i < text.length; i++) {
        mem.u8[buf + 2 * i] = text.charCodeAt(i) & 0xff;
        mem.u8[buf + 2 * i + 1] = text.charCodeAt(i) >>> 8;
      }
      return this.#wm.send(w, 0x000c, 0, buf) !== 0;
    } finally {
      mem.free(buf, size);
    }
  };
  GetWindowRect: User32Exports['GetWindowRect'] = (hwnd) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.windowRect(w) : null;
  };
  GetClientRect: User32Exports['GetClientRect'] = (hwnd) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.clientRect(w) : null;
  };
  SetWindowPos: User32Exports['SetWindowPos'] = (hwnd, after, x, y, cx, cy, flags) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.setWindowPos(w, after, x, y, cx, cy, flags) : false;
  };
  MoveWindow: User32Exports['MoveWindow'] = (hwnd, x, y, width, height, repaint) =>
    this.SetWindowPos(hwnd, 0, x, y, width, height, 0x0004 | 0x0010 | (repaint ? 0 : 0x0008));
  MapWindowPoints: User32Exports['MapWindowPoints'] = (from, to, points) => {
    const a = from ? this.#w(from) : null;
    const b = to ? this.#w(to) : null;
    if ((from && !a) || (to && !b)) return 0;
    const oa = a ? this.#wm.clientToScreen(a, {x: 0, y: 0}) : {x: 0, y: 0};
    const ob = b ? this.#wm.clientToScreen(b, {x: 0, y: 0}) : {x: 0, y: 0};
    const dx = oa.x - ob.x;
    const dy = oa.y - ob.y;
    for (const p of points) {
      p.x += dx;
      p.y += dy;
    }
    return ((dy & 0xffff) << 16) | (dx & 0xffff);
  };
  ClientToScreen: User32Exports['ClientToScreen'] = (hwnd, point) => {
    const w = this.#w(hwnd);
    if (!w) return false;
    const p = this.#wm.clientToScreen(w, point);
    point.x = p.x;
    point.y = p.y;
    return true;
  };
  ScreenToClient: User32Exports['ScreenToClient'] = (hwnd, point) => {
    const w = this.#w(hwnd);
    if (!w) return false;
    const p = this.#wm.screenToClient(w, point);
    point.x = p.x;
    point.y = p.y;
    return true;
  };
  AdjustWindowRectEx: User32Exports['AdjustWindowRectEx'] = (rect, style, menu, exStyle) => {
    const r = adjustWindowRectEx(rect, style, menu, exStyle, this.#wm.host.metrics);
    Object.assign(rect, r);
    return true;
  };
  GetForegroundWindow: User32Exports['GetForegroundWindow'] = () => this.#wm.active?.hwnd ?? 0;
  SetForegroundWindow: User32Exports['SetForegroundWindow'] = (hwnd) => {
    const w = this.#wm.peek(hwnd);
    if (!w) return false;
    const root = this.#wm.rootOwner(w);
    root.top?.bringToFront();
    this.#wm.activate(root);
    return true;
  };
  GetFocus: User32Exports['GetFocus'] = () => this.#wm.focus?.hwnd ?? 0;
  SetFocus: User32Exports['SetFocus'] = (hwnd) => {
    const w = hwnd ? this.#w(hwnd) : null;
    if (hwnd && !w) return 0;
    return this.#wm.setFocus(w)?.hwnd ?? 0;
  };
  GetActiveWindow: User32Exports['GetActiveWindow'] = () => this.#wm.active?.hwnd ?? 0;

  // Messages.
  GetMessageExtraInfo: User32Exports['GetMessageExtraInfo'] = () =>
    this.#wm.host.messageExtraInfo?.() ?? 0;
  SendMessageW: User32Exports['SendMessageW'] = (hwnd, msg, wParam, lParam) => {
    const w = this.#w(hwnd);
    return w ? this.#wm.send(w, msg, wParam, lParam) : 0;
  };
  PostMessageW: User32Exports['PostMessageW'] = (hwnd, msg, wParam, lParam) =>
    this.#wm.post(hwnd, msg, wParam, lParam);
  CallWindowProcW: User32Exports['CallWindowProcW'] = (proc, hwnd, msg, wParam, lParam) => {
    const fn = this.#wm.process.code.functionAt<WindowProcedure>(proc);
    return fn ? fn(hwnd, msg, wParam, lParam) : 0;
  };
  DefWindowProcW: User32Exports['DefWindowProcW'] = (hwnd, msg, wParam, lParam) =>
    this.#wm.defWindowProc(hwnd, msg, wParam, lParam);

  // Scroll bars.
  #scrollState(w: Window, bar: number): ScrollState | null {
    if (bar === SB_CTL) return w.state instanceof ScrollState ? w.state : null;
    let s = this.#scroll.get(w);
    if (!s) this.#scroll.set(w, (s = {h: new ScrollState(), v: new ScrollState()}));
    return bar === SB_HORZ ? s.h : s.v;
  }
  GetScrollInfo: User32Exports['GetScrollInfo'] = (hwnd, bar, info) => {
    const w = this.#w(hwnd);
    const st = w ? this.#scrollState(w, bar) : null;
    if (!st) {
      if (w) this.#wm.setError(ERROR_INVALID_PARAMETER);
      return false;
    }
    return st.get(info);
  };
  SetScrollInfo: User32Exports['SetScrollInfo'] = (hwnd, bar, info) => {
    const w = this.#w(hwnd);
    const st = w ? this.#scrollState(w, bar) : null;
    if (!w || !st) return 0;
    const r = st.set(info);
    this.#wm.changed(w);
    return r;
  };

  // Dialogs.
  CreateDialogIndirectParamW: User32Exports['CreateDialogIndirectParamW'] = (
    instance,
    template,
    owner,
    proc,
    initParam,
  ) => this.#dialogs.create(instance, template, owner, proc, initParam, false)?.hwnd ?? 0;
  DialogBoxIndirectParamW: User32Exports['DialogBoxIndirectParamW'] = (
    instance,
    template,
    owner,
    proc,
    initParam,
  ) => this.#dialogs.dialogBox(instance, template, owner, proc, initParam);
  EndDialog: User32Exports['EndDialog'] = (hwnd, result) => {
    const w = this.#w(hwnd);
    return w ? this.#dialogs.end(w, result) : false;
  };
  GetDlgItem: User32Exports['GetDlgItem'] = (hwnd, id) => {
    const w = this.#w(hwnd);
    return w ? (this.#dialogs.getItem(w, id)?.hwnd ?? 0) : 0;
  };
  SendDlgItemMessageW: User32Exports['SendDlgItemMessageW'] = (hwnd, id, msg, wParam, lParam) => {
    const item = this.GetDlgItem(hwnd, id);
    return item ? this.SendMessageW(item, msg, wParam, lParam) : 0;
  };
  GetDlgItemTextW: User32Exports['GetDlgItemTextW'] = (hwnd, id) => {
    const item = this.GetDlgItem(hwnd, id);
    return item ? this.GetWindowTextW(item) : null;
  };
  SetDlgItemTextW: User32Exports['SetDlgItemTextW'] = (hwnd, id, text) => {
    const item = this.GetDlgItem(hwnd, id);
    return item ? this.SetWindowTextW(item, text) : false;
  };
  GetDlgItemInt: User32Exports['GetDlgItemInt'] = (hwnd, id, signed) => {
    const text = this.GetDlgItemTextW(hwnd, id);
    return text === null ? null : DialogManager.parseInt(text, signed);
  };
  SetDlgItemInt: User32Exports['SetDlgItemInt'] = (hwnd, id, value, signed) =>
    this.SetDlgItemTextW(hwnd, id, String(signed ? value | 0 : value >>> 0));
  GetDialogBaseUnits: User32Exports['GetDialogBaseUnits'] = () =>
    (SYSTEM_DIALOG_BASE_UNITS.cy << 16) | SYSTEM_DIALOG_BASE_UNITS.cx;
  MapDialogRect: User32Exports['MapDialogRect'] = (hwnd, rect) => {
    const w = this.#w(hwnd);
    return w ? this.#dialogs.mapRect(w, rect) : false;
  };
  IsDialogMessageW: User32Exports['IsDialogMessageW'] = (hwnd, msg) => {
    const w = this.#wm.peek(hwnd);
    return w ? this.#dialogs.isDialogMessage(w, msg) : false;
  };

  // Message boxes.
  MessageBoxW: User32Exports['MessageBoxW'] = async (ownerHandle, text, caption, type) => {
    const host = this.#wm.host.messageBox;
    if (!host) {
      this.#wm.setError(ERROR_INVALID_PARAMETER);
      return 0;
    }
    const owner = ownerHandle ? this.#wm.peek(ownerHandle) : null;
    const root = owner ? this.#wm.rootOwner(owner) : null;
    const reenable = root !== null && !(root.style & WS_DISABLED);
    if (reenable) this.#wm.enable(root!, false);
    try {
      return await host.messageBox(text, caption, type & 0xffff);
    } finally {
      if (reenable && !root!.destroyed) this.#wm.enable(root!, true);
    }
  };

  // Painting.
  GetDC: User32Exports['GetDC'] = (hwnd) => {
    const w = hwnd ? this.#w(hwnd) : null;
    if (hwnd && !w) return 0;
    const c = w
      ? this.#wm.clientRect(w)
      : {right: this.#wm.host.screen.width, bottom: this.#wm.host.screen.height};
    const width = Math.max(1, c.right);
    const height = Math.max(1, c.bottom);
    const cur = w ? this.#surfaces.get(w) : undefined;
    if (cur && cur.width === width && cur.height === height) return cur.hdc;
    if (cur) {
      this.gdi.DeleteDC(cur.hdc);
      this.gdi.DeleteObject(cur.bitmap);
    }
    const hdc = this.gdi.CreateCompatibleDC(0);
    const dib = this.gdi.CreateDIBSection(hdc, {
      width,
      height: -height,
      bitCount: 32,
      compression: BI_RGB,
      redMask: 0,
      greenMask: 0,
      blueMask: 0,
      alphaMask: 0,
    });
    if (!dib) {
      this.gdi.DeleteDC(hdc);
      return 0;
    }
    this.gdi.SelectObject(hdc, dib.bitmap);
    if (w) this.#surfaces.set(w, {hdc, bitmap: dib.bitmap, width, height});
    return hdc;
  };
  ReleaseDC: User32Exports['ReleaseDC'] = (hwnd, hdc) => {
    const w = hwnd ? this.#wm.peek(hwnd) : null;
    if (w) {
      this.#wm.changed(w);
      return this.#surfaces.get(w)?.hdc === hdc;
    }
    return this.gdi.DeleteDC(hdc);
  };

  // Icons and system.
  CreateIconIndirect: User32Exports['CreateIconIndirect'] = (info) => {
    const color = this.gdi.GetObjectW(info.color);
    const mask = this.gdi.GetObjectW(info.mask);
    if (color?.kind !== 'bitmap' || mask?.kind !== 'bitmap') {
      this.#wm.setError(ERROR_INVALID_PARAMETER);
      return 0;
    }
    const size = color.widthBytes * color.height;
    const pixels = this.#wm.process.memory.u8.slice(color.bits, color.bits + size);
    const icon = this.#nextIcon;
    this.#nextIcon += 2;
    this.#icons.set(icon, {width: color.width, height: color.height, pixels});
    return icon;
  };
  LoadIconW: User32Exports['LoadIconW'] = (instance, name) => {
    const icon = !instance && typeof name === 'number' ? SYSTEM_ICONS.get(name) : undefined;
    if (icon === undefined) {
      this.#wm.setError(ERROR_RESOURCE_NAME_NOT_FOUND);
      return 0;
    }
    return icon;
  };
  DestroyIcon: User32Exports['DestroyIcon'] = (icon) => {
    if ([...SYSTEM_ICONS.values()].includes(icon)) return true;
    return this.#icons.delete(icon);
  };
  GetSystemMetrics: User32Exports['GetSystemMetrics'] = (index) =>
    systemMetric(this.#wm.host, index);
  GetCursorPos: User32Exports['GetCursorPos'] = () => this.#wm.host.cursorPos();
  SetCursorPos: User32Exports['SetCursorPos'] = (x, y) => {
    this.#wm.host.setCursorPos?.(x, y);
    return true;
  };
}

/** `user32.dll` for a process whose windows `host` presents. */
export function user32Library(
  host: WindowsUserInterfaceHost,
): NativeLibraryImplementation<User32Exports> {
  return {
    contract: USER32,
    identities: [{kind: 'system', fileName: 'user32.dll'}],
    imports: [
      {contract: KERNEL32, binding: 'static'},
      {contract: GDI32, binding: 'static'},
    ],
    link(context) {
      const kernel32 = context.staticImport<Kernel32Exports>(KERNEL32);
      const gdi32 = context.staticImport<Gdi32Exports>(GDI32);
      return {
        exports: new User32(new WindowManager(context.process, host, kernel32), gdi32),
      };
    },
  };
}
