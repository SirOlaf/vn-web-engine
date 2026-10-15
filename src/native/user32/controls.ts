/**
 * The predefined control classes of `user32.dll` (Button, Static, Edit, ListBox, ComboBox,
 * ScrollBar): their state, the messages that query and change it, and the notifications they
 * send to the parent (`WM_COMMAND` with the control id and code). User input arrives as the
 * messages Windows sends a control (`WM_LBUTTONUP` on a button, `WM_CHAR` on an edit control).
 */
import {readWideString, writeWideString} from '../../platform/native-process.js';
import {
  SIF_PAGE,
  SIF_POS,
  SIF_RANGE,
  SIF_TRACKPOS,
  WM_CHAR,
  WM_COMMAND,
  WM_ENABLE,
  WM_GETDLGCODE,
  WM_GETFONT,
  WM_GETTEXT,
  WM_GETTEXTLENGTH,
  WM_KILLFOCUS,
  WM_LBUTTONUP,
  WM_NCCREATE,
  WM_SETFOCUS,
  WM_SETFONT,
  WM_SETTEXT,
  WS_DISABLED,
  WS_GROUP,
  WS_TABSTOP,
  type ScrollInfo,
  type WindowClassEx,
  type WindowProcedure,
} from './contract.js';
import {copyText, type Window, type WindowManager} from './windows.js';

// Dialog codes.
const DLGC_WANTARROWS = 0x0001;
const DLGC_WANTALLKEYS = 0x0004;
const DLGC_HASSETSEL = 0x0008;
const DLGC_DEFPUSHBUTTON = 0x0010;
const DLGC_UNDEFPUSHBUTTON = 0x0020;
const DLGC_RADIOBUTTON = 0x0040;
const DLGC_WANTCHARS = 0x0080;
const DLGC_STATIC = 0x0100;
const DLGC_BUTTON = 0x2000;

const LB_ERR = -1;
const CB_ERR = -1;

/** Messages of the controls (`winuser.h`). */
export const BM_GETCHECK = 0x00f0;
export const BM_SETCHECK = 0x00f1;
export const BM_GETSTATE = 0x00f2;
export const BM_SETSTATE = 0x00f3;
export const BM_SETSTYLE = 0x00f4;
export const BM_CLICK = 0x00f5;
export const BM_GETIMAGE = 0x00f6;
export const BM_SETIMAGE = 0x00f7;
export const BM_SETDONTCLICK = 0x00f8;
export const BN_CLICKED = 0;
export const BST_PUSHED = 0x0004;
export const BST_FOCUS = 0x0008;

export const STM_SETICON = 0x0170;
export const STM_GETICON = 0x0171;
export const STM_SETIMAGE = 0x0172;
export const STM_GETIMAGE = 0x0173;
const STN_CLICKED = 0;
const SS_NOTIFY = 0x0100;

export const EM_GETSEL = 0x00b0;
export const EM_SETSEL = 0x00b1;
export const EM_GETRECT = 0x00b2;
export const EM_SETRECT = 0x00b3;
export const EM_SETRECTNP = 0x00b4;
export const EM_SCROLL = 0x00b5;
export const EM_LINESCROLL = 0x00b6;
export const EM_SCROLLCARET = 0x00b7;
export const EM_GETMODIFY = 0x00b8;
export const EM_SETMODIFY = 0x00b9;
export const EM_GETLINECOUNT = 0x00ba;
export const EM_LINEINDEX = 0x00bb;
export const EM_LINELENGTH = 0x00c1;
export const EM_REPLACESEL = 0x00c2;
export const EM_GETLINE = 0x00c4;
export const EM_LIMITTEXT = 0x00c5;
export const EM_CANUNDO = 0x00c6;
export const EM_UNDO = 0x00c7;
export const EM_FMTLINES = 0x00c8;
export const EM_LINEFROMCHAR = 0x00c9;
export const EM_SETTABSTOPS = 0x00cb;
export const EM_SETPASSWORDCHAR = 0x00cc;
export const EM_EMPTYUNDOBUFFER = 0x00cd;
export const EM_GETFIRSTVISIBLELINE = 0x00ce;
export const EM_SETREADONLY = 0x00cf;
export const EM_GETPASSWORDCHAR = 0x00d2;
export const EM_SETMARGINS = 0x00d3;
export const EM_GETMARGINS = 0x00d4;
export const EM_GETLIMITTEXT = 0x00d5;
const EN_SETFOCUS = 0x0100;
const EN_KILLFOCUS = 0x0200;
const EN_CHANGE = 0x0300;
const EN_UPDATE = 0x0400;
const EN_MAXTEXT = 0x0501;
const ES_MULTILINE = 0x0004;
const ES_UPPERCASE = 0x0008;
const ES_LOWERCASE = 0x0010;
const ES_PASSWORD = 0x0020;
const ES_READONLY = 0x0800;
const ES_NUMBER = 0x2000;

