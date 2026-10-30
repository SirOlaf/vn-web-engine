/**
 * `win32dialog.dll` (SHA-256 `a1da3fd6…`, miahmie, ncbind): the TJS class `WIN32Dialog`, which
 * builds dialog templates from script dictionaries and runs them as Win32 dialogs, with the
 * sub classes `Header`, `Items` (template parts), `Bitmap` (a layer as a GDI bitmap),
 * `SolidBrush`, `DrawItem` (`DRAWITEMSTRUCT`), `Notify` (`NMHDR`) and `Blob` (raw memory).
 *
 * The member set and the constants are those of this build (registration at 0x1000a710; it
 * has `propsheet`/`progress` but not the later `setActive`, `getWindowRect`, `getClientRect`
 * or `Blob.getDWordLong`). Dialogs, controls and GDI objects come from `user32.dll`,
 * `gdi32.dll` and `kernel32.dll`; common controls, property sheets and the colour dialog from
 * `comctl32.dll`/`comdlg32.dll`, which the plugin loads on first use.
 *
 * The dialog procedure calls the script handlers of the dialog object (`onInit`,
 * `onCommand`, `onNotify`, `onHScroll`, `onVScroll`, `onSize`, `onDrawItem`,
 * `onCtrlColorButton`/`Edit`/`Static`) through the owner given to the constructor, else the
 * dialog object. A modal `open` suspends the calling script until `EndDialog`.
 *
 * Differences from the native plugin: the modeless keyboard hook (`WH_GETMESSAGE` +
 * `IsDialogMessage`) is the host's business (it routes keys of modeless dialogs through
 * `IsDialogMessageW`); the progress dialog runs on the UI thread instead of its own thread;
 * dialogs from resource DLLs (`loadResource`) cannot be loaded, so `open` uses the template.
 */
import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {
  readWideString,
  writeWideString,
  type NativeAddressSpace,
  type NativeCodePointers,
} from '../../platform/native-process.js';
import {
  NcbClassInfo,
  NcbPlugin,
  ncbBool,
  ncbInt,
  ncbReal,
  ncbString,
  ncbUint,
  registerClass,
  unregisterClass,
  type NcbClassDefinition,
  type NcbContext,
  type NcbDisposable,
  type NcbRegistrar,
} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {
  DictionaryBuilder,
  pointer,
  PropAccessor,
  throwFromError,
} from '../../engines/kirikiri/tp-stub/tp-stub.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {
  asInteger,
  asObject,
  bool,
  int,
  integer,
  obj,
  real,
  str,
  VOID,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {COMCTL32, type Comctl32Exports} from '../comctl32/contract.js';
import {
  CC_FULLOPEN,
  CC_PREVENTFULLOPEN,
  CC_RGBINIT,
  COMDLG32,
  type Comdlg32Exports,
} from '../comdlg32/contract.js';
import {BI_BITFIELDS, BI_RGB, GDI32, SRCCOPY, type Gdi32Exports} from '../gdi32/contract.js';
import {FORMAT_MESSAGE_FROM_SYSTEM, KERNEL32, type Kernel32Exports} from '../kernel32/contract.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDPARAM,
  TJS_E_NATIVECLASSCRASH,
  TJS_MEMBERMUSTEXIST,
  TJS_S_OK,
  TVP_PLUGIN,
  type Dispatch,
  type TvpFunctionExporter,
  type TvpPluginExports,
  type Variant,
  type VariantResult,
} from '../tvp-plugin/contract.js';
import {
  DWL_MSGRESULT,
  DWL_USER,
  GWL_EXSTYLE,
  GWL_STYLE,
  IDCANCEL,
  SB_CTL,
  SIF_ALL,
  SIF_PAGE,
  SIF_POS,
  SIF_RANGE,
  SW_SHOW,
  SW_SHOWNA,
  SWP_FRAMECHANGED,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  USER32,
  WM_CLOSE,
  WM_COMMAND,
  WM_CTLCOLORBTN,
  WM_CTLCOLOREDIT,
  WM_CTLCOLORSTATIC,
  WM_DESTROY,
  WM_DRAWITEM,
  WM_HSCROLL,
  WM_INITDIALOG,
  WM_NOTIFY,
  WM_SETICON,
  WM_SIZE,
  WM_VSCROLL,
  type Rect,
  type User32Exports,
  type WindowProcedure,
} from '../user32/contract.js';
import {WIN32DIALOG_CONSTANTS} from './constants.js';

const SHA256 = 'a1da3fd6e3004fa74ad70cf219e5b48d708cbe0e2d5b889618f489f814bf4a49';

/** `MB_OWNER_CENTER`: the plugin's own flag (centre the box on the owner). */
const MB_OWNER_CENTER = 0x40000000;
const ICON_SMALL = 0;
const DS_SETFONT = 0x40;
/** `GetModuleHandle(NULL)`: the executable's image base. */
const EXE_INSTANCE = 0x00400000;
/** `IDI_TVPWIN32` and `IDI_APPLICATION`. */
const IDI_TVPWIN32 = 107;
const IDI_APPLICATION = 32512;

// Tab control messages.
const TCM_DELETEITEM = 0x1308;
const TCM_DELETEALLITEMS = 0x1309;
const TCM_GETCURSEL = 0x130b;
const TCM_SETCURSEL = 0x130c;
const TCM_ADJUSTRECT = 0x1328;
const TCM_INSERTITEMW = 0x133e;
const TCIF_TEXT = 0x0001;
// Progress bar messages.
const PBM_SETPOS = 0x0402;
const PBM_SETRANGE = 0x0401;
const PBM_SETMARQUEE = 0x040a;
const PBS_MARQUEE = 0x08;
const BN_CLICKED = 0;
// Property sheet.
const PSP_DLGINDIRECT = 0x0001;
const PSP_USEHICON = 0x0002;
const PSP_USETITLE = 0x0008;
const PSH_PROPTITLE = 0x0001;
const PSH_USEHICON = 0x0002;
const PROPSHEETPAGE_SIZE = 0x30;
const PROPSHEETHEADER_SIZE = 0x34;

// --- Plugin-side objects -----------------------------------------------------------------------

interface Win32Services {
  readonly ex: TvpFunctionExporter;
  readonly memory: NativeAddressSpace;
  readonly code: NativeCodePointers;
  readonly user32: User32Exports;
  readonly gdi32: Gdi32Exports;
  readonly kernel32: Kernel32Exports;
  readonly comctl32: () => Comctl32Exports;
  readonly comdlg32: () => Comdlg32Exports;
  /** Native "addresses" of plugin objects passed through LPARAMs. */
  readonly objects: Map<number, object>;
  /** Interned copies of script strings and octets (`getStringAddress`). */
  readonly strings: Map<string, number>;
  readonly octets: WeakMap<Uint8Array, number>;
  readonly blocks: [number, number][];
}

function dv(memory: NativeAddressSpace): DataView {
  return new DataView(memory.u8.buffer);
}

/** `RGB()` of a TJS 0xRRGGBB colour. */
function colorRef(rgb: number): number {
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 0xff);
}
function fromColorRef(ref: number): number {
  return ((ref & 0xff) << 16) | (ref & 0xff00) | ((ref >>> 16) & 0xff);
}

/** The `Bitmap` sub class: a layer read into a GDI bitmap on demand. */
class LayerBitmap implements NcbDisposable {
  bitmap = 0;
  icon = 0;
  constructor(
    private readonly s: Win32Services,
    readonly layer: Dispatch,
  ) {
    layer.addRef();
  }
  dispose(): void {
    this.removeBitmap();
    this.layer.release();
  }
  removeBitmap(): void {
    if (this.bitmap) this.s.gdi32.DeleteObject(this.bitmap);
    this.bitmap = 0;
    if (this.icon) this.s.user32.DestroyIcon(this.icon);
    this.icon = 0;
  }
  /** `createBitmap`: a bottom-up DIB with the layer's main image (24-bit, or 32-bit). */
  createBitmap(hwnd: number, withAlpha = false): {bitmap: number; width: number; height: number} {
    this.removeBitmap();
    const p = new PropAccessor(this.s.ex, this.layer);
    const width = p.getInt('imageWidth');
    const height = p.getInt('imageHeight');
    const pitch = p.getInt('mainImageBufferPitch');
    const src = Number(asInteger(p.getValue('mainImageBuffer')));
    const bytes = withAlpha ? 4 : 3;
    const dc = this.s.user32.GetDC(hwnd);
    const dib = this.s.gdi32.CreateDIBSection(dc, {
      width,
      height,
      bitCount: bytes * 8,
      compression: withAlpha ? BI_BITFIELDS : BI_RGB,
      redMask: withAlpha ? 0x00ff0000 : 0,
      greenMask: withAlpha ? 0x0000ff00 : 0,
      blueMask: withAlpha ? 0x000000ff : 0,
      alphaMask: withAlpha ? 0xff000000 : 0,
    });
    if (dib) {
      this.bitmap = dib.bitmap;
      const u8 = this.s.memory.u8;
      const stride = (width * bytes + 3) & ~3;
      for (let y = height - 1; y >= 0; y--) {
        let r = src + y * pitch;
        let w = dib.bits + (height - 1 - y) * stride;
        for (let n = width - 1; n >= 0; n--, r += 4, w += bytes)
          for (let b = 0; b < bytes; b++) u8[w + b] = u8[r + b]!;
      }
    }
    this.s.user32.ReleaseDC(hwnd, dc);
    return {bitmap: this.bitmap, width, height};
  }
  /** `createIcon`. */
  createIcon(hwnd: number): number {
    const {bitmap, width, height} = this.createBitmap(hwnd, true);
    if (bitmap) {
      const mask = this.s.gdi32.CreateBitmap(width, height, 1, 1, 0);
      this.icon = this.s.user32.CreateIconIndirect({
        icon: true,
        xHotspot: 0,
        yHotspot: 0,
        mask,
        color: bitmap,
      });
      this.s.gdi32.DeleteObject(mask);
      this.s.gdi32.DeleteObject(bitmap);
      this.bitmap = 0;
    }
    return this.icon;
  }
}

