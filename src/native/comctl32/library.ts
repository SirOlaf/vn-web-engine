/**
 * `comctl32.dll` (version 6) on `user32.dll`: `InitCommonControlsEx` registers the classes of
 * the requested sets as global window classes. Implemented controls: progress bar
 * (`msctls_progress32`), trackbar (`msctls_trackbar32`), up-down (`msctls_updown32`), tab
 * control (`SysTabControl32`) and `ComboBoxEx32`. A set with classes that are not implemented
 * is not registered and `InitCommonControlsEx` returns false; creating such a control then
 * fails with `ERROR_CANNOT_FIND_WND_CLASS`. Property sheets are not available.
 */
import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {
  readWideString,
  writeWideString,
  type NativeAddressSpace,
} from '../../platform/native-process.js';
import {KERNEL32, type Kernel32Exports} from '../kernel32/contract.js';
import {
  USER32,
  WM_COMMAND,
  WM_GETFONT,
  WM_HSCROLL,
  WM_NOTIFY,
  WM_SETFONT,
  WM_VSCROLL,
  type User32Exports,
  type WindowProcedure,
} from '../user32/contract.js';
import {
  COMCTL32,
  ICC_BAR_CLASSES,
  ICC_PROGRESS_CLASS,
  ICC_STANDARD_CLASSES,
  ICC_TAB_CLASSES,
  ICC_UPDOWN_CLASS,
  ICC_USEREX_CLASSES,
  type Comctl32Exports,
} from './contract.js';

const ERROR_CALL_NOT_IMPLEMENTED = 120;
const CS_GLOBALCLASS = 0x4000;

// Progress bar.
const PBM_SETRANGE = 0x0401;
const PBM_SETPOS = 0x0402;
const PBM_DELTAPOS = 0x0403;
const PBM_SETSTEP = 0x0404;
const PBM_STEPIT = 0x0405;
const PBM_SETRANGE32 = 0x0406;
const PBM_GETRANGE = 0x0407;
const PBM_GETPOS = 0x0408;
const PBM_SETBARCOLOR = 0x0409;
const PBM_SETMARQUEE = 0x040a;
const PBM_SETBKCOLOR = 0x2001;
const PBM_GETSTEP = 0x040d;
const PBM_GETBKCOLOR = 0x040e;
const PBM_GETBARCOLOR = 0x040f;
const PBM_SETSTATE = 0x0410;
const PBM_GETSTATE = 0x0411;
const CLR_DEFAULT = 0xff000000 | 0;

// Trackbar.
const TBM_GETPOS = 0x0400;
const TBM_GETRANGEMIN = 0x0401;
const TBM_GETRANGEMAX = 0x0402;
const TBM_GETTIC = 0x0403;
const TBM_SETTIC = 0x0404;
const TBM_SETPOS = 0x0405;
const TBM_SETRANGE = 0x0406;
const TBM_SETRANGEMIN = 0x0407;
const TBM_SETRANGEMAX = 0x0408;
const TBM_CLEARTICS = 0x0409;
const TBM_SETSEL = 0x040a;
const TBM_SETSELSTART = 0x040b;
const TBM_SETSELEND = 0x040c;
const TBM_GETNUMTICS = 0x0410;
const TBM_GETSELSTART = 0x0411;
const TBM_GETSELEND = 0x0412;
const TBM_CLEARSEL = 0x0413;
const TBM_SETTICFREQ = 0x0414;
const TBM_SETPAGESIZE = 0x0415;
const TBM_GETPAGESIZE = 0x0416;
const TBM_SETLINESIZE = 0x0417;
const TBM_GETLINESIZE = 0x0418;
const TBM_SETPOSNOTIFY = 0x0422;
const TBS_VERT = 0x0002;
const TB_THUMBPOSITION = 4;
const TB_ENDTRACK = 8;

// Up-down.
const UDM_SETRANGE = 0x0465;
const UDM_GETRANGE = 0x0466;
const UDM_SETPOS = 0x0467;
const UDM_GETPOS = 0x0468;
const UDM_SETBUDDY = 0x0469;
const UDM_GETBUDDY = 0x046a;
const UDM_SETACCEL = 0x046b;
const UDM_GETACCEL = 0x046c;
const UDM_SETBASE = 0x046d;
const UDM_GETBASE = 0x046e;
const UDM_SETRANGE32 = 0x046f;
const UDM_GETRANGE32 = 0x0470;
const UDM_SETPOS32 = 0x0471;
const UDM_GETPOS32 = 0x0472;
const UDS_SETBUDDYINT = 0x0002;
const UDN_DELTAPOS = -722;

