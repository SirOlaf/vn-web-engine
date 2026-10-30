/**
 * The dialog manager of `user32.dll`: `DLGTEMPLATE`/`DLGTEMPLATEEX` parsing, dialog creation
 * (frame, position, controls in template order, `WM_SETFONT`, `WM_INITDIALOG`, initial focus),
 * the dialog class procedure (`DefDlgProcW`), modal loops and `EndDialog`, dialog items and
 * dialog units. The order of steps follows the Win32 dialog manager.
 */
import {readWideString} from '../../platform/native-process.js';
import {
  dialogFontBaseUnits,
  SYSTEM_DIALOG_BASE_UNITS,
  type DialogBaseUnits,
} from '../../platform/windows-dialog-units.js';
import {adjustWindowRectEx} from '../../platform/windows-top-level-window.js';
import {
  DS_ABSALIGN,
  DS_CENTER,
  DS_CENTERMOUSE,
  DS_CONTROL,
  DS_MODALFRAME,
  DS_SETFONT,
  DWL_DLGPROC,
  DWL_MSGRESULT,
  ERROR_CONTROL_ID_NOT_FOUND,
  ERROR_INVALID_PARAMETER,
  IDCANCEL,
  IDOK,
  WM_CHAR,
  WM_CLOSE,
  WM_COMMAND,
  WM_CTLCOLORBTN,
  WM_CTLCOLORDLG,
  WM_CTLCOLOREDIT,
  WM_CTLCOLORLISTBOX,
  WM_CTLCOLORMSGBOX,
  WM_CTLCOLORSCROLLBAR,
  WM_CTLCOLORSTATIC,
  WM_GETFONT,
  WM_INITDIALOG,
  WM_KEYDOWN,
  WM_SETFONT,
  WS_CAPTION,
  WS_CHILD,
  WS_DISABLED,
  WS_EX_CONTROLPARENT,
  WS_EX_DLGMODALFRAME,
  WS_EX_NOPARENTNOTIFY,
  WS_SYSMENU,
  WS_TABSTOP,
  WS_VISIBLE,
  type Message,
  type Rect,
  type WindowProcedure,
} from './contract.js';
import type {Window, WindowManager} from './windows.js';

/** `WC_DIALOG`: the dialog class atom. */
export const DIALOG_CLASS_ATOM = 0x8002;
export const DIALOG_CLASS_NAME = '#32770';
/** `DLGWINDOWEXTRA`. */
export const DLGWINDOWEXTRA = 30;

const DM_GETDEFID = 0x0400;
const DM_SETDEFID = 0x0401;
const DC_HASDEFID = 0x534b;
const WM_COMPAREITEM = 0x0039;
const WM_CHARTOITEM = 0x002f;
const WM_VKEYTOITEM = 0x002e;
const WM_QUERYDRAGICON = 0x0037;
const WM_GETDLGCODE = 0x0087;
const DLGC_DEFPUSHBUTTON = 0x0010;
const DLGC_WANTALLKEYS = 0x0004;
const DLGC_WANTTAB = 0x0002;
const DLGC_WANTMESSAGE = 0x0004;
const VK_TAB = 0x09;
const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;
const BN_CLICKED = 0;

/** Dialog messages whose procedure result is the message result. */
const DIRECT_RESULT = new Set([
  WM_CTLCOLORMSGBOX,
  WM_CTLCOLOREDIT,
  WM_CTLCOLORLISTBOX,
  WM_CTLCOLORBTN,
  WM_CTLCOLORDLG,
  WM_CTLCOLORSCROLLBAR,
  WM_CTLCOLORSTATIC,
  WM_COMPAREITEM,
  WM_VKEYTOITEM,
  WM_CHARTOITEM,
  WM_QUERYDRAGICON,
  WM_INITDIALOG,
]);

/** Ordinals of the predefined control classes in templates. */
const CLASS_ORDINALS: ReadonlyMap<number, string> = new Map([
  [0x80, 'Button'],
  [0x81, 'Edit'],
  [0x82, 'Static'],
  [0x83, 'ListBox'],
  [0x84, 'ScrollBar'],
  [0x85, 'ComboBox'],
]);

/** A name or an ordinal (`sz_Or_Ord`). */
export type NameOrOrdinal = string | number | null;