class SolidBrush implements NcbDisposable {
  brush: number;
  constructor(
    private readonly s: Win32Services,
    rgb: number,
  ) {
    this.brush = s.gdi32.CreateSolidBrush(colorRef(rgb));
  }
  dispose(): void {
    if (this.brush) this.s.gdi32.DeleteObject(this.brush);
    this.brush = 0;
  }
}

/** `DRAWITEMSTRUCT` at an address. */
class DrawItem {
  constructor(
    private readonly s: Win32Services,
    readonly ref: number,
  ) {}
  u32(offset: number): number {
    return this.ref ? dv(this.s.memory).getUint32(this.ref + offset, true) : 0;
  }
  i32(offset: number): number {
    return this.ref ? dv(this.s.memory).getInt32(this.ref + offset, true) : 0;
  }
}

/** `NMHDR` (and the notification structure around it) at an address. */
class NotifyAccessor {
  constructor(
    private readonly s: Win32Services,
    readonly ptr: number,
  ) {}
  byte(ofs: number): number {
    return this.s.memory.u8[this.ptr + ofs]!;
  }
  word(ofs: number): number {
    return this.byte(ofs) | (this.byte(ofs + 1) << 8);
  }
  dword(ofs: number): number {
    return (this.word(ofs) | (this.word(ofs + 2) << 16)) >>> 0;
  }
}

/** `Blob`: owned bytes (`new Blob(size)`) or a view of an address (`ReferPointer`). */
class Blob implements NcbDisposable {
  constructor(
    private readonly s: Win32Services,
    public ptr: number,
    public size: number,
  ) {}
  static allocate(s: Win32Services, size: number): Blob {
    return new Blob(s, size ? s.memory.allocate(size, 'Blob') : 0, size);
  }
  dispose(): void {
    if (this.size) this.s.memory.free(this.ptr, this.size);
    this.size = 0;
    this.ptr = 0;
  }
  byte(ofs: number): number {
    return this.s.memory.u8[this.ptr + ofs]!;
  }
  word(ofs: number): number {
    return this.byte(ofs) | (this.byte(ofs + 1) << 8);
  }
  dword(ofs: number): number {
    return (this.word(ofs) | (this.word(ofs + 2) << 16)) >>> 0;
  }
  setByte(ofs: number, v: number): void {
    this.s.memory.u8[this.ptr + ofs] = v & 0xff;
  }
  setWord(ofs: number, v: number): void {
    this.setByte(ofs, v);
    this.setByte(ofs + 1, v >>> 8);
  }
  setDWord(ofs: number, v: number): void {
    this.setWord(ofs, v & 0xffff);
    this.setWord(ofs + 2, (v >>> 16) & 0xffff);
  }
}

// --- Templates (dialog.hpp) ----------------------------------------------------------------

type SzOrOrd = {kind: 'none'} | {kind: 'id'; id: number} | {kind: 'str'; str: string};

class TemplateWriter {
  constructor(
    readonly u8: Uint8Array | null,
    public p: number,
    public c = 0,
  ) {}
  byte(v: number): void {
    this.c++;
    if (this.u8) this.u8[this.p++] = v & 0xff;
  }
  word(v: number): void {
    this.byte(v);
    this.byte(v >>> 8);
  }
  dword(v: number): void {
    this.word(v & 0xffff);
    this.word((v >>> 16) & 0xffff);
  }
  string(s: string): void {
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
    this.word(0);
  }
  /** `Alignment`: the size counts the full alignment, the pointer is aligned. */
  align(al: number): void {
    this.c += al;
    if (this.u8) this.p = (this.p + al - 1) & ~(al - 1);
  }
  szOrOrd(v: SzOrOrd): void {
    if (v.kind === 'id') {
      this.word(0xffff);
      this.word(v.id);
    } else if (v.kind === 'str') this.string(v.str);
    else this.word(0);
  }
}

/** `DialogHeader` (`DLGTEMPLATEEX`). */
class Header {
  helpID = 0;
  exStyle = 0;
  style = 0;
  dlgItems = 0;
  x = 0;
  y = 0;
  cx = 0;
  cy = 0;
  menu: SzOrOrd = {kind: 'none'};
  windowClass: SzOrOrd = {kind: 'none'};
  title = '';
  pointSize = 0;
  weight = 0;
  italic = 0;
  charset = 0;
  typeFace = '';
  write(w: TemplateWriter): void {
    w.align(4);
    w.word(1);
    w.word(0xffff);
    w.dword(this.helpID);
    w.dword(this.exStyle);
    w.dword(this.style);
    w.word(this.dlgItems);
    w.word(this.x);
    w.word(this.y);
    w.word(this.cx);
    w.word(this.cy);
    w.szOrOrd(this.menu);
    w.szOrOrd(this.windowClass);
    w.string(this.title);
    if (this.style & DS_SETFONT) {
      w.word(this.pointSize);
      w.word(this.weight);
      w.byte(this.italic);
      w.byte(this.charset);
      w.string(this.typeFace);
    }
  }
}

/** `DialogItems` (`DLGITEMTEMPLATEEX`). */
class Items {
  helpID = 0;
  exStyle = 0;
  style = 0;
  x = 0;
  y = 0;
  cx = 0;
  cy = 0;
  id = 0;
  windowClass: SzOrOrd = {kind: 'none'};
  title: SzOrOrd = {kind: 'none'};
  write(w: TemplateWriter): void {
    w.align(4);
    w.dword(this.helpID);
    w.dword(this.exStyle);
    w.dword(this.style);
    w.word(this.x);
    w.word(this.y);
    w.word(this.cx);
    w.word(this.cy);
    w.dword(this.id);
    w.szOrOrd(this.windowClass);
    w.szOrOrd(this.title);
    w.word(0);
  }
}

/** `SetValue`: an integer member when present. */
function setValue(p: PropAccessor, name: string, set: (v: number) => void): void {
  if (p.hasValue(name)) set(p.getInt(name));
}
/** `SetSzOrd`: a string or an id when present. */
function setSzOrd(p: PropAccessor, name: string, set: (v: SzOrOrd) => void): void {
  const type = {value: 0};
  if (!p.hasValue(name, type)) return;
  if (type.value === 2) set({kind: 'str', str: ncbString(p.getValue(name))});
  else set({kind: 'id', id: p.getInt(name) & 0xffff});
}
function setString(p: PropAccessor, name: string, set: (v: string) => void): void {
  if (p.hasValue(name)) set(ncbString(p.getValue(name)));
}

// --- WIN32Dialog -------------------------------------------------------------------------------

class Progress {
  setmax = false;
  cancel = false;
  progress = 0;
  target = 0;
  constructor(
    private readonly s: Win32Services,
    readonly prgid: number,
    readonly dsapp: boolean,
  ) {}
  item(id: number): number {
    return this.target ? this.s.user32.GetDlgItem(this.target, id) : 0;
  }
  setProgress(value: number): void {
    const u = this.s.user32;
    const item = this.item(this.prgid);
    if (!item) return;
    if (!this.setmax || (value < 0 && this.progress >= 0) || (value >= 0 && this.progress < 0)) {
      if (!this.setmax) {
        this.setmax = true;
        u.SendMessageW(item, PBM_SETRANGE, 0, 10000 << 16);
      }
      const style = u.GetWindowLongW(item, GWL_STYLE);
      u.SetWindowLongW(item, GWL_STYLE, value < 0 ? style | PBS_MARQUEE : style & ~PBS_MARQUEE);
    }
    this.progress = value;
    if (value < 0) {
      const marquee = Math.trunc(-value);
      u.SendMessageW(item, PBM_SETMARQUEE, marquee ? 1 : 0, marquee);
    } else {
      const v = Math.min(value / 100, 1);
      u.SendMessageW(item, PBM_SETPOS, Math.trunc(v * 10000), 0);
    }
  }
  setCancelState(c: boolean): void {
    this.cancel = c;
    const cancel = this.item(IDCANCEL);
    if (cancel) this.s.user32.EnableWindow(cancel, !c);
  }
  /** `ProgressProc`. */
  readonly proc: WindowProcedure = (hwnd, msg, wParam) => {
    const u = this.s.user32;
    switch (msg) {
      case WM_INITDIALOG:
        this.target = hwnd;
        return 1;
      case WM_COMMAND:
        if ((wParam & 0xffff) === IDCANCEL && wParam >>> 16 === BN_CLICKED) {
          this.setCancelState(true);
          return 1;
        }
        return 0;
      case WM_CLOSE:
        this.setCancelState(true);
        u.DestroyWindow(hwnd);
        return 1;
    }
    return 0;
  };
  close(): void {
    if (this.dsapp) this.s.user32.EnableWindow(this.s.ex.TVPGetApplicationWindowHandle(), true);
    if (this.target && this.s.user32.IsWindow(this.target))
      this.s.user32.DestroyWindow(this.target);
    this.target = 0;
  }
}