export const LB_ADDSTRING = 0x0180;
export const LB_INSERTSTRING = 0x0181;
export const LB_DELETESTRING = 0x0182;
export const LB_RESETCONTENT = 0x0184;
export const LB_SETSEL = 0x0185;
export const LB_SETCURSEL = 0x0186;
export const LB_GETSEL = 0x0187;
export const LB_GETCURSEL = 0x0188;
export const LB_GETTEXT = 0x0189;
export const LB_GETTEXTLEN = 0x018a;
export const LB_GETCOUNT = 0x018b;
export const LB_SELECTSTRING = 0x018c;
export const LB_GETTOPINDEX = 0x018e;
export const LB_FINDSTRING = 0x018f;
export const LB_GETSELCOUNT = 0x0190;
export const LB_GETSELITEMS = 0x0191;
export const LB_SETTOPINDEX = 0x0197;
export const LB_GETITEMDATA = 0x0199;
export const LB_SETITEMDATA = 0x019a;
export const LB_SELITEMRANGE = 0x019b;
export const LB_SETANCHORINDEX = 0x019c;
export const LB_GETANCHORINDEX = 0x019d;
export const LB_SETCARETINDEX = 0x019e;
export const LB_GETCARETINDEX = 0x019f;
export const LB_FINDSTRINGEXACT = 0x01a2;
const LBN_SELCHANGE = 1;
const LBS_NOTIFY = 0x0001;
const LBS_SORT = 0x0002;
const LBS_MULTIPLESEL = 0x0008;
const LBS_OWNERDRAWFIXED = 0x0010;
const LBS_OWNERDRAWVARIABLE = 0x0020;
const LBS_HASSTRINGS = 0x0040;
const LBS_EXTENDEDSEL = 0x0800;

export const CB_GETEDITSEL = 0x0140;
export const CB_LIMITTEXT = 0x0141;
export const CB_SETEDITSEL = 0x0142;
export const CB_ADDSTRING = 0x0143;
export const CB_DELETESTRING = 0x0144;
export const CB_GETCOUNT = 0x0146;
export const CB_GETCURSEL = 0x0147;
export const CB_GETLBTEXT = 0x0148;
export const CB_GETLBTEXTLEN = 0x0149;
export const CB_INSERTSTRING = 0x014a;
export const CB_RESETCONTENT = 0x014b;
export const CB_FINDSTRING = 0x014c;
export const CB_SELECTSTRING = 0x014d;
export const CB_SETCURSEL = 0x014e;
export const CB_SHOWDROPDOWN = 0x014f;
export const CB_GETITEMDATA = 0x0150;
export const CB_SETITEMDATA = 0x0151;
export const CB_GETDROPPEDSTATE = 0x0157;
export const CB_FINDSTRINGEXACT = 0x0158;
export const CB_GETTOPINDEX = 0x015b;
export const CB_SETTOPINDEX = 0x015c;
const CBN_SELCHANGE = 1;
const CBN_EDITCHANGE = 5;
const CBN_EDITUPDATE = 6;
const CBN_DROPDOWN = 7;
const CBN_CLOSEUP = 8;
const CBS_DROPDOWNLIST = 0x0003;
const CBS_OWNERDRAWFIXED = 0x0010;
const CBS_OWNERDRAWVARIABLE = 0x0020;
const CBS_SORT = 0x0100;
const CBS_HASSTRINGS = 0x0200;

export const SBM_SETPOS = 0x00e0;
export const SBM_GETPOS = 0x00e1;
export const SBM_SETRANGE = 0x00e2;
export const SBM_GETRANGE = 0x00e3;
export const SBM_SETRANGEREDRAW = 0x00e6;
export const SBM_SETSCROLLINFO = 0x00e9;
export const SBM_GETSCROLLINFO = 0x00ea;

const BS_TYPEMASK = 0x000f;
const BS_PUSHBUTTON = 0;
const BS_DEFPUSHBUTTON = 1;
const BS_CHECKBOX = 2;
const BS_AUTOCHECKBOX = 3;
const BS_RADIOBUTTON = 4;
const BS_3STATE = 5;
const BS_AUTO3STATE = 6;
const BS_GROUPBOX = 7;
const BS_AUTORADIOBUTTON = 9;
const BS_OWNERDRAW = 11;

/** Default text limit of an edit control. */
const EDIT_DEFAULT_LIMIT = 30000;
/** `EM_LIMITTEXT(0)`: the largest limit. */
const EDIT_MAX_LIMIT = 0x7ffffffe;

function lowHigh(lo: number, hi: number): number {
  return ((hi & 0xffff) << 16) | (lo & 0xffff);
}