export interface DialogItemTemplate {
  readonly helpId: number;
  readonly style: number;
  readonly exStyle: number;
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly id: number;
  readonly className: NameOrOrdinal;
  readonly title: NameOrOrdinal;
  /** Address of the creation data, 0 without. */
  readonly data: number;
}

export interface DialogTemplate {
  readonly extended: boolean;
  readonly helpId: number;
  readonly style: number;
  readonly exStyle: number;
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly menu: NameOrOrdinal;
  readonly className: NameOrOrdinal;
  readonly title: string;
  readonly font: {
    readonly pointSize: number;
    readonly weight: number;
    readonly italic: boolean;
    readonly charset: number;
    readonly face: string;
  } | null;
  readonly items: readonly DialogItemTemplate[];
}

/** Reads a `DLGTEMPLATE` or `DLGTEMPLATEEX` at `address`. */
export function parseDialogTemplate(u8: Uint8Array, address: number): DialogTemplate {
  const dv = new DataView(u8.buffer, u8.byteOffset);
  let p = address;
  const u16 = () => {
    const v = dv.getUint16(p, true);
    p += 2;
    return v;
  };
  const i16 = () => {
    const v = dv.getInt16(p, true);
    p += 2;
    return v;
  };
  const u32 = () => {
    const v = dv.getUint32(p, true);
    p += 4;
    return v;
  };
  const sz = (): string => {
    let s = '';
    for (;;) {
      const c = u16();
      if (!c) return s;
      s += String.fromCharCode(c);
    }
  };
  const szOrOrd = (): NameOrOrdinal => {
    const first = dv.getUint16(p, true);
    if (first === 0) {
      p += 2;
      return null;
    }
    if (first === 0xffff) {
      p += 2;
      return u16();
    }
    return sz();
  };
  const align4 = () => {
    p = address + ((p - address + 3) & ~3);
  };

  const extended = dv.getUint16(p, true) === 1 && dv.getUint16(p + 2, true) === 0xffff;
  let helpId = 0;
  let style: number;
  let exStyle: number;
  if (extended) {
    p += 4;
    helpId = u32();
    exStyle = u32();
    style = u32();
  } else {
    style = u32();
    exStyle = u32();
  }
  const count = u16();
  const x = i16();
  const y = i16();
  const cx = i16();
  const cy = i16();
  const menu = szOrOrd();
  const className = szOrOrd();
  const title = szOrOrd();
  let font: DialogTemplate['font'] = null;
  if (style & DS_SETFONT) {
    const pointSize = u16();
    let weight = 0;
    let italic = false;
    let charset = 1;
    if (extended) {
      weight = u16();
      italic = dv.getUint8(p) !== 0;
      charset = dv.getUint8(p + 1);
      p += 2;
    }
    font = {pointSize, weight, italic, charset, face: sz()};
  }
  const items: DialogItemTemplate[] = [];
  for (let i = 0; i < count; i++) {
    align4();
    let itemHelp = 0;
    let itemStyle: number;
    let itemExStyle: number;
    if (extended) {
      itemHelp = u32();
      itemExStyle = u32();
      itemStyle = u32();
    } else {
      itemStyle = u32();
      itemExStyle = u32();
    }
    const ix = i16();
    const iy = i16();
    const icx = i16();
    const icy = i16();
    const id = extended ? u32() : u16();
    const cls = szOrOrd();
    const ititle = szOrOrd();
    const extra = u16();
    const data = extra ? p : 0;
    p += extra;
    items.push({
      helpId: itemHelp,
      style: itemStyle,
      exStyle: itemExStyle,
      x: ix,
      y: iy,
      cx: icx,
      cy: icy,
      id,
      className: cls,
      title: ititle,
      data,
    });
  }
  return {
    extended,
    helpId,
    style,
    exStyle,
    x,
    y,
    cx,
    cy,
    menu,
    className,
    title: typeof title === 'string' ? title : '',
    font,
    items,
  };
}

/** `MulDiv`: rounds half away from zero. */
export function mulDiv(a: number, b: number, c: number): number {
  const n = a * b;
  const q = (Math.abs(n) + Math.floor(Math.abs(c) / 2)) / Math.abs(c);
  return Math.sign(n) * Math.sign(c) * Math.floor(q);
}

/** The state of a dialog window. */
export interface DialogState {
  readonly units: DialogBaseUnits;
  readonly font: number;
  readonly modal: boolean;
  ended: boolean;
  result: number;
  defId: number;
  /** Ends a modal loop. */
  finish: ((result: number) => void) | null;
}