class Win32Dialog implements NcbDisposable {
  dialogHWnd = 0;
  icon = 0;
  propsheet = 0;
  progress: Progress | null = null;
  objthis: Dispatch | null = null;
  modeless = false;
  buf = 0;
  bufSize = 0;
  ref = 0;
  resid: Variant = VOID;
  readonly iconBitmap = new VariantSlot();
  /** The plugin object's address, passed as the dialog's init parameter. */
  readonly address: number;

  constructor(
    readonly s: Win32Services,
    readonly owner: Dispatch | null,
  ) {
    this.address = s.memory.allocate(0x48, 'WIN32Dialog');
    s.objects.set(this.address, this);
  }

  dispose(): void {
    if (this.progress) this.closeProgress();
    if (this.propsheet) this.s.comctl32().DestroyPropertySheetPage(this.propsheet);
    this.propsheet = 0;
    if (this.modeless) this.close(IDCANCEL);
    if (this.buf) this.s.memory.free(this.buf, this.bufSize);
    this.buf = 0;
    this.iconBitmap.clear();
    this.s.objects.delete(this.address);
    this.s.memory.free(this.address, 0x48);
  }

  // Errors.
  throwLastError(): never {
    const k = this.s.kernel32;
    const text = k.FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM, k.GetLastError(), 0x400) ?? '';
    return this.s.ex.TVPThrowExceptionMessage(text);
  }

  isValid(): boolean {
    return this.dialogHWnd !== 0 && this.s.user32.IsWindow(this.dialogHWnd);
  }
  checkDialogValid(): void {
    if (!this.isValid()) this.s.ex.TVPThrowExceptionMessage('Dialog not opened.');
  }

  // Items.
  itemHWND(id: number): number {
    this.checkDialogValid();
    if (!id) return this.dialogHWnd;
    const r = this.s.user32.GetDlgItem(this.dialogHWnd, id);
    if (!r) this.throwLastError();
    return r;
  }

  // Callbacks.
  #hasCallback(event: string): Dispatch | null {
    const target = this.owner ?? this.objthis;
    if (!target) return null;
    const slot = new VariantSlot();
    const hr = target.propGet(TJS_MEMBERMUSTEXIST, event, slot, target);
    slot.clear();
    return hr < 0 ? null : target;
  }
  callback(event: string, args: readonly Variant[]): number {
    const target = this.#hasCallback(event);
    if (!target) return 0;
    const rslt = new VariantSlot();
    try {
      throwFromError(this.s.ex, target.funcCall(0, event, rslt, args, target), event);
      return asInteger(rslt.value) !== 0n ? 1 : 0;
    } finally {
      rslt.clear();
    }
  }
  normal(event: string, msg: number, wParam: number, lParam: number): number {
    return this.callback(event, [int(msg | 0), int(wParam | 0), integer(BigInt(lParam | 0))]);
  }
  /** A callback with a boxed `DrawItem`/`Notify` argument. */
  boxed<T extends object>(event: string, info: NcbClassInfo<T>, wParam: number, inst: T): number {
    if (!this.#hasCallback(event)) return 0;
    const o = info.createObject(this.s.ex, inst);
    try {
      return this.callback(event, [int(wParam | 0), obj(o, o)]);
    } finally {
      o.release();
    }
  }
  /** `WM_CTLCOLOR*`. */
  ctlColor(event: string, id: number, hdc: number): number {
    const target = this.#hasCallback(event);
    if (!target) return 0;
    const rslt = new VariantSlot();
    try {
      throwFromError(this.s.ex, target.funcCall(0, event, rslt, [int(id)], target), event);
      const elm = rslt.value.type === 1 ? asObject(rslt.value) : null;
      if (rslt.value.type !== 1) return 0;
      if (!elm) return 0;
      const g = this.s.gdi32;
      const p = new PropAccessor(this.s.ex, elm);
      const type = {value: 0};
      if (p.hasValue('fgcolor', type) && type.value === 4)
        g.SetTextColor(hdc, colorRef(p.getInt('fgcolor')));
      if (p.hasValue('bgcolor', type)) {
        if (type.value === 4) {
          g.SetBkMode(hdc, 2);
          g.SetBkColor(hdc, colorRef(p.getInt('bgcolor')));
        } else if (type.value === 1) g.SetBkMode(hdc, 1);
      }
      let r = 0;
      const brush = new VariantSlot();
      if (elm.propGet(TJS_MEMBERMUSTEXIST, 'bgbrush', brush, elm) >= 0) {
        const v = brush.value;
        if (v.type === 1) {
          const o = asObject(v);
          if (o) {
            const adp = SOLID_BRUSH.adaptor(o);
            if (!adp && SOLID_BRUSH.id >= 0)
              this.s.ex.TVPThrowExceptionMessage('Invalid instance type.');
            r = adp?.instance?.brush ?? 0;
          }
        } else if (v.type === 4) r = g.GetStockObject(Number(BigInt.asIntN(32, asInteger(v))));
      }
      brush.clear();
      return r || g.GetStockObject(5);
    } finally {
      rslt.clear();
    }
  }

  // Dialog procedure (`DlgProc`).
  static readonly dlgProc =
    (s: Win32Services): WindowProcedure =>
    (hwnd, msg, wParam, lParam) => {
      const u = s.user32;
      const inst = (h: number) =>
        s.objects.get(u.GetWindowLongW(h, DWL_USER) >>> 0) as Win32Dialog | undefined;
      switch (msg) {
        case WM_INITDIALOG: {
          u.SetWindowLongW(hwnd, DWL_USER, lParam);
          const self = s.objects.get(lParam >>> 0) as Win32Dialog | undefined;
          if (self) {
            self.dialogHWnd = hwnd;
            if (self.icon && !self.propsheet)
              u.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, self.icon);
            return self.normal('onInit', msg, wParam, lParam);
          }
          return 0;
        }
        case WM_SIZE:
          return inst(hwnd)?.normal('onSize', msg, wParam, lParam) ?? 0;
        case WM_HSCROLL:
          return inst(hwnd)?.normal('onHScroll', msg, wParam, lParam) ?? 0;
        case WM_VSCROLL:
          return inst(hwnd)?.normal('onVScroll', msg, wParam, lParam) ?? 0;
        case WM_COMMAND:
          return inst(hwnd)?.normal('onCommand', msg, wParam, lParam) ?? 0;
        case WM_DRAWITEM: {
          const self = inst(hwnd);
          return self ? self.boxed('onDrawItem', DRAW_ITEM, wParam, new DrawItem(s, lParam)) : 0;
        }
        case WM_NOTIFY: {
          const self = inst(hwnd);
          return self ? self.boxed('onNotify', NOTIFY, wParam, new NotifyAccessor(s, lParam)) : 0;
        }
        case WM_DESTROY:
          return 0;
        case WM_CTLCOLORBTN:
        case WM_CTLCOLOREDIT:
        case WM_CTLCOLORSTATIC: {
          const self = inst(hwnd);
          if (!self) return 0;
          const id = u.GetDlgCtrlID(lParam);
          const event =
            msg === WM_CTLCOLORBTN
              ? 'onCtrlColorButton'
              : msg === WM_CTLCOLOREDIT
                ? 'onCtrlColorEdit'
                : 'onCtrlColorStatic';
          return self.ctlColor(event, id, wParam);
        }
      }
      return 0;
    };

  /** `_getOpenParent`: an object's `HWND`, the application window for null, else 0. */
  static openParent(s: Win32Services, win: Variant): number {
    if (win.type !== 1) return 0;
    const o = asObject(win);
    if (!o) return s.ex.TVPGetApplicationWindowHandle();
    const slot = new VariantSlot();
    o.propGet(0, 'HWND', slot, o);
    const h = slot.value.type === 0 ? 0 : Number(BigInt.asUintN(32, asInteger(slot.value)));
    slot.clear();
    return h;
  }

  /** `_open`: modal dialogs suspend until `EndDialog`. */
  open(win: Variant, result: VariantResult | null): number {
    const s = this.s;
    if (this.propsheet)
      s.ex.TVPThrowExceptionMessage('Dialog is already opened by property sheet.');
    const hwnd = Win32Dialog.openParent(s, win);
    const proc = Win32Dialog.dlgProc(s);
    if (!this.modeless) {
      return s.ex.suspend(
        s.user32.DialogBoxIndirectParamW(EXE_INSTANCE, this.ref, hwnd, proc, this.address),
        (ret) => {
          if (ret === -1) this.throwLastError();
          result?.set(int(ret));
          return TJS_S_OK;
        },
      );
    }
    this.dialogHWnd = s.user32.CreateDialogIndirectParamW(
      EXE_INSTANCE,
      this.ref,
      hwnd,
      proc,
      this.address,
    );
    if (!this.dialogHWnd) this.throwLastError();
    result?.set(int(0));
    return TJS_S_OK;
  }

  close(id: number): void {
    if (this.propsheet || this.progress) return;
    if (this.dialogHWnd) {
      if (!this.modeless) this.s.user32.EndDialog(this.dialogHWnd, id);
      else this.s.user32.DestroyWindow(this.dialogHWnd);
    }
    this.dialogHWnd = 0;
  }

  /** `getIconHandle`. */
  static iconHandle(s: Win32Services, hwnd: number, bmp: Variant): number {
    if (bmp.type === 1) {
      const o = asObject(bmp);
      if (!o) {
        return (
          s.user32.LoadIconW(EXE_INSTANCE, 'MAINICON') ||
          s.user32.LoadIconW(EXE_INSTANCE, IDI_TVPWIN32) ||
          s.user32.LoadIconW(EXE_INSTANCE, IDI_APPLICATION)
        );
      }
      const b = BITMAP.adaptor(o);
      if (!b) s.ex.TVPThrowExceptionMessage('Invalid instance type.');
      return b.instance ? b.instance.createIcon(hwnd) : 0;
    }
    // Icon files and resources of other modules (`file.ico`, `module.dll|name`) are not
    // available: LoadImage fails.
    return 0;
  }

  setDialogIcon(bmp: Variant): void {
    const s = this.s;
    this.icon = Win32Dialog.iconHandle(
      s,
      this.dialogHWnd || s.ex.TVPGetApplicationWindowHandle(),
      bmp,
    );
    this.iconBitmap.clear();
    if (this.icon) this.iconBitmap.set(bmp);
    if (this.dialogHWnd) s.user32.SendMessageW(this.dialogHWnd, WM_SETICON, ICON_SMALL, this.icon);
  }

  /** `CreateBuffer`: the template buffer, DWORD-aligned. */
  createBuffer(size: number): number {
    if (this.buf) this.s.memory.free(this.buf, this.bufSize);
    this.bufSize = size + 4;
    this.buf = this.s.memory.allocate(this.bufSize, 'TVP_malloc');
    this.ref = (this.buf + 3) & ~3;
    return this.ref;
  }

  // Property sheets.
  setupPropSheet(objthis: Dispatch, titleOverride: string | null = null): number {
    const s = this.s;
    this.objthis = objthis;
    if (!this.propsheet) {
      const page = s.memory.allocate(
        PROPSHEETPAGE_SIZE + (titleOverride ? (titleOverride.length + 1) * 2 : 0),
        'PROPSHEETPAGE',
      );
      const d = dv(s.memory);
      let flags = PSP_DLGINDIRECT;
      d.setUint32(page, PROPSHEETPAGE_SIZE, true);
      d.setUint32(page + 8, EXE_INSTANCE, true);
      d.setUint32(page + 12, this.ref, true);
      if (titleOverride) {
        flags |= PSP_USETITLE;
        writeWideString(s.memory, page + PROPSHEETPAGE_SIZE, titleOverride);
        d.setUint32(page + 20, page + PROPSHEETPAGE_SIZE, true);
      }
      if (this.icon) {
        flags |= PSP_USEHICON;
        d.setUint32(page + 16, this.icon, true);
      }
      d.setUint32(page + 4, flags, true);
      const proc: WindowProcedure = (hwnd, msg, wParam, lParam) =>
        Win32Dialog.dlgProc(s)(
          hwnd,
          msg,
          wParam,
          msg === WM_INITDIALOG ? dv(s.memory).getUint32(lParam + 28, true) : lParam,
        );
      d.setUint32(page + 24, codePointer(s, proc), true);
      d.setUint32(page + 28, this.address, true);
      this.propsheet = s.comctl32().CreatePropertySheetPageW(page);
      s.memory.free(
        page,
        PROPSHEETPAGE_SIZE + (titleOverride ? (titleOverride.length + 1) * 2 : 0),
      );
      if (!this.propsheet) this.throwLastError();
    }
    return this.propsheet;
  }

  propSheetMessage(msg: number, wp: Variant, lp: Variant): number {
    const u = this.s.user32;
    if (!this.isValid() || !this.propsheet) return -1;
    const owner = u.GetParent(this.dialogHWnd);
    const PSM_CHANGED = 0x0468;
    const PSM_UNCHANGED = 0x046d;
    const PSM_HWNDTOINDEX = 0x0481;
    const stringMessages = [0x046f, 0x0479, 0x047d, 0x047e, 0x0473, 0x0480];
    if (stringMessages.includes(msg)) {
      const text = ncbString(lp);
      const size = (text.length + 1) * 2;
      const a = this.s.memory.allocate(size, 'PSM');
      writeWideString(this.s.memory, a, text);
      try {
        return u.SendMessageW(owner, msg, ncbInt(wp), a);
      } finally {
        this.s.memory.free(a, size);
      }
    }
    if (msg === PSM_CHANGED || msg === PSM_UNCHANGED || msg === PSM_HWNDTOINDEX) {
      const hwnd = ncbUint(wp) || this.dialogHWnd;
      return u.SendMessageW(owner, msg, hwnd, ncbInt(lp));
    }
    return u.SendMessageW(owner, msg, ncbInt(wp), ncbInt(lp));
  }

  // Progress.
  checkProgress(): void {
    if (!this.progress) this.s.ex.TVPThrowExceptionMessage('dialog is not progress mode.');
  }
  openProgress(
    objthis: Dispatch,
    win: Variant,
    prgid: number,
    appDisable: boolean,
    activate: boolean,
  ): boolean {
    const s = this.s;
    if (this.isValid() || this.propsheet || this.progress)
      s.ex.TVPThrowExceptionMessage('dialog already used.');
    const progress = new Progress(s, prgid, appDisable);
    this.progress = progress;
    const parent = Win32Dialog.openParent(s, win);
    const hwnd = s.user32.CreateDialogIndirectParamW(
      EXE_INSTANCE,
      this.ref,
      parent,
      progress.proc,
      0,
    );
    progress.target = hwnd;
    if (hwnd) {
      if (this.icon) s.user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, this.icon);
      if (appDisable) s.user32.EnableWindow(s.ex.TVPGetApplicationWindowHandle(), false);
      this.dialogHWnd = hwnd;
      this.objthis = objthis;
      this.normal('onInit', WM_INITDIALOG, 0, 0);
      s.user32.ShowWindow(hwnd, activate ? SW_SHOW : SW_SHOWNA);
      return true;
    }
    this.progress = null;
    return false;
  }
  closeProgress(): void {
    if (this.progress) {
      this.progress.close();
      this.progress = null;
      this.dialogHWnd = 0;
    }
  }
}