/** Case-insensitive order of list items (`lstrcmpiW`). */
function compareItems(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A scroll bar's range, page and position. */
export class ScrollState {
  min = 0;
  max = 100;
  page = 0;
  pos = 0;
  trackPos = 0;

  /** `SetScrollInfo`: returns the new position. */
  set(info: ScrollInfo): number {
    if (info.mask & SIF_RANGE) {
      this.min = info.min | 0;
      this.max = info.max | 0;
    }
    if (info.mask & SIF_PAGE) this.page = info.page >>> 0;
    if (info.mask & SIF_POS) this.pos = info.pos | 0;
    const span = Math.max(0, this.max - this.min + 1);
    if (this.page > span) this.page = span;
    const maxPos = this.max - Math.max(this.page - 1, 0);
    if (this.pos > maxPos) this.pos = maxPos;
    if (this.pos < this.min) this.pos = this.min;
    return this.pos;
  }

  /** `GetScrollInfo`: fills the members `info.mask` selects. */
  get(info: ScrollInfo): boolean {
    if (!(info.mask & (SIF_RANGE | SIF_PAGE | SIF_POS | SIF_TRACKPOS))) return false;
    if (info.mask & SIF_RANGE) {
      info.min = this.min;
      info.max = this.max;
    }
    if (info.mask & SIF_PAGE) info.page = this.page;
    if (info.mask & SIF_POS) info.pos = this.pos;
    if (info.mask & SIF_TRACKPOS) info.trackPos = this.trackPos;
    return true;
  }
}

interface ButtonState {
  check: number;
  pushed: boolean;
  focus: boolean;
  image: number;
  font: number;
}

interface StaticState {
  image: number;
  font: number;
}

interface EditState {
  selStart: number;
  selEnd: number;
  limit: number;
  modified: boolean;
  undo: string | null;
  passwordChar: number;
  margins: number;
  font: number;
}

interface ListItem {
  text: string;
  data: number;
  selected: boolean;
}

interface ListState {
  items: ListItem[];
  cur: number;
  top: number;
  anchor: number;
  caret: number;
  font: number;
  dropped: boolean;
  editSel: number;
  limit: number;
}

/** Registers the predefined control classes. */
export function registerControlClasses(wm: WindowManager): void {
  const mem = wm.process.memory;
  const str = (address: number) => (address ? readWideString(mem, address) : '');
  const notify = (w: Window, code: number) => {
    if (w.parent) wm.send(w.parent, WM_COMMAND, lowHigh(w.id, code), w.hwnd);
  };
  const register = (className: string, atom: number, wndProc: WindowProcedure) => {
    const cls: WindowClassEx = {
      style: 0,
      wndProc,
      clsExtra: 0,
      wndExtra: 0,
      instance: 0,
      icon: 0,
      cursor: 0,
      background: 0,
      menuName: null,
      className,
      iconSmall: 0,
    };
    wm.registerClass(cls, true, atom);
  };

  // --- Button ---------------------------------------------------------------------------------
  const buttonState = (w: Window): ButtonState =>
    (w.state ??= {check: 0, pushed: false, focus: false, image: 0, font: 0}) as ButtonState;
  const buttonType = (w: Window) => w.style & BS_TYPEMASK;
  const isCheckType = (t: number) =>
    t === BS_CHECKBOX ||
    t === BS_AUTOCHECKBOX ||
    t === BS_RADIOBUTTON ||
    t === BS_3STATE ||
    t === BS_AUTO3STATE ||
    t === BS_AUTORADIOBUTTON;
  const setCheck = (w: Window, value: number) => {
    const t = buttonType(w);
    if (!isCheckType(t)) return;
    const st = buttonState(w);
    st.check = t === BS_3STATE || t === BS_AUTO3STATE ? value & 3 : value & 1;
    if (t === BS_RADIOBUTTON || t === BS_AUTORADIOBUTTON)
      w.style = st.check ? (w.style | WS_TABSTOP) >>> 0 : w.style & ~WS_TABSTOP;
    wm.changed(w);
  };
  /** The auto radio buttons of `w`'s group, between `WS_GROUP` siblings. */
  const radioGroup = (w: Window): Window[] => {
    if (!w.parent) return [w];
    const siblings = [...w.parent.children].reverse();
    let i = siblings.indexOf(w);
    while (i > 0 && !(siblings[i]!.style & WS_GROUP)) i--;
    const group: Window[] = [];
    for (let j = i; j < siblings.length; j++) {
      if (j > i && siblings[j]!.style & WS_GROUP) break;
      group.push(siblings[j]!);
    }
    return group;
  };
  const click = (w: Window) => {
    const t = buttonType(w);
    const st = buttonState(w);
    if (t === BS_AUTOCHECKBOX) setCheck(w, st.check ? 0 : 1);
    else if (t === BS_AUTO3STATE) setCheck(w, (st.check + 1) % 3);
    else if (t === BS_AUTORADIOBUTTON) {
      for (const o of radioGroup(w))
        if (o !== w && o.cls === w.cls && buttonType(o) === BS_AUTORADIOBUTTON) setCheck(o, 0);
      setCheck(w, 1);
    }
    notify(w, BN_CLICKED);
  };
  register('Button', 0x0080, (hwnd, msg, wParam, lParam) => {
    const w = wm.peek(hwnd);
    if (!w) return 0;
    const st = buttonState(w);
    switch (msg) {
      case WM_GETDLGCODE: {
        const t = buttonType(w);
        if (t === BS_DEFPUSHBUTTON) return DLGC_BUTTON | DLGC_DEFPUSHBUTTON;
        if (t === BS_PUSHBUTTON || t === BS_OWNERDRAW) return DLGC_BUTTON | DLGC_UNDEFPUSHBUTTON;
        if (t === BS_RADIOBUTTON || t === BS_AUTORADIOBUTTON) return DLGC_BUTTON | DLGC_RADIOBUTTON;
        if (t === BS_GROUPBOX) return DLGC_STATIC;
        return DLGC_BUTTON;
      }
      case BM_GETCHECK:
        return isCheckType(buttonType(w)) ? st.check : 0;
      case BM_SETCHECK:
        setCheck(w, wParam);
        return 0;
      case BM_GETSTATE:
        return st.check | (st.pushed ? BST_PUSHED : 0) | (st.focus ? BST_FOCUS : 0);
      case BM_SETSTATE:
        st.pushed = wParam !== 0;
        wm.changed(w);
        return 0;
      case BM_SETSTYLE:
        w.style = ((w.style & ~BS_TYPEMASK) | (wParam & BS_TYPEMASK)) >>> 0;
        wm.changed(w);
        return 0;
      case BM_CLICK:
        if (!(w.style & WS_DISABLED)) click(w);
        return 0;
      case BM_GETIMAGE:
        return st.image;
      case BM_SETIMAGE: {
        const prev = st.image;
        st.image = lParam;
        wm.changed(w);
        return prev;
      }
      case BM_SETDONTCLICK:
        return 0;
      case WM_LBUTTONUP:
        if (!(w.style & WS_DISABLED)) click(w);
        return 0;
      case WM_SETFOCUS:
        st.focus = true;
        return 0;
      case WM_KILLFOCUS:
        st.focus = false;
        return 0;
      case WM_SETFONT:
        st.font = wParam;
        return 0;
      case WM_GETFONT:
        return st.font;
      case WM_ENABLE:
        wm.changed(w);
        return 0;
    }
    return wm.defWindowProc(hwnd, msg, wParam, lParam);
  });

  // --- Static ---------------------------------------------------------------------------------
  register('Static', 0x0082, (hwnd, msg, wParam, lParam) => {
    const w = wm.peek(hwnd);
    if (!w) return 0;
    const st = (w.state ??= {image: 0, font: 0}) as StaticState;
    switch (msg) {
      case WM_GETDLGCODE:
        return DLGC_STATIC;
      case STM_SETICON:
      case STM_SETIMAGE: {
        const prev = st.image;
        st.image = msg === STM_SETICON ? wParam : lParam;
        wm.changed(w);
        return prev;
      }
      case STM_GETICON:
      case STM_GETIMAGE:
        return st.image;
      case WM_LBUTTONUP:
        if (w.style & SS_NOTIFY) notify(w, STN_CLICKED);
        return 0;
      case WM_SETFONT:
        st.font = wParam;
        return 0;
      case WM_GETFONT:
        return st.font;
    }
    return wm.defWindowProc(hwnd, msg, wParam, lParam);
  });

  // --- Edit -----------------------------------------------------------------------------------
  const editState = (w: Window): EditState =>
    (w.state ??= {
      selStart: 0,
      selEnd: 0,
      limit: EDIT_DEFAULT_LIMIT,
      modified: false,
      undo: null,
      passwordChar: w.style & ES_PASSWORD ? 0x25cf : 0,
      margins: 0,
      font: 0,
    }) as EditState;
  const lines = (w: Window) => (w.style & ES_MULTILINE ? w.text.split('\r\n') : [w.text]);
  const lineStart = (w: Window, line: number): number => {
    const ls = lines(w);
    if (line < 0 || line >= ls.length) return -1;
    let p = 0;
    for (let i = 0; i < line; i++) p += ls[i]!.length + 2;
    return p;
  };
  const lineOf = (w: Window, index: number): number => {
    const ls = lines(w);
    let p = 0;
    for (let i = 0; i < ls.length; i++) {
      if (index <= p + ls[i]!.length) return i;
      p += ls[i]!.length + 2;
    }
    return ls.length - 1;
  };
  const editChanged = (w: Window) => {
    wm.changed(w);
    notify(w, EN_UPDATE);
    notify(w, EN_CHANGE);
  };
  const replaceSel = (w: Window, text: string, canUndo: boolean) => {
    const st = editState(w);
    const a = Math.min(st.selStart, st.selEnd);
    const b = Math.max(st.selStart, st.selEnd);
    if (canUndo) st.undo = w.text;
    w.text = w.text.slice(0, a) + text + w.text.slice(b);
    st.selStart = st.selEnd = a + text.length;
    st.modified = true;
    editChanged(w);
  };
  register('Edit', 0x0081, (hwnd, msg, wParam, lParam) => {
    const w = wm.peek(hwnd);
    if (!w) return 0;
    const st = editState(w);
    const len = w.text.length;
    switch (msg) {
      case WM_NCCREATE:
        return wm.defWindowProc(hwnd, msg, wParam, lParam);
      case WM_GETDLGCODE: {
        let code = DLGC_WANTCHARS | DLGC_HASSETSEL | DLGC_WANTARROWS;
        if (w.style & ES_MULTILINE) code |= DLGC_WANTALLKEYS;
        return code;
      }
      case WM_SETTEXT:
        w.text = lParam ? str(lParam) : '';
        st.selStart = st.selEnd = 0;
        st.undo = null;
        st.modified = false;
        if (w.style & ES_MULTILINE) wm.changed(w);
        else editChanged(w);
        return 1;
      case EM_GETSEL: {
        const dv = new DataView(mem.u8.buffer);
        const a = Math.min(st.selStart, st.selEnd);
        const b = Math.max(st.selStart, st.selEnd);
        if (wParam) dv.setUint32(wParam, a, true);
        if (lParam) dv.setUint32(lParam, b, true);
        return a > 0xffff || b > 0xffff ? -1 : lowHigh(a, b);
      }
      case EM_SETSEL: {
        let a = wParam | 0;
        let b = lParam | 0;
        if (a === -1) {
          st.selStart = st.selEnd = Math.min(st.selEnd, len);
          return 0;
        }
        if (b === -1 || b > len) b = len;
        if (a < 0 || a > len) a = len;
        st.selStart = a;
        st.selEnd = b;
        wm.changed(w);
        return 0;
      }
      case EM_GETMODIFY:
        return st.modified ? 1 : 0;
      case EM_SETMODIFY:
        st.modified = wParam !== 0;
        return 0;
      case EM_GETLINECOUNT:
        return lines(w).length;
      case EM_LINEINDEX:
        return lineStart(w, (wParam | 0) === -1 ? lineOf(w, st.selEnd) : wParam | 0);
      case EM_LINELENGTH: {
        if ((wParam | 0) === -1) {
          const a = Math.min(st.selStart, st.selEnd);
          const b = Math.max(st.selStart, st.selEnd);
          const la = lineStart(w, lineOf(w, a));
          const lb = lineStart(w, lineOf(w, b));
          return a - la + (lines(w)[lineOf(w, b)]!.length - (b - lb));
        }
        if ((wParam | 0) > len) return 0;
        return lines(w)[lineOf(w, wParam | 0)]!.length;
      }
      case EM_LINEFROMCHAR:
        return lineOf(w, (wParam | 0) === -1 ? st.selEnd : Math.min(wParam | 0, len));
      case EM_GETLINE: {
        const ls = lines(w);
        const line = w.style & ES_MULTILINE ? wParam | 0 : 0;
        if (line < 0 || line >= ls.length || !lParam) return 0;
        const max = new DataView(mem.u8.buffer).getUint16(lParam, true);
        const text = ls[line]!.slice(0, max);
        for (let i = 0; i < text.length; i++) {
          mem.u8[lParam + i * 2] = text.charCodeAt(i) & 0xff;
          mem.u8[lParam + i * 2 + 1] = text.charCodeAt(i) >>> 8;
        }
        return text.length;
      }
      case EM_REPLACESEL:
        replaceSel(w, str(lParam), wParam !== 0);
        return 0;
      case EM_LIMITTEXT:
        st.limit = wParam ? wParam >>> 0 : EDIT_MAX_LIMIT;
        return 0;
      case EM_GETLIMITTEXT:
        return st.limit;
      case EM_CANUNDO:
        return st.undo !== null ? 1 : 0;
      case EM_UNDO: {
        if (st.undo === null) return 0;
        const prev = w.text;
        w.text = st.undo;
        st.undo = prev;
        st.selStart = st.selEnd = w.text.length;
        editChanged(w);
        return 1;
      }
      case EM_EMPTYUNDOBUFFER:
        st.undo = null;
        return 0;
      case EM_FMTLINES:
        return wParam ? 1 : 0;
      case EM_SETTABSTOPS:
        return 1;
      case EM_SETPASSWORDCHAR:
        st.passwordChar = wParam & 0xffff;
        w.style = st.passwordChar ? (w.style | ES_PASSWORD) >>> 0 : w.style & ~ES_PASSWORD;
        wm.changed(w);
        return 0;
      case EM_GETPASSWORDCHAR:
        return st.passwordChar;
      case EM_GETFIRSTVISIBLELINE:
        return 0;
      case EM_SETREADONLY:
        w.style = wParam ? (w.style | ES_READONLY) >>> 0 : w.style & ~ES_READONLY;
        wm.changed(w);
        return 1;
      case EM_SETMARGINS:
        if (wParam & 1) st.margins = (st.margins & 0xffff0000) | (lParam & 0xffff);
        if (wParam & 2) st.margins = (st.margins & 0xffff) | (lParam & 0xffff0000);
        return 0;
      case EM_GETMARGINS:
        return st.margins;
      case EM_SCROLL:
      case EM_LINESCROLL:
      case EM_SCROLLCARET:
        return 1;
      case EM_GETRECT:
      case EM_SETRECT:
      case EM_SETRECTNP:
        return 0;
      case WM_CHAR: {
        if (w.style & ES_READONLY) return 0;
        let ch = String.fromCharCode(wParam & 0xffff);
        if (wParam === 8) {
          const a = Math.min(st.selStart, st.selEnd);
          if (st.selStart === st.selEnd && a > 0) st.selStart = a - 1;
          replaceSel(w, '', true);
          return 0;
        }
        if (wParam < 0x20 && !(wParam === 13 && w.style & ES_MULTILINE)) return 0;
        if (wParam === 13) ch = '\r\n';
        if (w.style & ES_NUMBER && !/^[0-9]$/.test(ch)) return 0;
        if (w.style & ES_UPPERCASE) ch = ch.toUpperCase();
        if (w.style & ES_LOWERCASE) ch = ch.toLowerCase();
        const selected = Math.abs(st.selEnd - st.selStart);
        if (len - selected + ch.length > st.limit) {
          notify(w, EN_MAXTEXT);
          return 0;
        }
        replaceSel(w, ch, true);
        return 0;
      }
      case WM_SETFOCUS:
        notify(w, EN_SETFOCUS);
        return 0;
      case WM_KILLFOCUS:
        notify(w, EN_KILLFOCUS);
        return 0;
      case WM_SETFONT:
        st.font = wParam;
        return 0;
      case WM_GETFONT:
        return st.font;
    }
    return wm.defWindowProc(hwnd, msg, wParam, lParam);
  });

  // --- ListBox and ComboBox -------------------------------------------------------------------
  const listState = (w: Window): ListState =>
    (w.state ??= {
      items: [],
      cur: -1,
      top: 0,
      anchor: -1,
      caret: 0,
      font: 0,
      dropped: false,
      editSel: 0,
      limit: 0,
    }) as ListState;
  const find = (items: ListItem[], start: number, text: string, exact: boolean): number => {
    const n = items.length;
    if (!n) return -1;
    const s = (start | 0) < -1 || (start | 0) >= n ? -1 : start | 0;
    const key = text.toUpperCase();
    for (let k = 1; k <= n; k++) {
      const i = (s + k) % n;
      const t = items[i]!.text.toUpperCase();
      if (exact ? t === key : t.startsWith(key)) return i;
    }
    return -1;
  };
  const insertItem = (
    w: Window,
    st: ListState,
    index: number,
    lParam: number,
    hasStrings: boolean,
    sorted: boolean,
  ): number => {
    const item: ListItem = hasStrings
      ? {text: str(lParam), data: 0, selected: false}
      : {text: '', data: lParam, selected: false};
    let i = index;
    if (sorted && hasStrings) {
      i = st.items.findIndex((o) => compareItems(item.text, o.text) < 0);
      if (i < 0) i = st.items.length;
    } else if (i < 0 || i > st.items.length) i = st.items.length;
    st.items.splice(i, 0, item);
    if (st.cur >= i) st.cur++;
    wm.changed(w);
    return i;
  };
  const getText = (st: ListState, index: number, address: number): number => {
    const item = st.items[index | 0];
    if (!item) return LB_ERR;
    if (!address) return item.text.length;
    writeWideString(mem, address, item.text);
    return item.text.length;
  };

  register('ListBox', 0x0083, (hwnd, msg, wParam, lParam) => {
    const w = wm.peek(hwnd);
    if (!w) return 0;
    const st = listState(w);
    const hasStrings =
      (w.style & (LBS_OWNERDRAWFIXED | LBS_OWNERDRAWVARIABLE)) === 0 ||
      (w.style & LBS_HASSTRINGS) !== 0;
    const multi = (w.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL)) !== 0;
    switch (msg) {
      case WM_GETDLGCODE:
        return DLGC_WANTARROWS | DLGC_WANTCHARS;
      case LB_ADDSTRING:
        return insertItem(w, st, -1, lParam, hasStrings, (w.style & LBS_SORT) !== 0);
      case LB_INSERTSTRING:
        return insertItem(w, st, wParam | 0, lParam, hasStrings, false);
      case LB_DELETESTRING: {
        const i = wParam | 0;
        if (i < 0 || i >= st.items.length) return LB_ERR;
        st.items.splice(i, 1);
        if (st.cur === i) st.cur = -1;
        else if (st.cur > i) st.cur--;
        wm.changed(w);
        return st.items.length;
      }
      case LB_RESETCONTENT:
        st.items = [];
        st.cur = -1;
        st.top = 0;
        wm.changed(w);
        return 0;
      case LB_GETCOUNT:
        return st.items.length;
      case LB_GETTEXT: {
        if (hasStrings) return getText(st, wParam, lParam);
        const item = st.items[wParam | 0];
        if (!item) return LB_ERR;
        new DataView(mem.u8.buffer).setUint32(lParam, item.data >>> 0, true);
        return 4;
      }
      case LB_GETTEXTLEN:
        return hasStrings ? (st.items[wParam | 0]?.text.length ?? LB_ERR) : 4;
      case LB_GETCURSEL:
        return multi ? st.caret : st.cur;
      case LB_SETCURSEL: {
        if (multi) return LB_ERR;
        const i = wParam | 0;
        st.cur = i >= 0 && i < st.items.length ? i : -1;
        wm.changed(w);
        return st.cur === -1 && i !== -1 ? LB_ERR : st.cur;
      }
      case LB_GETSEL: {
        const item = st.items[wParam | 0];
        if (!item) return LB_ERR;
        return (multi ? item.selected : st.cur === (wParam | 0)) ? 1 : 0;
      }
      case LB_SETSEL: {
        if (!multi) return LB_ERR;
        const i = lParam | 0;
        if (i === -1) for (const it of st.items) it.selected = wParam !== 0;
        else if (st.items[i]) st.items[i]!.selected = wParam !== 0;
        else return LB_ERR;
        wm.changed(w);
        return 0;
      }
      case LB_SELITEMRANGE: {
        if (!multi) return LB_ERR;
        const a = lParam & 0xffff;
        const b = lParam >>> 16;
        for (let i = Math.min(a, b); i <= Math.max(a, b) && i < st.items.length; i++)
          st.items[i]!.selected = wParam !== 0;
        wm.changed(w);
        return 0;
      }
      case LB_GETSELCOUNT:
        return multi ? st.items.filter((i) => i.selected).length : LB_ERR;
      case LB_GETSELITEMS: {
        if (!multi) return LB_ERR;
        const dv = new DataView(mem.u8.buffer);
        let n = 0;
        st.items.forEach((it, i) => {
          if (it.selected && n < wParam) dv.setInt32(lParam + 4 * n++, i, true);
        });
        return n;
      }
      case LB_FINDSTRING:
      case LB_FINDSTRINGEXACT:
        return find(st.items, wParam, str(lParam), msg === LB_FINDSTRINGEXACT);
      case LB_SELECTSTRING: {
        const i = find(st.items, wParam, str(lParam), false);
        if (i < 0 || multi) return LB_ERR;
        st.cur = i;
        wm.changed(w);
        return i;
      }
      case LB_GETITEMDATA:
        return st.items[wParam | 0]?.data ?? LB_ERR;
      case LB_SETITEMDATA: {
        const item = st.items[wParam | 0];
        if (!item) return LB_ERR;
        item.data = lParam;
        return 1;
      }
      case LB_GETTOPINDEX:
        return st.top;
      case LB_SETTOPINDEX:
        if ((wParam | 0) < 0 || (wParam | 0) >= Math.max(1, st.items.length)) return LB_ERR;
        st.top = wParam | 0;
        return 0;
      case LB_SETANCHORINDEX:
        st.anchor = wParam | 0;
        return 0;
      case LB_GETANCHORINDEX:
        return st.anchor;
      case LB_SETCARETINDEX:
        st.caret = wParam | 0;
        return 0;
      case LB_GETCARETINDEX:
        return st.caret;
      case WM_LBUTTONUP: {
        // The host reports a click on an item through wParam: the item index.
        const i = wParam | 0;
        if (i < 0 || i >= st.items.length || w.style & WS_DISABLED) return 0;
        if (multi) st.items[i]!.selected = !st.items[i]!.selected;
        st.cur = st.caret = i;
        wm.changed(w);
        if (w.style & LBS_NOTIFY) notify(w, LBN_SELCHANGE);
        return 0;
      }
      case WM_SETFONT:
        st.font = wParam;
        return 0;
      case WM_GETFONT:
        return st.font;
    }
    return wm.defWindowProc(hwnd, msg, wParam, lParam);
  });

  register('ComboBox', 0x0085, (hwnd, msg, wParam, lParam) => {
    const w = wm.peek(hwnd);
    if (!w) return 0;
    const st = listState(w);
    const hasStrings =
      (w.style & (CBS_OWNERDRAWFIXED | CBS_OWNERDRAWVARIABLE)) === 0 ||
      (w.style & CBS_HASSTRINGS) !== 0;
    const dropList = (w.style & 3) === CBS_DROPDOWNLIST;
    const select = (i: number) => {
      st.cur = i >= 0 && i < st.items.length ? i : -1;
      w.text = st.cur >= 0 ? st.items[st.cur]!.text : dropList ? '' : w.text;
      wm.changed(w);
    };
    switch (msg) {
      case WM_GETDLGCODE:
        return DLGC_WANTCHARS | DLGC_WANTARROWS;
      case CB_ADDSTRING:
        return insertItem(w, st, -1, lParam, hasStrings, (w.style & CBS_SORT) !== 0);
      case CB_INSERTSTRING:
        return insertItem(w, st, wParam | 0, lParam, hasStrings, false);
      case CB_DELETESTRING: {
        const i = wParam | 0;
        if (i < 0 || i >= st.items.length) return CB_ERR;
        st.items.splice(i, 1);
        if (st.cur === i) st.cur = -1;
        else if (st.cur > i) st.cur--;
        wm.changed(w);
        return st.items.length;
      }
      case CB_RESETCONTENT:
        st.items = [];
        st.cur = -1;
        if (dropList) w.text = '';
        wm.changed(w);
        return 0;
      case CB_GETCOUNT:
        return st.items.length;
      case CB_GETLBTEXT:
        return getText(st, wParam, lParam);
      case CB_GETLBTEXTLEN:
        return st.items[wParam | 0]?.text.length ?? CB_ERR;
      case CB_GETCURSEL:
        return st.cur;
      case CB_SETCURSEL:
        select(wParam | 0);
        return st.cur === -1 && (wParam | 0) !== -1 ? CB_ERR : st.cur;
      case CB_FINDSTRING:
      case CB_FINDSTRINGEXACT:
        return find(st.items, wParam, str(lParam), msg === CB_FINDSTRINGEXACT);
      case CB_SELECTSTRING: {
        const i = find(st.items, wParam, str(lParam), false);
        if (i < 0) return CB_ERR;
        select(i);
        return i;
      }
      case CB_GETITEMDATA:
        return st.items[wParam | 0]?.data ?? CB_ERR;
      case CB_SETITEMDATA: {
        const item = st.items[wParam | 0];
        if (!item) return CB_ERR;
        item.data = lParam;
        return 1;
      }
      case CB_SHOWDROPDOWN:
        if (st.dropped !== (wParam !== 0)) {
          st.dropped = wParam !== 0;
          notify(w, st.dropped ? CBN_DROPDOWN : CBN_CLOSEUP);
          wm.changed(w);
        }
        return 1;
      case CB_GETDROPPEDSTATE:
        return st.dropped ? 1 : 0;
      case CB_LIMITTEXT:
        st.limit = wParam >>> 0;
        return 1;
      case CB_GETEDITSEL:
        return st.editSel;
      case CB_SETEDITSEL:
        if (dropList) return CB_ERR;
        st.editSel = lParam;
        return 1;
      case CB_GETTOPINDEX:
        return st.top;
      case CB_SETTOPINDEX:
        st.top = wParam | 0;
        return 0;
      case WM_SETTEXT:
        if (dropList) return CB_ERR;
        w.text = lParam ? str(lParam) : '';
        wm.changed(w);
        return 1;
      case WM_GETTEXT:
        return copyText(wm.process, w.text, wParam, lParam);
      case WM_GETTEXTLENGTH:
        return w.text.length;
      case WM_CHAR: {
        if (dropList) return 0;
        w.text += String.fromCharCode(wParam & 0xffff);
        notify(w, CBN_EDITUPDATE);
        notify(w, CBN_EDITCHANGE);
        wm.changed(w);
        return 0;
      }
      case WM_LBUTTONUP: {
        // The host reports a pick from the list through wParam: the item index.
        const i = wParam | 0;
        if (i < 0 || i >= st.items.length || w.style & WS_DISABLED) return 0;
        select(i);
        notify(w, CBN_SELCHANGE);
        if (st.dropped) {
          st.dropped = false;
          notify(w, CBN_CLOSEUP);
        }
        return 0;
      }
      case WM_SETFONT:
        st.font = wParam;
        return 0;
      case WM_GETFONT:
        return st.font;
    }
    return wm.defWindowProc(hwnd, msg, wParam, lParam);
  });

  // --- ScrollBar ------------------------------------------------------------------------------
  register('ScrollBar', 0x0084, (hwnd, msg, wParam, lParam) => {
    const w = wm.peek(hwnd);
    if (!w) return 0;
    const st = (w.state ??= new ScrollState()) as ScrollState;
    const dv = () => new DataView(mem.u8.buffer);
    switch (msg) {
      case SBM_SETPOS: {
        const prev = st.pos;
        st.set({mask: SIF_POS, min: 0, max: 0, page: 0, pos: wParam | 0, trackPos: 0});
        wm.changed(w);
        return prev;
      }
      case SBM_GETPOS:
        return st.pos;
      case SBM_SETRANGE:
      case SBM_SETRANGEREDRAW: {
        const prev = st.pos;
        st.set({mask: SIF_RANGE, min: wParam | 0, max: lParam | 0, page: 0, pos: 0, trackPos: 0});
        wm.changed(w);
        return prev;
      }
      case SBM_GETRANGE:
        if (wParam) dv().setInt32(wParam, st.min, true);
        if (lParam) dv().setInt32(lParam, st.max, true);
        return 0;
      case SBM_SETSCROLLINFO:
      case SBM_GETSCROLLINFO: {
        const d = dv();
        const info: ScrollInfo = {
          mask: d.getUint32(lParam + 4, true),
          min: d.getInt32(lParam + 8, true),
          max: d.getInt32(lParam + 12, true),
          page: d.getUint32(lParam + 16, true),
          pos: d.getInt32(lParam + 20, true),
          trackPos: d.getInt32(lParam + 24, true),
        };
        if (msg === SBM_SETSCROLLINFO) {
          const r = st.set(info);
          wm.changed(w);
          return r;
        }
        if (!st.get(info)) return 0;
        writeScrollInfo(d, lParam, info);
        return 1;
      }
    }
    return wm.defWindowProc(hwnd, msg, wParam, lParam);
  });
}

/** Writes a `SCROLLINFO` (`cbSize` at 0). */
export function writeScrollInfo(dv: DataView, address: number, info: ScrollInfo): void {
  dv.setInt32(address + 8, info.min, true);
  dv.setInt32(address + 12, info.max, true);
  dv.setUint32(address + 16, info.page, true);
  dv.setInt32(address + 20, info.pos, true);
  dv.setInt32(address + 24, info.trackPos, true);
}