export class DialogManager {
  #nextFont = 0x0a0a0000;

  constructor(private readonly wm: WindowManager) {}

  /** The dialog state of a window the dialog manager created, or null. */
  state(w: Window): DialogState | null {
    return this.#dialogs.has(w) ? (w.state as DialogState) : null;
  }

  readonly #dialogs = new WeakSet<Window>();

  /** `DefDlgProcW`, the class procedure of `#32770`. */
  readonly defDlgProc: WindowProcedure = (hwnd, msg, wParam, lParam) => {
    const wm = this.wm;
    const w = wm.peek(hwnd);
    if (!w) return 0;
    const dlgProc = wm.process.code.functionAt<WindowProcedure>(
      w.extra.byteLength >= 8 ? w.extra.getUint32(DWL_DLGPROC, true) : 0,
    );
    if (w.extra.byteLength >= 4) w.extra.setInt32(DWL_MSGRESULT, 0, true);
    const r = dlgProc ? dlgProc(hwnd, msg, wParam, lParam) : 0;
    if (DIRECT_RESULT.has(msg)) return r;
    if (r)
      return w.extra.byteLength >= 4 && !w.destroyed ? w.extra.getInt32(DWL_MSGRESULT, true) : 0;
    if (w.destroyed) return 0;
    const st = this.state(w);
    switch (msg) {
      case WM_CLOSE: {
        const cancel = this.item(w, IDCANCEL);
        wm.post(hwnd, WM_COMMAND, (BN_CLICKED << 16) | IDCANCEL, cancel?.hwnd ?? 0);
        return 0;
      }
      case WM_GETFONT:
        return st?.font ?? 0;
      case DM_GETDEFID:
        return st && st.defId ? (DC_HASDEFID << 16) | (st.defId & 0xffff) : 0;
      case DM_SETDEFID:
        if (st) st.defId = wParam & 0xffff;
        return 1;
      default:
        return wm.defWindowProc(hwnd, msg, wParam, lParam);
    }
  };

  /** The direct child with the id (`GetDlgItem`). */
  item(w: Window, id: number): Window | null {
    for (const c of w.children) if ((c.id & 0xffff) === (id & 0xffff) && c.isChild) return c;
    return null;
  }

  /** `GetDlgItem`: sets `ERROR_CONTROL_ID_NOT_FOUND` when no child has the id. */
  getItem(w: Window, id: number): Window | null {
    const c = this.item(w, id);
    if (!c) this.wm.setError(ERROR_CONTROL_ID_NOT_FOUND);
    return c;
  }

  units(w: Window | null): DialogBaseUnits {
    return (w && this.state(w)?.units) || SYSTEM_DIALOG_BASE_UNITS;
  }

  /** `MapDialogRect`. */
  mapRect(w: Window, rect: Rect): boolean {
    const st = this.state(w);
    if (!st) {
      this.wm.setError(ERROR_INVALID_PARAMETER);
      return false;
    }
    const {cx, cy} = st.units;
    rect.left = mulDiv(rect.left, cx, 4);
    rect.right = mulDiv(rect.right, cx, 4);
    rect.top = mulDiv(rect.top, cy, 8);
    rect.bottom = mulDiv(rect.bottom, cy, 8);
    return true;
  }