/** A function's address in the process (`(DLGPROC)fn`). */
function codePointer(s: Win32Services, fn: WindowProcedure): number {
  return s.code.pointerOf(fn);
}

// --- Registration ------------------------------------------------------------------------------

const W32 = new NcbClassInfo<Win32Dialog>('WIN32Dialog');
const HEADER = new NcbClassInfo<Header>('Header');
const ITEMS = new NcbClassInfo<Items>('Items');
const BITMAP = new NcbClassInfo<LayerBitmap>('Bitmap');
const SOLID_BRUSH = new NcbClassInfo<SolidBrush>('SolidBrush');
const DRAW_ITEM = new NcbClassInfo<DrawItem>('DrawItem');
const NOTIFY = new NcbClassInfo<NotifyAccessor>('Notify');
const BLOB = new NcbClassInfo<Blob>('Blob');

/** `GetNativeInstance(obj, true)` of a sub class argument. */
function instanceArg<T extends object>(
  ex: TvpFunctionExporter,
  info: NcbClassInfo<T>,
  v: Variant,
): T | null {
  const o = v.type === 1 ? asObject(v) : null;
  if (!o) ex.TVPThrowExceptionMessage('No instance.');
  const adp = info.adaptor(o);
  if (!adp) ex.TVPThrowExceptionMessage('Invalid instance type.');
  return adp.instance;
}