// Tab control.
const TCM_GETITEMCOUNT = 0x1304;
const TCM_DELETEITEM = 0x1308;
const TCM_DELETEALLITEMS = 0x1309;
const TCM_GETCURSEL = 0x130b;
const TCM_SETCURSEL = 0x130c;
const TCM_ADJUSTRECT = 0x1328;
const TCM_GETCURFOCUS = 0x132f;
const TCM_SETCURFOCUS = 0x1330;
const TCM_GETITEMW = 0x133c;
const TCM_SETITEMW = 0x133d;
const TCM_INSERTITEMW = 0x133e;
const TCIF_TEXT = 0x0001;
const TCIF_IMAGE = 0x0002;
const TCIF_PARAM = 0x0008;
const TCN_SELCHANGE = -551;
const TCN_SELCHANGING = -552;
/** Tab row height and border of the default tab control at 96 DPI. */
const TAB_ROW_HEIGHT = 21;
const TAB_BORDER = 2;

// ComboBoxEx.
const CBEM_INSERTITEMW = 0x040b;
const CBEM_SETITEMW = 0x040c;
const CBEM_GETITEMW = 0x040d;
const CBEM_DELETEITEM = 0x0144;
const CBEM_GETCOMBOCONTROL = 0x0406;
const CBEM_GETEDITCONTROL = 0x0407;
const CBEM_SETEXTENDEDSTYLE = 0x040e;
const CBEM_GETEXTENDEDSTYLE = 0x0409;
const CBEIF_TEXT = 0x0001;
const CBEIF_LPARAM = 0x0020;

interface CommonState {
  font: number;
}

function lowHigh(lo: number, hi: number): number {
  return ((hi & 0xffff) << 16) | (lo & 0xffff);
}

class Comctl32 implements Comctl32Exports {
  readonly #state = new Map<number, unknown>();
  readonly #mem: NativeAddressSpace;

  constructor(
    private readonly user32: User32Exports,
    private readonly kernel32: Kernel32Exports,
    memory: NativeAddressSpace,
  ) {
    this.#mem = memory;
  }

  #dv(): DataView {
    return new DataView(this.#mem.u8.buffer);
  }