  /**
   * `CreateDialogIndirectParamW` (and the creation part of `DialogBoxIndirectParamW`).
   * Returns the dialog, or null when it cannot be created.
   */
  create(
    instance: number,
    templateAddress: number,
    ownerHandle: number,
    dialogProc: WindowProcedure,
    initParam: number,
    modal: boolean,
  ): Window | null {
    const wm = this.wm;
    let owner: Window | null = null;
    if (ownerHandle) {
      owner = wm.get(ownerHandle);
      if (!owner) return null;
    }
    if (!templateAddress) {
      wm.setError(ERROR_INVALID_PARAMETER);
      return null;
    }
    const t = parseDialogTemplate(wm.process.memory.u8, templateAddress);
    const units = t.font
      ? dialogFontBaseUnits(t.font.face, t.font.pointSize)
      : SYSTEM_DIALOG_BASE_UNITS;
    let style = t.style >>> 0;
    let exStyle = t.exStyle >>> 0;
    if (style & DS_MODALFRAME) exStyle |= WS_EX_DLGMODALFRAME;
    if (style & DS_CONTROL) {
      style &= ~(WS_CAPTION | WS_SYSMENU);
      exStyle |= WS_EX_CONTROLPARENT;
    }
    const frame = adjustWindowRectEx(
      {left: 0, top: 0, right: mulDiv(t.cx, units.cx, 4), bottom: mulDiv(t.cy, units.cy, 8)},
      style,
      t.menu !== null,
      exStyle,
      wm.host.metrics,
    );
    const width = frame.right - frame.left;
    const height = frame.bottom - frame.top;
    let x: number;
    let y: number;
    if (style & DS_CENTER || style & DS_CENTERMOUSE) {
      const area = owner && !(style & WS_CHILD) ? wm.windowRect(wm.rootOwner(owner)) : null;
      const cx = area ? (area.left + area.right) >> 1 : wm.host.screen.width >> 1;
      const cy = area ? (area.top + area.bottom) >> 1 : wm.host.screen.height >> 1;
      x = cx - (width >> 1);
      y = cy - (height >> 1);
    } else {
      let px = mulDiv(t.x, units.cx, 4);
      let py = mulDiv(t.y, units.cy, 8);
      if (!(style & DS_ABSALIGN) && owner) {
        const o = wm.clientToScreen(owner, {x: 0, y: 0});
        px += o.x;
        py += o.y;
      }
      x = px + frame.left;
      y = py + frame.top;
    }
    if (!(style & WS_CHILD)) {
      // Keep the dialog on the screen.
      const s = wm.host.screen;
      x = Math.max(0, Math.min(x, s.width - width));
      y = Math.max(0, Math.min(y, s.height - height));
    }
    const font = t.font ? this.#nextFont++ : 0;
    const st: DialogState = {
      units,
      font,
      modal,
      ended: false,
      result: 0,
      defId: 0,
      finish: null,
    };
    const visible = (style & WS_VISIBLE) !== 0;
    const className = t.className ?? DIALOG_CLASS_ATOM;
    // The dialog procedure and state are in place before WM_NCCREATE.
    wm.creationHook = (created) => {
      wm.creationHook = null;
      created.state = st;
      this.#dialogs.add(created);
      if (created.extra.byteLength >= 8)
        created.extra.setUint32(DWL_DLGPROC, wm.process.code.pointerOf(dialogProc), true);
    };
    let hwnd: number;
    try {
      hwnd = wm.create(
        exStyle,
        className,
        t.title,
        style & ~WS_VISIBLE,
        x,
        y,
        width,
        height,
        ownerHandle,
        typeof t.menu === 'number' ? t.menu : 0,
        instance,
        0,
      );
    } finally {
      wm.creationHook = null;
    }
    const w = hwnd ? wm.peek(hwnd) : null;
    if (!w) return null;
    if (font) wm.send(w, WM_SETFONT, font, 0);
    // Controls, in template order.
    let focus: Window | null = null;
    for (const item of t.items) {
      const cls =
        typeof item.className === 'number'
          ? (CLASS_ORDINALS.get(item.className) ?? item.className)
          : (item.className ?? '');
      const c = wm.create(
        item.exStyle | WS_EX_NOPARENTNOTIFY,
        cls,
        typeof item.title === 'string' ? item.title : '',
        item.style | WS_CHILD,
        mulDiv(item.x, units.cx, 4),
        mulDiv(item.y, units.cy, 8),
        mulDiv(item.cx, units.cx, 4),
        mulDiv(item.cy, units.cy, 8),
        hwnd,
        item.id,
        instance,
        item.data,
      );
      const child = c ? wm.peek(c) : null;
      if (!child) {
        wm.destroy(hwnd);
        return null;
      }
      if (font) wm.send(child, WM_SETFONT, font, 0);
      const code = wm.send(child, WM_GETDLGCODE, 0, 0);
      if (code & DLGC_DEFPUSHBUTTON) st.defId = item.id;
      if (!focus && item.style & WS_TABSTOP && !(item.style & WS_DISABLED)) focus = child;
    }
    if (w.destroyed) return null;
    const r = wm.send(w, WM_INITDIALOG, focus?.hwnd ?? 0, initParam);
    if (w.destroyed) return null;
    if (r && focus && !focus.destroyed) wm.setFocus(focus);
    if (visible && !(w.style & WS_VISIBLE)) wm.showWindow(w, 1);
    return w;
  }