function rectFrom(p: PropAccessor): Rect {
  return {
    left: p.getInt('left'),
    top: p.getInt('top'),
    right: p.getInt('right'),
    bottom: p.getInt('bottom'),
  };
}

function rectResult(ex: TvpFunctionExporter, r: Rect, result: VariantResult | null): void {
  new DictionaryBuilder(ex)
    .set('left', r.left)
    .set('top', r.top)
    .set('right', r.right)
    .set('bottom', r.bottom)
    .toResult(result);
}

function defineClasses(s: Win32Services): NcbClassDefinition<Win32Dialog> {
  const ex = s.ex;
  const u = s.user32;
  const header: NcbClassDefinition<Header> = {
    info: HEADER,
    define: (r) =>
      r
        .constructor_(0, () => new Header())
        .method('store', 1, (h, args) => {
          const o = asObject(args[0]!);
          if (!o) return;
          const p = new PropAccessor(ex, o);
          setValue(p, 'helpID', (v) => (h.helpID = v >>> 0));
          setValue(p, 'exStyle', (v) => (h.exStyle = v >>> 0));
          setValue(p, 'style', (v) => (h.style = v >>> 0));
          setValue(p, 'x', (v) => (h.x = v & 0xffff));
          setValue(p, 'y', (v) => (h.y = v & 0xffff));
          setValue(p, 'cx', (v) => (h.cx = v & 0xffff));
          setValue(p, 'cy', (v) => (h.cy = v & 0xffff));
          setSzOrd(p, 'menu', (v) => (h.menu = v));
          setSzOrd(p, 'windowClass', (v) => (h.windowClass = v));
          setString(p, 'title', (v) => (h.title = v));
          setValue(p, 'pointSize', (v) => (h.pointSize = v & 0xffff));
          setValue(p, 'weight', (v) => (h.weight = v & 0xffff));
          setValue(p, 'italic', (v) => (h.italic = v & 0xff));
          setValue(p, 'charset', (v) => (h.charset = v & 0xff));
          setString(p, 'typeFace', (v) => (h.typeFace = v));
        })
        .property(
          'dlgItems',
          (h) => int(h.dlgItems),
          (h, v) => {
            h.dlgItems = ncbInt(v) & 0xffff;
          },
        ),
  };
  const items: NcbClassDefinition<Items> = {
    info: ITEMS,
    define: (r) =>
      r
        .constructor_(0, () => new Items())
        .method('store', 1, (it, args) => {
          const o = asObject(args[0]!);
          if (!o) return;
          const p = new PropAccessor(ex, o);
          setValue(p, 'helpID', (v) => (it.helpID = v >>> 0));
          setValue(p, 'exStyle', (v) => (it.exStyle = v >>> 0));
          setValue(p, 'style', (v) => (it.style = v >>> 0));
          setValue(p, 'x', (v) => (it.x = v & 0xffff));
          setValue(p, 'y', (v) => (it.y = v & 0xffff));
          setValue(p, 'cx', (v) => (it.cx = v & 0xffff));
          setValue(p, 'cy', (v) => (it.cy = v & 0xffff));
          setValue(p, 'id', (v) => (it.id = v >>> 0));
          setSzOrd(p, 'windowClass', (v) => (it.windowClass = v));
          setSzOrd(p, 'title', (v) => (it.title = v));
        }),
  };
  const bitmap: NcbClassDefinition<LayerBitmap> = {
    info: BITMAP,
    define: (r) =>
      r.constructor_(1, (args) => {
        const layer = asObject(args[0]!);
        if (!layer) return ex.TVPThrowExceptionMessage('No instance.');
        return new LayerBitmap(s, layer);
      }),
  };
  const solidBrush: NcbClassDefinition<SolidBrush> = {
    info: SOLID_BRUSH,
    define: (r) => r.constructor_(1, (args) => new SolidBrush(s, ncbUint(args[0]!))),
  };
  const drawItem: NcbClassDefinition<DrawItem> = {
    info: DRAW_ITEM,
    define: (r) =>
      r
        .constructor_(0, () => new DrawItem(s, 0))
        .property('ctrlType', (d) => int(d.u32(0)), null)
        .property('ctrlID', (d) => int(d.u32(4)), null)
        .property('itemID', (d) => int(d.u32(8)), null)
        .property('itemAction', (d) => int(d.u32(12)), null)
        .property('itemState', (d) => int(d.u32(16)), null)
        .property('itemData', (d) => int(d.u32(44)), null)
        .rawProperty(
          'itemRect',
          (result, objthis) => {
            const d = DRAW_ITEM.instance(objthis);
            if (!d) return TJS_E_NATIVECLASSCRASH;
            const l = d.i32(28);
            const t = d.i32(32);
            new DictionaryBuilder(ex)
              .set('x', l)
              .set('y', t)
              .set('w', d.i32(36) - l)
              .set('h', d.i32(40) - t)
              .toResult(result);
            return TJS_S_OK;
          },
          null,
        )
        .property('hwndItem', (d) => pointer(d.u32(20)), null)
        .method('draw', 3, (d, args) => {
          const bmp = instanceArg(ex, BITMAP, args[0]!);
          if (!bmp) return;
          const hwndItem = d.u32(20);
          const hdc = d.u32(24);
          const {bitmap: b, width, height} = bmp.createBitmap(hwndItem);
          if (b) {
            const bmpdc = s.gdi32.CreateCompatibleDC(hdc);
            if (bmpdc) {
              s.gdi32.SelectObject(bmpdc, b);
              s.gdi32.BitBlt(
                hdc,
                ncbInt(args[1]!),
                ncbInt(args[2]!),
                width,
                height,
                bmpdc,
                0,
                0,
                SRCCOPY,
              );
              s.gdi32.DeleteDC(bmpdc);
            }
          }
        }),
  };
  const notify: NcbClassDefinition<NotifyAccessor> = {
    info: NOTIFY,
    define: (r) =>
      r
        .constructor_(0, () => new NotifyAccessor(s, 0))
        .property('hwndFrom', (n) => pointer(n.dword(0)), null)
        .property('idFrom', (n) => int(n.dword(4)), null)
        .property('code', (n) => int(n.dword(8)), null)
        .method('getByte', 1, (n, args) => int(n.byte(ncbInt(args[0]!))))
        .method('getWord', 1, (n, args) => int(n.word(ncbInt(args[0]!))))
        .method('getDWord', 1, (n, args) => int(n.dword(ncbInt(args[0]!)))),
  };
  const blob: NcbClassDefinition<Blob> = {
    info: BLOB,
    define: (r) =>
      r
        .constructor_(1, (args) => Blob.allocate(s, ncbUint(args[0]!)))
        .property('pointer', (b) => pointer(b.ptr), null)
        .method('getByte', 1, (b, args) => int(b.byte(ncbInt(args[0]!))))
        .method('getWord', 1, (b, args) => int(b.word(ncbInt(args[0]!))))
        .method('getDWord', 1, (b, args) => int(b.dword(ncbInt(args[0]!))))
        .method('getText', 1, (b, args) => str(readWideString(s.memory, b.dword(ncbInt(args[0]!)))))
        .method('setByte', 2, (b, args) => b.setByte(ncbInt(args[0]!), ncbInt(args[1]!)))
        .method('setWord', 2, (b, args) => b.setWord(ncbInt(args[0]!), ncbInt(args[1]!)))
        .method('setDWord', 2, (b, args) => b.setDWord(ncbInt(args[0]!), ncbUint(args[1]!)))
        .method('setText', 2, (b, args) =>
          b.setDWord(ncbInt(args[0]!), stringAddress(s, ncbString(args[1]!))),
        )
        .staticMethod('ReferPointer', 1, (args, _objthis, result) => {
          const o = BLOB.createObject(ex, new Blob(s, ncbUint(args[0]!), 0));
          result?.set(obj(o, o));
          o.release();
        }),
  };

  return {
    info: W32,
    define: (r: NcbRegistrar<Win32Dialog>) => {
      r.subClass('Header', header)
        .subClass('Items', items)
        .subClass('Bitmap', bitmap)
        .subClass('SolidBrush', solidBrush)
        .subClass('DrawItem', drawItem)
        .subClass('Notify', notify)
        .subClass('Blob', blob)
        .constructor_(0, (args) => new Win32Dialog(s, args.length ? asObject(args[0]!) : null))
        .rawInstanceCallback('loadResource', (_result, args, d) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          // A resource DLL cannot be mapped: LoadLibrary fails.
          if (args[0]!.type === 2) {
            s.kernel32.SetLastError(126);
            d.throwLastError();
          }
          d.resid = args.length >= 2 ? args[1]! : VOID;
          return TJS_S_OK;
        })
        .rawInstanceCallback('makeTemplate', (_result, args, d) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          const head = instanceArg(ex, HEADER, args[0]!)!;
          const list: Items[] = [];
          for (let i = 1; i < args.length; i++) list.push(instanceArg(ex, ITEMS, args[i]!)!);
          const measure = new TemplateWriter(null, 0);
          head.write(measure);
          for (const it of list) it.write(measure);
          const p = d.createBuffer(measure.c + 2);
          s.memory.u8.fill(0, p, p + measure.c);
          const w = new TemplateWriter(s.memory.u8, p);
          head.write(w);
          for (const it of list) it.write(w);
          return TJS_S_OK;
        })
        .rawCallback('open', (result, args, objthis) => {
          const d = W32.instance(objthis);
          if (!d) return TJS_E_NATIVECLASSCRASH;
          d.objthis = objthis;
          return d.open(args.length > 0 ? args[0]! : VOID, result);
        })
        .method('close', 1, (d, args) => d.close(ncbUint(args[0]!)))
        .method('getItem', 1, (d, args) => pointer(d.itemHWND(ncbInt(args[0]!))))
        .method('getItemID', 1, (d, args) => {
          d.checkDialogValid();
          const id = u.GetDlgCtrlID(Number(BigInt.asUintN(32, asInteger(args[0]!))));
          if (!id) d.throwLastError();
          return int(id);
        })
        .method('getItemClassName', 1, (d, args) => {
          const hwnd = d.itemHWND(ncbInt(args[0]!));
          if (!hwnd) return VOID;
          const name = u.GetClassNameW(hwnd);
          if (name === null) return d.throwLastError();
          return str(name);
        })
        .method('setItemLong', 3, (d, args) => {
          const id = ncbInt(args[0]!);
          const index = ncbInt(args[1]!);
          const hwnd = d.itemHWND(id);
          const r = u.SetWindowLongW(hwnd, index, ncbInt(args[2]!));
          // `index == GWL_STYLE || GWL_EXSTYLE` is always true natively.
          if (!id && (index === GWL_STYLE || GWL_EXSTYLE))
            u.SetWindowPos(
              hwnd,
              0,
              0,
              0,
              0,
              0,
              SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );
          return int(r);
        })
        .method('getItemLong', 2, (d, args) =>
          int(u.GetWindowLongW(d.itemHWND(ncbInt(args[0]!)), ncbInt(args[1]!))),
        )
        .method('setItemInt', 2, (d, args) => {
          d.checkDialogValid();
          if (!u.SetDlgItemInt(d.dialogHWnd, ncbInt(args[0]!), ncbInt(args[1]!) >>> 0, true))
            d.throwLastError();
        })
        .method('getItemInt', 1, (d, args) => {
          d.checkDialogValid();
          const v = u.GetDlgItemInt(d.dialogHWnd, ncbInt(args[0]!), true);
          if (v === null) return d.throwLastError();
          return int(v);
        })
        .method('setItemText', 2, (d, args) => {
          d.checkDialogValid();
          const id = ncbInt(args[0]!);
          const text = ncbString(args[1]!);
          const ok = id
            ? u.SetDlgItemTextW(d.dialogHWnd, id, text)
            : u.SetWindowTextW(d.dialogHWnd, text);
          if (!ok) d.throwLastError();
        })
        .method('getItemText', 1, (d, args) => {
          d.checkDialogValid();
          const id = ncbInt(args[0]!);
          const hwnd = d.itemHWND(id);
          return str(id ? (u.GetDlgItemTextW(d.dialogHWnd, id) ?? '') : u.GetWindowTextW(hwnd));
        })
        .method('setItemEnabled', 2, (d, args) => {
          u.EnableWindow(d.itemHWND(ncbInt(args[0]!)), ncbBool(args[1]!));
        })
        .method('getItemEnabled', 1, (d, args) =>
          bool(u.IsWindowEnabled(d.itemHWND(ncbInt(args[0]!)))),
        )
        .method('setItemFocus', 1, (d, args) => {
          u.SetFocus(d.itemHWND(ncbInt(args[0]!)));
        })
        .method('getItemLeft', 1, (d, args) => int(itemRect(d, args).left))
        .method('getItemTop', 1, (d, args) => int(itemRect(d, args).top))
        .method('getItemWidth', 1, (d, args) => {
          const r = itemRect(d, args);
          return int(r.right - r.left);
        })
        .method('getItemHeight', 1, (d, args) => {
          const r = itemRect(d, args);
          return int(r.bottom - r.top);
        })
        .method('setItemPos', 3, (d, args) => {
          u.SetWindowPos(
            d.itemHWND(ncbInt(args[0]!)),
            0,
            ncbInt(args[1]!),
            ncbInt(args[2]!),
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER,
          );
        })
        .method('setItemSize', 3, (d, args) => {
          u.SetWindowPos(
            d.itemHWND(ncbInt(args[0]!)),
            0,
            0,
            0,
            ncbInt(args[1]!),
            ncbInt(args[2]!),
            SWP_NOMOVE | SWP_NOZORDER,
          );
        })
        .rawInstanceCallback('setItemBitmap', (result, args, d) => {
          if (args.length < 2) return TJS_E_BADPARAMCOUNT;
          const id = ncbInt(args[0]!);
          const bmp = instanceArg(ex, BITMAP, args[1]!);
          if (bmp) {
            const STM_SETIMAGE = 0x0172;
            const IMAGE_BITMAP = 0;
            const {bitmap: b} = bmp.createBitmap(d.dialogHWnd);
            result?.set(int(sendItemMessage(d, id, STM_SETIMAGE, IMAGE_BITMAP, b)));
          }
          return TJS_S_OK;
        })
        .method('isExistentItem', 1, (d, args) =>
          bool(u.GetDlgItem(d.dialogHWnd, ncbInt(args[0]!)) !== 0),
        )
        .method('lockItemUpdate', 1, (d, args) =>
          bool(u.LockWindowUpdate(d.itemHWND(ncbInt(args[0]!)))),
        )
        .method('unlockItemUpdate', 0, () => bool(u.LockWindowUpdate(0)))
        .rawInstanceCallback('sendItemMessage', (result, args, d) => {
          if (args.length < 2) return TJS_E_BADPARAMCOUNT;
          const id = ncbInt(args[0]!);
          const msg = ncbUint(args[1]!);
          const wp = args.length > 2 ? Number(BigInt.asUintN(32, asInteger(args[2]!))) : 0;
          if (args.length > 3 && args[3]!.type === 2) {
            const text = ncbString(args[3]!);
            const r = sendItemMessage(d, id, msg, wp, stringAddress(s, text));
            result?.set(int(r));
          } else {
            const lp = args.length > 3 ? Number(BigInt.asIntN(32, asInteger(args[3]!))) : 0;
            result?.set(int(sendItemMessage(d, id, msg, wp, lp)));
          }
          return TJS_S_OK;
        })
        .method('getBaseUnits', 0, (_d, _args, _o, result) => {
          const units = u.GetDialogBaseUnits();
          new DictionaryBuilder(ex)
            .set('h', units & 0xffff)
            .set('v', units >>> 16)
            .toResult(result);
        })
        .method('mapRect', 1, (d, args, _o, result) => {
          d.checkDialogValid();
          const o = asObject(args[0]!);
          if (!o) return;
          const r = rectFrom(new PropAccessor(ex, o));
          if (!u.MapDialogRect(d.dialogHWnd, r)) d.throwLastError();
          rectResult(ex, r, result);
        })
        .method('invalidateRect', 2, (d, args) => {
          d.checkDialogValid();
          const o = asObject(args[0]!);
          if (!o) return bool(false);
          return bool(
            u.InvalidateRect(d.dialogHWnd, rectFrom(new PropAccessor(ex, o)), ncbBool(args[1]!)),
          );
        })
        .method('invalidateAll', 1, (d, args) => {
          d.checkDialogValid();
          return bool(u.InvalidateRect(d.dialogHWnd, null, ncbBool(args[0]!)));
        })
        .method('setPos', 2, (d, args) => {
          if (d.dialogHWnd)
            u.SetWindowPos(
              d.dialogHWnd,
              0,
              ncbInt(args[0]!),
              ncbInt(args[1]!),
              0,
              0,
              SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        })
        .method('setSize', 2, (d, args) => {
          if (d.dialogHWnd)
            u.SetWindowPos(
              d.dialogHWnd,
              0,
              0,
              0,
              ncbInt(args[0]!),
              ncbInt(args[1]!),
              SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        })
        .property(
          'left',
          (d) => int(d.dialogHWnd ? (u.GetWindowRect(d.dialogHWnd)?.left ?? 0) : 0),
          null,
        )
        .property(
          'top',
          (d) => int(d.dialogHWnd ? (u.GetWindowRect(d.dialogHWnd)?.top ?? 0) : 0),
          null,
        )
        .property(
          'width',
          (d) => {
            const r = d.dialogHWnd ? u.GetWindowRect(d.dialogHWnd) : null;
            return int(r ? r.right - r.left : 0);
          },
          null,
        )
        .property(
          'height',
          (d) => {
            const r = d.dialogHWnd ? u.GetWindowRect(d.dialogHWnd) : null;
            return int(r ? r.bottom - r.top : 0);
          },
          null,
        )
        // The handlers' defaults return false.
        .method('onInit', 3, () => bool(false))
        .method('onCommand', 3, () => bool(false))
        .method('onNotify', 2, () => bool(false))
        .method('onHScroll', 3, () => bool(false))
        .method('onVScroll', 3, () => bool(false))
        .method('onSize', 3, () => bool(false))
        .method('show', 1, (d, args) => {
          if (!d.isValid()) ex.TVPThrowExceptionMessage('Dialog is not opened.');
          u.ShowWindow(d.dialogHWnd, ncbInt(args[0]!));
        })
        .property(
          'modeless',
          (d) => bool(d.modeless),
          (d, v) => {
            if (d.isValid()) ex.TVPThrowExceptionMessage('Dialog is opened.');
            d.modeless = ncbBool(v);
          },
        )
        .property('HWND', (d) => pointer(d.dialogHWnd), null)
        .property(
          'icon',
          (d) => d.iconBitmap.value,
          (d, v) => d.setDialogIcon(v),
        )
        .property('isValid', (d) => bool(d.isValid()), null);

      for (const [name, value] of WIN32DIALOG_CONSTANTS)
        r.variant(name, typeof value === 'string' ? str(value) : int(value), 0);

      r.rawCallback(
        'messageBox',
        (result, args) => {
          if (args.length < 4) return TJS_E_BADPARAMCOUNT;
          const hwnd = Win32Dialog.openParent(s, args[0]!);
          const type = ncbUint(args[3]!) & ~MB_OWNER_CENTER;
          return ex.suspend(
            u.MessageBoxW(hwnd, ncbString(args[1]!), ncbString(args[2]!), type),
            (r) => {
              result?.set(int(r));
              return TJS_S_OK;
            },
          );
        },
        0x00010000,
      );
      r.staticMethod('initCommonControls', 0, () => {
        s.comctl32().InitCommonControls();
      })
        .staticMethod('initCommonControlsEx', 1, (args) =>
          bool(s.comctl32().InitCommonControlsEx(ncbUint(args[0]!))),
        )
        .staticMethod('getOctetAddress', 1, (args) =>
          pointer(args[0]!.type === 3 ? octetAddress(s, args[0]!.value) : 0),
        )
        .staticMethod('getStringAddress', 1, (args) =>
          pointer(args[0]!.type === 2 ? stringAddress(s, args[0]!.value) : 0),
        )
        .rawCallback('chooseColor', (result, args) => chooseColor(s, result, args), 0x00010000)
        .rawCallback(
          'openPropertySheet',
          (result, args) => openPropertySheet(s, result, args),
          0x00010000,
        )
        .method('propSheetMessage', 3, (d, args) =>
          int(d.propSheetMessage(ncbInt(args[0]!), args[1]!, args[2]!)),
        )
        .method('setMessageResult', 1, (d, args) => {
          if (d.isValid()) u.SetWindowLongW(d.dialogHWnd, DWL_MSGRESULT, ncbInt(args[0]!));
        })
        .property('propsheet', (d) => bool(d.propsheet !== 0), null)
        .method('insertTab', 3, (d, args) => {
          if (args[2]!.type !== 2) return integer(BigInt(TJS_E_INVALIDPARAM));
          const text = ncbString(args[2]!);
          const pos = args[1]!.type === 0 ? 0 : ncbInt(args[1]!);
          const htab = d.itemHWND(ncbInt(args[0]!));
          const size = 0x1c + (text.length + 1) * 2;
          const tc = s.memory.allocate(size, 'TC_ITEM');
          const view = dv(s.memory);
          view.setUint32(tc, TCIF_TEXT, true);
          writeWideString(s.memory, tc + 0x1c, text);
          view.setUint32(tc + 12, tc + 0x1c, true);
          try {
            u.SendMessageW(htab, TCM_INSERTITEMW, pos, tc);
          } finally {
            s.memory.free(tc, size);
          }
          return integer(0n);
        })
        .method('deleteTab', 2, (d, args) => {
          u.SendMessageW(
            d.itemHWND(ncbInt(args[0]!)),
            TCM_DELETEITEM,
            Number(asInteger(args[1]!)),
            0,
          );
          return integer(0n);
        })
        .method('deleteAllTab', 1, (d, args) => {
          u.SendMessageW(d.itemHWND(ncbInt(args[0]!)), TCM_DELETEALLITEMS, 0, 0);
          return integer(0n);
        })
        .method('getCurSel', 1, (d, args) =>
          int(u.SendMessageW(d.itemHWND(ncbInt(args[0]!)), TCM_GETCURSEL, 0, 0)),
        )
        .method('setCurSel', 2, (d, args) => {
          const idx = args[1]!.type === 0 ? 0 : ncbInt(args[1]!);
          return int(u.SendMessageW(d.itemHWND(ncbInt(args[0]!)), TCM_SETCURSEL, idx, 0));
        })
        .method('selectTab', 2, (d, args) => {
          const htab = d.itemHWND(ncbInt(args[0]!));
          const childObj = asObject(args[1]!);
          const child = W32.instance(childObj);
          if (!child) return integer(BigInt(TJS_E_NATIVECLASSCRASH));
          child.checkDialogValid();
          const hchild = child.dialogHWnd;
          if (u.GetParent(hchild) !== d.dialogHWnd) u.SetParent(hchild, d.dialogHWnd);
          const rect = u.GetClientRect(htab)!;
          const r = s.memory.allocate(16, 'RECT');
          const view = dv(s.memory);
          view.setInt32(r, rect.left, true);
          view.setInt32(r + 4, rect.top, true);
          view.setInt32(r + 8, rect.right, true);
          view.setInt32(r + 12, rect.bottom, true);
          u.SendMessageW(htab, TCM_ADJUSTRECT, 0, r);
          const pts = [
            {x: view.getInt32(r, true), y: view.getInt32(r + 4, true)},
            {x: view.getInt32(r + 8, true), y: view.getInt32(r + 12, true)},
          ];
          s.memory.free(r, 16);
          u.MapWindowPoints(htab, d.dialogHWnd, pts);
          u.MoveWindow(
            hchild,
            pts[0]!.x,
            pts[0]!.y,
            pts[1]!.x - pts[0]!.x,
            pts[1]!.y - pts[0]!.y,
            false,
          );
          u.ShowWindow(hchild, SW_SHOW);
          return integer(0n);
        })
        .rawCallback('openProgress', (result, args, objthis) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          const d = W32.instance(objthis);
          if (!d) return TJS_E_NATIVECLASSCRASH;
          const defdsapp = !(args.length >= 2 && args[1]!.type === 1);
          const exists = (n: number) => args.length > n && args[n]!.type !== 0;
          const ok = d.openProgress(
            objthis,
            args.length >= 2 ? args[1]! : VOID,
            ncbInt(args[0]!),
            exists(2) ? ncbBool(args[2]!) : defdsapp,
            exists(4) ? ncbBool(args[4]!) : true,
          );
          result?.set(bool(ok));
          return TJS_S_OK;
        })
        .property('progress', (d) => bool(d.progress !== null), null)
        .property(
          'progressValue',
          (d) => {
            d.checkProgress();
            return real(d.progress?.progress ?? 0);
          },
          (d, v) => {
            d.checkProgress();
            d.progress?.setProgress(Math.fround(ncbReal(v)));
          },
        )
        .property(
          'progressCanceled',
          (d) => {
            d.checkProgress();
            return bool(d.progress?.cancel ?? false);
          },
          (d, v) => {
            d.checkProgress();
            d.progress?.setCancelState(ncbBool(v));
          },
        )
        .method('closeProgress', 0, (d) => d.closeProgress())
        .method('getScrollInfo', 1, (d, args, _o, result) => {
          const hscr = d.itemHWND(ncbInt(args[0]!));
          const si = {mask: SIF_ALL, min: 0, max: 0, page: 0, pos: 0, trackPos: 0};
          u.GetScrollInfo(hscr, SB_CTL, si);
          new DictionaryBuilder(ex)
            .set('pos', si.pos)
            .set('min', si.min)
            .set('max', si.max)
            .set('page', si.page)
            .set('trackpos', si.trackPos)
            .toResult(result);
        })
        .rawCallback('setScrollInfo', (_result, args, objthis) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          const d = W32.instance(objthis);
          if (!d) return TJS_E_NATIVECLASSCRASH;
          const hscr = d.itemHWND(ncbInt(args[0]!));
          const si = {mask: 0, min: 0, max: 0, page: 0, pos: 0, trackPos: 0};
          if (args.length > 1 && args[1]!.type !== 0) {
            si.mask |= SIF_POS;
            si.pos = ncbInt(args[1]!);
          }
          if (args.length > 3 && args[2]!.type !== 0 && args[3]!.type !== 0) {
            si.mask |= SIF_RANGE;
            si.min = ncbInt(args[2]!);
            si.max = ncbInt(args[3]!);
          }
          if (args.length > 4 && args[4]!.type !== 0) {
            si.mask |= SIF_PAGE;
            si.page = ncbUint(args[4]!);
          }
          u.SetScrollInfo(hscr, SB_CTL, si, true);
          return TJS_S_OK;
        })
        .method('bringToFront', 0, (d) => {
          u.SetForegroundWindow(d.dialogHWnd);
        });
    },
  };
}