  #register(className: string, wndProc: WindowProcedure): boolean {
    const atom = this.user32.RegisterClassExW({
      style: CS_GLOBALCLASS,
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
    });
    return atom !== 0 || this.user32.GetClassInfoExW(0, className) !== null;
  }

  #stateOf<T>(hwnd: number, init: () => T): T {
    let s = this.#state.get(hwnd) as T | undefined;
    if (s === undefined) this.#state.set(hwnd, (s = init()));
    return s;
  }

  #notify(
    hwnd: number,
    code: number,
    extra: (address: number) => void = () => {},
    size = 12,
  ): number {
    const u = this.user32;
    const parent = u.GetParent(hwnd);
    if (!parent) return 0;
    const id = u.GetDlgCtrlID(hwnd);
    const nm = this.#mem.allocate(Math.max(size, 12), 'NMHDR');
    const d = this.#dv();
    d.setUint32(nm, hwnd, true);
    d.setUint32(nm + 4, id, true);
    d.setInt32(nm + 8, code, true);
    extra(nm);
    try {
      return u.SendMessageW(parent, WM_NOTIFY, id, nm);
    } finally {
      this.#mem.free(nm, Math.max(size, 12));
    }
  }

  #common(
    hwnd: number,
    msg: number,
    wParam: number,
    lParam: number,
    st: CommonState,
  ): number | null {
    switch (msg) {
      case WM_SETFONT:
        st.font = wParam;
        return 0;
      case WM_GETFONT:
        return st.font;
      case 0x0082: // WM_NCDESTROY
        this.#state.delete(hwnd);
        return this.user32.DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    return null;
  }

  // --- progress bar ---------------------------------------------------------------------------
  readonly #progress: WindowProcedure = (hwnd, msg, wParam, lParam) => {
    const st = this.#stateOf(hwnd, () => ({
      font: 0,
      min: 0,
      max: 100,
      pos: 0,
      step: 10,
      bar: CLR_DEFAULT,
      bk: CLR_DEFAULT,
      state: 1,
      marquee: false,
    }));
    const set = (pos: number) => {
      const prev = st.pos;
      st.pos = Math.min(Math.max(pos, st.min), st.max);
      this.user32.InvalidateRect(hwnd, null, false);
      return prev;
    };
    switch (msg) {
      case PBM_SETRANGE: {
        const prev = lowHigh(st.min, st.max);
        st.min = lParam & 0xffff;
        st.max = lParam >>> 16;
        set(st.pos);
        return prev;
      }
      case PBM_SETRANGE32: {
        const prev = lowHigh(st.min, st.max);
        st.min = wParam | 0;
        st.max = lParam | 0;
        set(st.pos);
        return prev;
      }
      case PBM_GETRANGE:
        if (lParam) {
          this.#dv().setInt32(lParam, st.min, true);
          this.#dv().setInt32(lParam + 4, st.max, true);
        }
        return wParam ? st.min : st.max;
      case PBM_SETPOS:
        return set(wParam | 0);
      case PBM_DELTAPOS:
        return set(st.pos + (wParam | 0));
      case PBM_SETSTEP: {
        const prev = st.step;
        st.step = wParam | 0;
        return prev;
      }
      case PBM_GETSTEP:
        return st.step;
      case PBM_STEPIT: {
        let next = st.pos + st.step;
        if (next > st.max) next = st.min + ((next - st.min) % (st.max - st.min || 1));
        return set(next);
      }
      case PBM_GETPOS:
        return st.pos;
      case PBM_SETBARCOLOR: {
        const prev = st.bar;
        st.bar = lParam;
        return prev;
      }
      case PBM_GETBARCOLOR:
        return st.bar;
      case PBM_SETBKCOLOR: {
        const prev = st.bk;
        st.bk = lParam;
        return prev;
      }
      case PBM_GETBKCOLOR:
        return st.bk;
      case PBM_SETMARQUEE:
        st.marquee = wParam !== 0;
        return 1;
      case PBM_SETSTATE: {
        const prev = st.state;
        st.state = wParam;
        return prev;
      }
      case PBM_GETSTATE:
        return st.state;
    }
    return (
      this.#common(hwnd, msg, wParam, lParam, st) ??
      this.user32.DefWindowProcW(hwnd, msg, wParam, lParam)
    );
  };

  // --- trackbar ---------------------------------------------------------------------------------
  readonly #trackbar: WindowProcedure = (hwnd, msg, wParam, lParam) => {
    const st = this.#stateOf(hwnd, () => ({
      font: 0,
      min: 0,
      max: 100,
      pos: 0,
      page: 20,
      line: 1,
      selStart: 0,
      selEnd: 0,
      tics: [] as number[],
      freq: 1,
    }));
    const clamp = (v: number) => Math.min(Math.max(v, st.min), st.max);
    const redraw = () => this.user32.InvalidateRect(hwnd, null, false);
    switch (msg) {
      case TBM_GETPOS:
        return st.pos;
      case TBM_GETRANGEMIN:
        return st.min;
      case TBM_GETRANGEMAX:
        return st.max;
      case TBM_SETPOS:
      case TBM_SETPOSNOTIFY:
        st.pos = clamp(lParam | 0);
        if (msg === TBM_SETPOSNOTIFY) this.#scrollNotify(hwnd, TB_THUMBPOSITION, st.pos);
        if (wParam || msg === TBM_SETPOSNOTIFY) redraw();
        return 0;
      case TBM_SETRANGE:
        st.min = lParam & 0x8000 ? (lParam & 0xffff) - 0x10000 : lParam & 0xffff;
        st.max = (lParam >> 16) | 0;
        st.pos = clamp(st.pos);
        if (wParam) redraw();
        return 0;
      case TBM_SETRANGEMIN:
        st.min = lParam | 0;
        st.pos = clamp(st.pos);
        if (wParam) redraw();
        return 0;
      case TBM_SETRANGEMAX:
        st.max = lParam | 0;
        st.pos = clamp(st.pos);
        if (wParam) redraw();
        return 0;
      case TBM_SETPAGESIZE: {
        const prev = st.page;
        st.page = lParam | 0;
        return prev;
      }
      case TBM_GETPAGESIZE:
        return st.page;
      case TBM_SETLINESIZE: {
        const prev = st.line;
        st.line = lParam | 0;
        return prev;
      }
      case TBM_GETLINESIZE:
        return st.line;
      case TBM_SETTIC:
        if ((lParam | 0) < st.min || (lParam | 0) > st.max) return 0;
        st.tics.push(lParam | 0);
        return 1;
      case TBM_GETTIC:
        return st.tics[wParam | 0] ?? -1;
      case TBM_CLEARTICS:
        st.tics = [];
        return 0;
      case TBM_GETNUMTICS:
        return st.tics.length + 2;
      case TBM_SETTICFREQ:
        st.freq = wParam | 0;
        return 0;
      case TBM_SETSEL:
        st.selStart = lParam & 0xffff;
        st.selEnd = lParam >>> 16;
        return 0;
      case TBM_SETSELSTART:
        st.selStart = lParam | 0;
        return 0;
      case TBM_SETSELEND:
        st.selEnd = lParam | 0;
        return 0;
      case TBM_GETSELSTART:
        return st.selStart;
      case TBM_GETSELEND:
        return st.selEnd;
      case TBM_CLEARSEL:
        st.selStart = st.selEnd = 0;
        return 0;
      case 0x0202: {
        // WM_LBUTTONUP: the host reports a thumb drop through wParam, the new position.
        st.pos = clamp(wParam | 0);
        this.#scrollNotify(hwnd, TB_THUMBPOSITION, st.pos);
        this.#scrollNotify(hwnd, TB_ENDTRACK, 0);
        redraw();
        return 0;
      }
    }
    return (
      this.#common(hwnd, msg, wParam, lParam, st) ??
      this.user32.DefWindowProcW(hwnd, msg, wParam, lParam)
    );
  };

  #scrollNotify(hwnd: number, code: number, pos: number): void {
    const u = this.user32;
    const parent = u.GetParent(hwnd);
    if (!parent) return;
    const vert = u.GetWindowLongW(hwnd, -16) & TBS_VERT;
    u.SendMessageW(parent, vert ? WM_VSCROLL : WM_HSCROLL, lowHigh(code, pos), hwnd);
  }

  // --- up-down ----------------------------------------------------------------------------------
  readonly #updown: WindowProcedure = (hwnd, msg, wParam, lParam) => {
    const st = this.#stateOf(hwnd, () => ({font: 0, min: 100, max: 0, pos: 0, buddy: 0, base: 10}));
    const u = this.user32;
    const clamp = (v: number) =>
      st.min <= st.max
        ? Math.min(Math.max(v, st.min), st.max)
        : Math.min(Math.max(v, st.max), st.min);
    const updateBuddy = () => {
      if (st.buddy && u.GetWindowLongW(hwnd, -16) & UDS_SETBUDDYINT)
        u.SetWindowTextW(
          st.buddy,
          st.base === 16 ? '0x' + (st.pos >>> 0).toString(16).toUpperCase() : String(st.pos),
        );
    };
    switch (msg) {
      case UDM_SETRANGE:
        st.max = (lParam << 16) >> 16;
        st.min = lParam >> 16;
        return 0;
      case UDM_GETRANGE:
        return lowHigh(st.max, st.min);
      case UDM_SETRANGE32:
        st.min = wParam | 0;
        st.max = lParam | 0;
        return 0;
      case UDM_GETRANGE32:
        if (wParam) this.#dv().setInt32(wParam, st.min, true);
        if (lParam) this.#dv().setInt32(lParam, st.max, true);
        return 0;
      case UDM_SETPOS:
      case UDM_SETPOS32: {
        const prev = st.pos;
        st.pos = clamp(msg === UDM_SETPOS ? (lParam << 16) >> 16 : lParam | 0);
        updateBuddy();
        return prev;
      }
      case UDM_GETPOS:
        return st.pos & 0xffff;
      case UDM_GETPOS32:
        if (lParam) this.#dv().setInt32(lParam, 0, true);
        return st.pos;
      case UDM_SETBUDDY: {
        const prev = st.buddy;
        st.buddy = wParam;
        return prev;
      }
      case UDM_GETBUDDY:
        return st.buddy;
      case UDM_SETBASE: {
        if (wParam !== 10 && wParam !== 16) return 0;
        const prev = st.base;
        st.base = wParam;
        return prev;
      }
      case UDM_GETBASE:
        return st.base;
      case UDM_SETACCEL:
        return 1;
      case UDM_GETACCEL:
        return 0;
      case 0x0202: {
        // WM_LBUTTONUP: the host reports an arrow click through wParam (+1 or -1).
        const delta = (wParam | 0) * (st.min <= st.max ? 1 : -1);
        const blocked = this.#notify(
          hwnd,
          UDN_DELTAPOS,
          (a) => {
            this.#dv().setInt32(a + 12, st.pos, true);
            this.#dv().setInt32(a + 16, delta, true);
          },
          20,
        );
        if (!blocked) {
          st.pos = clamp(st.pos + delta);
          updateBuddy();
          const parent = u.GetParent(hwnd);
          if (parent) u.SendMessageW(parent, WM_VSCROLL, lowHigh(TB_THUMBPOSITION, st.pos), hwnd);
        }
        return 0;
      }
    }
    return (
      this.#common(hwnd, msg, wParam, lParam, st) ?? u.DefWindowProcW(hwnd, msg, wParam, lParam)
    );
  };

  // --- tab control ------------------------------------------------------------------------------
  readonly #tab: WindowProcedure = (hwnd, msg, wParam, lParam) => {
    const st = this.#stateOf(hwnd, () => ({
      font: 0,
      items: [] as {text: string; image: number; param: number}[],
      cur: -1,
      focus: -1,
    }));
    const d = () => this.#dv();
    const readItem = (address: number, item: {text: string; image: number; param: number}) => {
      const mask = d().getUint32(address, true);
      if (mask & TCIF_TEXT)
        item.text = readWideString(this.#mem, d().getUint32(address + 12, true));
      if (mask & TCIF_IMAGE) item.image = d().getInt32(address + 20, true);
      if (mask & TCIF_PARAM) item.param = d().getInt32(address + 24, true);
    };
    switch (msg) {
      case TCM_GETITEMCOUNT:
        return st.items.length;
      case TCM_INSERTITEMW: {
        const item = {text: '', image: -1, param: 0};
        readItem(lParam, item);
        const i = Math.min(Math.max(wParam | 0, 0), st.items.length);
        st.items.splice(i, 0, item);
        if (st.cur < 0) st.cur = 0;
        else if (i <= st.cur && st.items.length > 1) st.cur++;
        this.user32.InvalidateRect(hwnd, null, false);
        return i;
      }
      case TCM_SETITEMW: {
        const item = st.items[wParam | 0];
        if (!item) return 0;
        readItem(lParam, item);
        return 1;
      }
      case TCM_GETITEMW: {
        const item = st.items[wParam | 0];
        if (!item) return 0;
        const mask = d().getUint32(lParam, true);
        if (mask & TCIF_TEXT) {
          const buf = d().getUint32(lParam + 12, true);
          const max = d().getInt32(lParam + 16, true);
          if (buf && max > 0) writeWideString(this.#mem, buf, item.text.slice(0, max - 1));
        }
        if (mask & TCIF_IMAGE) d().setInt32(lParam + 20, item.image, true);
        if (mask & TCIF_PARAM) d().setInt32(lParam + 24, item.param, true);
        return 1;
      }
      case TCM_DELETEITEM: {
        const i = wParam | 0;
        if (i < 0 || i >= st.items.length) return 0;
        st.items.splice(i, 1);
        if (st.cur >= st.items.length) st.cur = st.items.length - 1;
        else if (st.cur > i) st.cur--;
        return 1;
      }
      case TCM_DELETEALLITEMS:
        st.items = [];
        st.cur = -1;
        return 1;
      case TCM_GETCURSEL:
        return st.cur;
      case TCM_SETCURSEL: {
        const i = wParam | 0;
        if (i < 0 || i >= st.items.length) return -1;
        const prev = st.cur;
        st.cur = i;
        this.user32.InvalidateRect(hwnd, null, false);
        return prev;
      }
      case TCM_GETCURFOCUS:
        return st.focus < 0 ? st.cur : st.focus;
      case TCM_SETCURFOCUS:
        st.focus = wParam | 0;
        return 0;
      case TCM_ADJUSTRECT: {
        // Display rectangle from window rectangle (wParam false) or the reverse.
        const r = lParam;
        const left = d().getInt32(r, true);
        const top = d().getInt32(r + 4, true);
        const right = d().getInt32(r + 8, true);
        const bottom = d().getInt32(r + 12, true);
        const s = wParam ? -1 : 1;
        d().setInt32(r, left + s * TAB_BORDER, true);
        d().setInt32(r + 4, top + s * (TAB_ROW_HEIGHT + TAB_BORDER), true);
        d().setInt32(r + 8, right - s * TAB_BORDER, true);
        d().setInt32(r + 12, bottom - s * TAB_BORDER, true);
        return 0;
      }
      case 0x0202: {
        // WM_LBUTTONUP: the host reports a click on a tab through wParam, the tab index.
        const i = wParam | 0;
        if (i < 0 || i >= st.items.length || i === st.cur) return 0;
        if (this.#notify(hwnd, TCN_SELCHANGING)) return 0;
        st.cur = i;
        this.user32.InvalidateRect(hwnd, null, false);
        this.#notify(hwnd, TCN_SELCHANGE);
        return 0;
      }
    }
    return (
      this.#common(hwnd, msg, wParam, lParam, st) ??
      this.user32.DefWindowProcW(hwnd, msg, wParam, lParam)
    );
  };

  // --- ComboBoxEx -------------------------------------------------------------------------------
  readonly #comboBoxEx: WindowProcedure = (hwnd, msg, wParam, lParam) => {
    const u = this.user32;
    const st = this.#stateOf(hwnd, () => ({font: 0, combo: 0, exStyle: 0, params: [] as number[]}));
    const d = () => this.#dv();
    if (msg === 0x0001) {
      // WM_CREATE: the embedded combo box, to which the ComboBoxEx forwards list messages.
      const r = u.GetClientRect(hwnd);
      st.combo = u.CreateWindowExW(
        0,
        'ComboBox',
        '',
        0x40000000 | 0x10000000 | (u.GetWindowLongW(hwnd, -16) & 0xffff),
        0,
        0,
        r?.right ?? 0,
        r?.bottom ?? 0,
        hwnd,
        u.GetDlgCtrlID(hwnd),
        0,
        0,
      );
      return st.combo ? 0 : -1;
    }
    if (!st.combo)
      return (
        this.#common(hwnd, msg, wParam, lParam, st) ?? u.DefWindowProcW(hwnd, msg, wParam, lParam)
      );
    const combo = st.combo;
    const textOf = (address: number): string | null => {
      const mask = d().getUint32(address, true);
      return mask & CBEIF_TEXT ? readWideString(this.#mem, d().getUint32(address + 8, true)) : null;
    };
    const withText = (text: string, call: (address: number) => number): number => {
      const size = (text.length + 1) * 2;
      const a = this.#mem.allocate(size, 'CBEM');
      writeWideString(this.#mem, a, text);
      try {
        return call(a);
      } finally {
        this.#mem.free(a, size);
      }
    };
    switch (msg) {
      case CBEM_INSERTITEMW: {
        const index = d().getInt32(lParam + 4, true);
        const text = textOf(lParam) ?? '';
        const i = withText(text, (a) => u.SendMessageW(combo, 0x014a, index, a));
        if (i >= 0 && d().getUint32(lParam, true) & CBEIF_LPARAM)
          u.SendMessageW(combo, 0x0151, i, d().getInt32(lParam + 36, true));
        return i;
      }
      case CBEM_SETITEMW: {
        const index = d().getInt32(lParam + 4, true);
        const text = textOf(lParam);
        if (text !== null) {
          const data = u.SendMessageW(combo, 0x0150, index, 0);
          u.SendMessageW(combo, 0x0144, index, 0);
          withText(text, (a) => u.SendMessageW(combo, 0x014a, index, a));
          u.SendMessageW(combo, 0x0151, index, data);
        }
        if (d().getUint32(lParam, true) & CBEIF_LPARAM)
          u.SendMessageW(combo, 0x0151, index, d().getInt32(lParam + 36, true));
        return 1;
      }
      case CBEM_GETITEMW: {
        const index = d().getInt32(lParam + 4, true);
        const mask = d().getUint32(lParam, true);
        if (mask & CBEIF_TEXT) {
          const len = u.SendMessageW(combo, 0x0149, index, 0);
          if (len < 0) return 0;
          const buf = d().getUint32(lParam + 8, true);
          const max = d().getInt32(lParam + 12, true);
          const tmp = this.#mem.allocate((len + 1) * 2, 'CBEM');
          u.SendMessageW(combo, 0x0148, index, tmp);
          const text = readWideString(this.#mem, tmp);
          this.#mem.free(tmp, (len + 1) * 2);
          if (buf && max > 0) writeWideString(this.#mem, buf, text.slice(0, max - 1));
        }
        if (mask & CBEIF_LPARAM)
          d().setInt32(lParam + 36, u.SendMessageW(combo, 0x0150, index, 0), true);
        return 1;
      }
      case CBEM_DELETEITEM:
        return u.SendMessageW(combo, 0x0144, wParam, 0);
      case CBEM_GETCOMBOCONTROL:
        return combo;
      case CBEM_GETEDITCONTROL:
        return 0;
      case CBEM_SETEXTENDEDSTYLE: {
        const prev = st.exStyle;
        st.exStyle = wParam ? (st.exStyle & ~wParam) | (lParam & wParam) : lParam;
        return prev;
      }
      case CBEM_GETEXTENDEDSTYLE:
        return st.exStyle;
      case WM_COMMAND: {
        // Notifications of the embedded combo box go to the ComboBoxEx's parent.
        const parent = u.GetParent(hwnd);
        return parent ? u.SendMessageW(parent, WM_COMMAND, wParam, hwnd) : 0;
      }
      case 0x000c: // WM_SETTEXT
      case 0x000d: // WM_GETTEXT
      case 0x000e: // WM_GETTEXTLENGTH
        return u.SendMessageW(combo, msg, wParam, lParam);
    }
    if (msg >= 0x0140 && msg <= 0x0163) return u.SendMessageW(combo, msg, wParam, lParam);
    return (
      this.#common(hwnd, msg, wParam, lParam, st) ?? u.DefWindowProcW(hwnd, msg, wParam, lParam)
    );
  };

  // --- exports ----------------------------------------------------------------------------------
  /** The class sets this implementation can register, by `ICC_*` flag. */
  readonly #sets: ReadonlyMap<number, readonly [string, WindowProcedure][]> = new Map([
    [ICC_PROGRESS_CLASS, [['msctls_progress32', this.#progress]]],
    [ICC_BAR_CLASSES, []],
    [ICC_UPDOWN_CLASS, [['msctls_updown32', this.#updown]]],
    [ICC_TAB_CLASSES, [['SysTabControl32', this.#tab]]],
    [ICC_USEREX_CLASSES, [['ComboBoxEx32', this.#comboBoxEx]]],
    [ICC_STANDARD_CLASSES, []],
  ]);

  InitCommonControls: Comctl32Exports['InitCommonControls'] = () => {
    this.InitCommonControlsEx(ICC_PROGRESS_CLASS | ICC_UPDOWN_CLASS | ICC_TAB_CLASSES);
  };

  InitCommonControlsEx: Comctl32Exports['InitCommonControlsEx'] = (icc) => {
    let ok = true;
    for (let bit = 1; bit <= 0x8000; bit <<= 1) {
      if (!(icc & bit)) continue;
      // ICC_BAR_CLASSES: toolbar, status bar, trackbar, tooltips; only the trackbar exists.
      if (bit === ICC_BAR_CLASSES) {
        ok = false;
        this.#register('msctls_trackbar32', this.#trackbar);
        continue;
      }
      const set = this.#sets.get(bit);
      if (!set) {
        ok = false;
        continue;
      }
      for (const [name, proc] of set) if (!this.#register(name, proc)) ok = false;
    }
    return ok;
  };

  CreatePropertySheetPageW: Comctl32Exports['CreatePropertySheetPageW'] = () => {
    this.kernel32.SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
    return 0;
  };

  DestroyPropertySheetPage: Comctl32Exports['DestroyPropertySheetPage'] = () => false;

  PropertySheetW: Comctl32Exports['PropertySheetW'] = async () => {
    this.kernel32.SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
    return -1;
  };
}

/** `comctl32.dll` version 6. */
export function comctl32Library(): NativeLibraryImplementation<Comctl32Exports> {
  return {
    contract: COMCTL32,
    identities: [{kind: 'system', fileName: 'comctl32.dll'}],
    imports: [
      {contract: KERNEL32, binding: 'static'},
      {contract: USER32, binding: 'static'},
    ],
    link(context) {
      return {
        exports: new Comctl32(
          context.staticImport(USER32),
          context.staticImport(KERNEL32),
          context.process.memory,
        ),
      };
    },
  };
}