  /** `DialogBoxIndirectParamW`. */
  dialogBox(
    instance: number,
    templateAddress: number,
    ownerHandle: number,
    dialogProc: WindowProcedure,
    initParam: number,
  ): Promise<number> {
    const wm = this.wm;
    const owner = ownerHandle ? wm.peek(ownerHandle) : null;
    if (ownerHandle && !owner) {
      wm.get(ownerHandle);
      return Promise.resolve(-1);
    }
    const ownerRoot = owner ? wm.rootOwner(owner) : null;
    const reenable = ownerRoot !== null && !(ownerRoot.style & WS_DISABLED);
    if (reenable) wm.enable(ownerRoot!, false);
    const w = this.create(instance, templateAddress, ownerHandle, dialogProc, initParam, true);
    if (!w) {
      if (reenable && !ownerRoot!.destroyed) wm.enable(ownerRoot!, true);
      return Promise.resolve(-1);
    }
    const st = this.state(w)!;
    return new Promise<number>((resolve) => {
      st.finish = (result) => {
        if (reenable && !ownerRoot!.destroyed) wm.enable(ownerRoot!, true);
        if (!w.destroyed) wm.destroy(w.hwnd);
        resolve(result);
      };
      if (st.ended) wm.host.post(() => st.finish!(st.result));
      else if (!(w.style & WS_VISIBLE)) wm.showWindow(w, 1);
    });
  }

  /** `EndDialog`. */
  end(w: Window, result: number): boolean {
    const st = this.state(w);
    if (!st) {
      this.wm.setError(ERROR_INVALID_PARAMETER);
      return false;
    }
    if (st.ended) return true;
    st.ended = true;
    st.result = result;
    if (w.style & WS_VISIBLE) this.wm.showWindow(w, 0);
    if (st.finish) {
      const finish = st.finish;
      this.wm.host.post(() => finish(result));
    }
    return true;
  }

  /** `IsDialogMessageW`: keyboard navigation and dispatch of messages for the dialog. */
  isDialogMessage(dialog: Window, msg: Message): boolean {
    const wm = this.wm;
    const target = wm.peek(msg.hwnd);
    if (!target || (target !== dialog && !wm.isAncestor(dialog, target))) return false;
    if (msg.message === WM_KEYDOWN) {
      const code = wm.send(target, WM_GETDLGCODE, msg.wParam, 0);
      if (!(code & (DLGC_WANTALLKEYS | DLGC_WANTMESSAGE))) {
        switch (msg.wParam) {
          case VK_TAB:
            if (!(code & DLGC_WANTTAB)) {
              this.#nextTab(dialog, target);
              return true;
            }
            break;
          case VK_RETURN: {
            const st = this.state(dialog);
            const id = st?.defId || IDOK;
            const btn = this.item(dialog, id);
            if (btn && btn.style & WS_DISABLED) return true;
            wm.send(dialog, WM_COMMAND, (BN_CLICKED << 16) | id, btn?.hwnd ?? 0);
            return true;
          }
          case VK_ESCAPE: {
            const btn = this.item(dialog, IDCANCEL);
            wm.send(dialog, WM_COMMAND, (BN_CLICKED << 16) | IDCANCEL, btn?.hwnd ?? 0);
            return true;
          }
        }
      }
    }
    if (msg.message === WM_CHAR && (msg.wParam === 9 || msg.wParam === 13 || msg.wParam === 27))
      return true;
    wm.send(target, msg.message, msg.wParam, msg.lParam);
    return true;
  }

  /** Moves the focus to the next `WS_TABSTOP` control (`GetNextDlgTabItem`). */
  #nextTab(dialog: Window, from: Window): void {
    const list = [...this.wm.descendants(dialog)].filter(
      (c) => c.style & WS_TABSTOP && c.style & WS_VISIBLE && !(c.style & WS_DISABLED),
    );
    if (!list.length) return;
    const i = list.indexOf(from);
    this.wm.setFocus(list[(i + 1) % list.length]!);
  }

  /** `GetDlgItemInt`. */
  static parseInt(text: string, signed: boolean): number | null {
    const m = /^\s*(-?)(\d+)\s*$/.exec(text);
    if (!m || (m[1] && !signed)) return null;
    const v = Number((m[1] ?? '') + (m[2] ?? ''));
    if (signed ? v < -2147483648 || v > 2147483647 : v > 4294967295) return null;
    return v;
  }

  readWide(address: number): string {
    return readWideString(this.wm.process.memory, address);
  }
}