function itemRect(d: Win32Dialog, args: readonly Variant[]): Rect {
  d.checkDialogValid();
  return (
    d.s.user32.GetWindowRect(d.itemHWND(ncbInt(args[0]!))) ?? {left: 0, top: 0, right: 0, bottom: 0}
  );
}

function sendItemMessage(d: Win32Dialog, id: number, msg: number, wp: number, lp: number): number {
  d.checkDialogValid();
  const u = d.s.user32;
  return id
    ? u.SendDlgItemMessageW(d.dialogHWnd, id, msg, wp, lp)
    : u.SendMessageW(d.dialogHWnd, msg, wp, lp);
}

/** A stable address of a script string's characters (`(const tjs_char*)str`). */
function stringAddress(s: Win32Services, text: string): number {
  let a = s.strings.get(text);
  if (a === undefined) {
    const size = (text.length + 1) * 2;
    a = s.memory.allocate(size, 'tTJSVariantString');
    writeWideString(s.memory, a, text);
    s.strings.set(text, a);
    s.blocks.push([a, size]);
  }
  return a;
}

/** A stable address of an octet's bytes (`tTJSVariantOctet::GetData`). */
function octetAddress(s: Win32Services, bytes: Uint8Array): number {
  let a = s.octets.get(bytes);
  if (a === undefined) {
    a = s.memory.allocate(Math.max(1, bytes.length), 'tTJSVariantOctet');
    s.memory.u8.set(bytes, a);
    s.octets.set(bytes, a);
    s.blocks.push([a, Math.max(1, bytes.length)]);
  }
  return a;
}

function chooseColor(
  s: Win32Services,
  result: VariantResult | null,
  args: readonly Variant[],
): number {
  const custom = new Array<number>(16).fill(0);
  const request = {
    owner: args.length >= 1 ? Win32Dialog.openParent(s, args[0]!) : 0,
    rgbResult: 0,
    customColors: custom,
    flags: 0,
  };
  let palette: PropAccessor | null = null;
  if (args.length >= 2) {
    const o = asObject(args[1]!);
    if (o) {
      const elm = new PropAccessor(s.ex, o);
      if (elm.hasValue('color')) {
        request.rgbResult = colorRef(elm.getInt('color'));
        request.flags |= CC_RGBINIT;
      }
      const t = {value: 0};
      if (elm.hasValue('palette', t) && t.value === 1) {
        const arr = asObject(elm.getValue('palette'));
        if (arr) {
          palette = new PropAccessor(s.ex, arr);
          const len = palette.count();
          for (let i = 0; i < 16 && i < len; i++) custom[i] = colorRef(palette.getInt(i));
        }
      }
      if (elm.getInt('disableCustomColor')) request.flags |= CC_PREVENTFULLOPEN;
      else if (elm.getInt('openCustomColor')) request.flags |= CC_FULLOPEN;
    }
  }
  return s.ex.suspend(s.comdlg32().ChooseColorW(request), (chosen) => {
    if (chosen) result?.set(integer(BigInt(fromColorRef(request.rgbResult))));
    if (palette)
      for (let i = 0; i < 16; i++) palette.setValue(i, integer(BigInt(fromColorRef(custom[i]!))));
    return TJS_S_OK;
  });
}

/** `OpenPropertySheet(win, pages, elm)`: a modal property sheet of the dialogs in `pages`. */
function openPropertySheet(
  s: Win32Services,
  result: VariantResult | null,
  args: readonly Variant[],
): number {
  const ex = s.ex;
  if (args.length < 3) return TJS_E_BADPARAMCOUNT;
  const pagesObj = asObject(args[1]!);
  const pages = pagesObj ? new PropAccessor(ex, pagesObj) : null;
  const pcnt = pages ? pages.count() : 0;
  if (!pages || pcnt <= 0) return ex.TVPThrowExceptionMessage('invalid property sheet pages.');
  const parent = Win32Dialog.openParent(s, args[0]!);
  const sheets: Win32Dialog[] = [];
  const handles: number[] = [];
  for (let i = 0; i < pcnt; i++) {
    const v = pages.getValue(i);
    const o = v.type === 1 ? asObject(v) : null;
    const sheet = o ? W32.instance(o) : null;
    if (sheet && o) {
      sheets.push(sheet);
      handles.push(sheet.setupPropSheet(o));
    }
  }
  let caption = '';
  let flags = 0;
  let startPage = 0;
  let icon = 0;
  const elmObj = asObject(args[2]!);
  if (elmObj) {
    const elm = new PropAccessor(ex, elmObj);
    if (elm.hasValue('caption')) {
      caption = ncbString(elm.getValue('caption'));
      flags |= PSH_PROPTITLE;
    }
    if (elm.hasValue('page')) {
      const page = elm.getInt('page');
      if (page >= 0 && page < handles.length) startPage = page;
    }
    if (elm.hasValue('icon')) {
      icon = Win32Dialog.iconHandle(s, parent, elm.getValue('icon'));
      if (icon) flags |= PSH_USEHICON;
    }
  }
  const size = PROPSHEETHEADER_SIZE + handles.length * 4 + (caption.length + 1) * 2;
  const head = s.memory.allocate(size, 'PROPSHEETHEADER');
  const view = dv(s.memory);
  const phpage = head + PROPSHEETHEADER_SIZE;
  const captionAddress = phpage + handles.length * 4;
  view.setUint32(head, PROPSHEETHEADER_SIZE, true);
  view.setUint32(head + 4, flags, true);
  view.setUint32(head + 8, parent, true);
  view.setUint32(head + 12, EXE_INSTANCE, true);
  view.setUint32(head + 16, icon, true);
  if (flags & PSH_PROPTITLE) {
    writeWideString(s.memory, captionAddress, caption);
    view.setUint32(head + 20, captionAddress, true);
  }
  view.setUint32(head + 24, handles.length, true);
  view.setUint32(head + 28, startPage, true);
  handles.forEach((h, i) => view.setUint32(phpage + 4 * i, h, true));
  view.setUint32(head + 32, phpage, true);
  const finish = () => {
    for (const sheet of sheets) sheet.propsheet = 0;
    s.memory.free(head, size);
  };
  let pending: Promise<number>;
  try {
    pending = s.comctl32().PropertySheetW(head);
  } catch (e) {
    finish();
    throw e;
  }
  return ex.suspend(pending, (ret) => {
    finish();
    result?.set(integer(BigInt(ret)));
    return TJS_S_OK;
  });
}

class Win32DialogPlugin extends NcbPlugin {
  #definition: NcbClassDefinition<Win32Dialog> | null = null;
  #services: Win32Services | null = null;

  constructor(private readonly make: (ex: TvpFunctionExporter) => Win32Services) {
    super();
  }

  protected regist(ctx: NcbContext): void {
    this.#services = this.make(ctx.exporter);
    this.#definition = defineClasses(this.#services);
    registerClass(ctx, this.#definition);
  }

  protected unregist(ctx: NcbContext): void {
    if (this.#definition) unregisterClass(ctx, this.#definition);
    for (const info of [HEADER, ITEMS, BITMAP, SOLID_BRUSH, DRAW_ITEM, NOTIFY, BLOB]) {
      info.classObject = null;
      info.id = -1;
    }
    const s = this.#services;
    if (s) for (const [a, size] of s.blocks.splice(0)) s.memory.free(a, size);
  }
}

export const WIN32DIALOG: NativeLibraryImplementation<TvpPluginExports> = {
  contract: TVP_PLUGIN,
  identities: [{kind: 'image', sha256: SHA256}],
  imports: [
    {contract: KERNEL32, binding: 'static'},
    {contract: USER32, binding: 'static'},
    {contract: GDI32, binding: 'static'},
    {contract: COMCTL32, binding: 'delay'},
    {contract: COMDLG32, binding: 'delay'},
  ],
  link(context) {
    const user32 = context.staticImport(USER32);
    const gdi32 = context.staticImport(GDI32);
    const kernel32 = context.staticImport(KERNEL32);
    const comctl32 = context.delayImport(COMCTL32);
    const comdlg32 = context.delayImport(COMDLG32);
    const process = context.process;
    return {
      exports: new Win32DialogPlugin((ex) => ({
        ex,
        memory: process.memory,
        code: process.code,
        user32,
        gdi32,
        kernel32,
        comctl32,
        comdlg32,
        objects: new Map(),
        strings: new Map(),
        octets: new WeakMap(),
        blocks: [],
      })),
    };
  },
};
