import {defineNativeContract} from '../../platform/native-libraries.js';

/**
 * `user32.dll`: windows, window classes, messages, dialogs and the standard controls, as the
 * libraries of a process call them. Handles (`HWND`, `HMENU`, `HICON`, `HINSTANCE`) are
 * non-zero unsigned 32-bit numbers. `WPARAM`/`LPARAM`/`LRESULT` are numbers; pointers among
 * them are addresses in the process memory (`NativeLinkContext.process`), as natively:
 * `WM_SETTEXT` takes the address of a UTF-16 string, `WM_NOTIFY` the address of an `NMHDR`.
 *
 * Window procedures are functions; `GWL_WNDPROC` values and `CallWindowProcW` take their code
 * addresses (`NativeCodePointers`). A modal loop (`DialogBoxIndirectParamW`, `MessageBoxW`)
 * returns a promise that settles when the loop ends; the caller suspends on it.
 *
 * Failures return 0 (or FALSE) and set the thread's last error (`kernel32.dll`), with the
 * native `ERROR_*` codes.
 */

/** `WNDPROC` / `DLGPROC`. */
export type WindowProcedure = (hwnd: number, msg: number, wParam: number, lParam: number) => number;

/** `RECT`. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `POINT`. */
export interface Point {
  x: number;
  y: number;
}

/** `WNDCLASSEXW` (`cbSize` implied). */
export interface WindowClassEx {
  style: number;
  wndProc: WindowProcedure;
  clsExtra: number;
  wndExtra: number;
  instance: number;
  icon: number;
  cursor: number;
  background: number;
  menuName: string | number | null;
  className: string;
  iconSmall: number;
}

/** `SCROLLINFO`; `mask` selects the members read or written. */
export interface ScrollInfo {
  mask: number;
  min: number;
  max: number;
  page: number;
  pos: number;
  trackPos: number;
}

/** `ICONINFO`. */
export interface IconInfo {
  icon: boolean;
  xHotspot: number;
  yHotspot: number;
  mask: number;
  color: number;
}

/** `MSG`. */
export interface Message {
  hwnd: number;
  message: number;
  wParam: number;
  lParam: number;
  time: number;
  pt: Point;
}

// --- Constants -----------------------------------------------------------------------------

// Window messages.
export const WM_NULL = 0x0000;
export const WM_CREATE = 0x0001;
export const WM_DESTROY = 0x0002;
export const WM_MOVE = 0x0003;
export const WM_SIZE = 0x0005;
export const WM_ACTIVATE = 0x0006;
export const WM_SETFOCUS = 0x0007;
export const WM_KILLFOCUS = 0x0008;
export const WM_ENABLE = 0x000a;
export const WM_SETREDRAW = 0x000b;
export const WM_SETTEXT = 0x000c;
export const WM_GETTEXT = 0x000d;
export const WM_GETTEXTLENGTH = 0x000e;
export const WM_PAINT = 0x000f;
export const WM_CLOSE = 0x0010;
export const WM_SHOWWINDOW = 0x0018;
export const WM_SETCURSOR = 0x0020;
export const WM_GETMINMAXINFO = 0x0024;
export const WM_NEXTDLGCTL = 0x0028;
export const WM_DRAWITEM = 0x002b;
export const WM_SETFONT = 0x0030;
export const WM_GETFONT = 0x0031;
export const WM_WINDOWPOSCHANGING = 0x0046;
export const WM_WINDOWPOSCHANGED = 0x0047;
export const WM_NOTIFY = 0x004e;
export const WM_SETICON = 0x0080;
export const WM_NCCREATE = 0x0081;
export const WM_NCDESTROY = 0x0082;
export const WM_GETDLGCODE = 0x0087;
export const WM_KEYDOWN = 0x0100;
export const WM_KEYUP = 0x0101;
export const WM_CHAR = 0x0102;
export const WM_KEYFIRST = 0x0100;
export const WM_KEYLAST = 0x0109;
export const WM_INITDIALOG = 0x0110;
export const WM_COMMAND = 0x0111;
export const WM_SYSCOMMAND = 0x0112;
export const WM_TIMER = 0x0113;
export const WM_HSCROLL = 0x0114;
export const WM_VSCROLL = 0x0115;
export const WM_CTLCOLORMSGBOX = 0x0132;
export const WM_CTLCOLOREDIT = 0x0133;
export const WM_CTLCOLORLISTBOX = 0x0134;
export const WM_CTLCOLORBTN = 0x0135;
export const WM_CTLCOLORDLG = 0x0136;
export const WM_CTLCOLORSCROLLBAR = 0x0137;
export const WM_CTLCOLORSTATIC = 0x0138;
export const WM_MOUSEMOVE = 0x0200;
export const WM_LBUTTONDOWN = 0x0201;
export const WM_LBUTTONUP = 0x0202;
export const WM_ENTERSIZEMOVE = 0x0231;
export const WM_EXITSIZEMOVE = 0x0232;
export const WM_USER = 0x0400;
export const WM_APP = 0x8000;

// GetWindowLong indexes.
export const GWL_WNDPROC = -4;
export const GWL_HINSTANCE = -6;
export const GWL_HWNDPARENT = -8;
export const GWL_STYLE = -16;
export const GWL_EXSTYLE = -20;
export const GWL_USERDATA = -21;
export const GWL_ID = -12;
export const DWL_MSGRESULT = 0;
export const DWL_DLGPROC = 4;
export const DWL_USER = 8;

// Window styles.
export const WS_OVERLAPPED = 0x00000000;
export const WS_POPUP = 0x80000000 | 0;
export const WS_CHILD = 0x40000000;
export const WS_MINIMIZE = 0x20000000;
export const WS_VISIBLE = 0x10000000;
export const WS_DISABLED = 0x08000000;
export const WS_CLIPSIBLINGS = 0x04000000;
export const WS_CLIPCHILDREN = 0x02000000;
export const WS_MAXIMIZE = 0x01000000;
export const WS_CAPTION = 0x00c00000;
export const WS_BORDER = 0x00800000;
export const WS_DLGFRAME = 0x00400000;
export const WS_VSCROLL = 0x00200000;
export const WS_HSCROLL = 0x00100000;
export const WS_SYSMENU = 0x00080000;
export const WS_THICKFRAME = 0x00040000;
export const WS_GROUP = 0x00020000;
export const WS_TABSTOP = 0x00010000;
export const WS_EX_DLGMODALFRAME = 0x00000001;
export const WS_EX_NOPARENTNOTIFY = 0x00000004;
export const WS_EX_TOPMOST = 0x00000008;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_WINDOWEDGE = 0x00000100;
export const WS_EX_CLIENTEDGE = 0x00000200;
export const WS_EX_CONTROLPARENT = 0x00010000;
export const WS_EX_APPWINDOW = 0x00040000;

// Dialog styles.
export const DS_ABSALIGN = 0x01;
export const DS_SETFONT = 0x40;
export const DS_MODALFRAME = 0x80;
export const DS_CONTROL = 0x0400;
export const DS_CENTER = 0x0800;
export const DS_CENTERMOUSE = 0x1000;
export const DS_SHELLFONT = DS_SETFONT | 0x08;

// ShowWindow.
export const SW_HIDE = 0;
export const SW_SHOWNORMAL = 1;
export const SW_SHOWMINIMIZED = 2;
export const SW_SHOWMAXIMIZED = 3;
export const SW_SHOWNOACTIVATE = 4;
export const SW_SHOW = 5;
export const SW_MINIMIZE = 6;
export const SW_SHOWMINNOACTIVE = 7;
export const SW_SHOWNA = 8;
export const SW_RESTORE = 9;

// SetWindowPos.
export const SWP_NOSIZE = 0x0001;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOZORDER = 0x0004;
export const SWP_NOREDRAW = 0x0008;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_FRAMECHANGED = 0x0020;
export const SWP_SHOWWINDOW = 0x0040;
export const SWP_HIDEWINDOW = 0x0080;
export const HWND_TOP = 0;
export const HWND_BOTTOM = 1;
export const HWND_TOPMOST = -1;
export const HWND_NOTOPMOST = -2;

// Scroll bars.
export const SB_HORZ = 0;
export const SB_VERT = 1;
export const SB_CTL = 2;
export const SIF_RANGE = 0x1;
export const SIF_PAGE = 0x2;
export const SIF_POS = 0x4;
export const SIF_DISABLENOSCROLL = 0x8;
export const SIF_TRACKPOS = 0x10;
export const SIF_ALL = SIF_RANGE | SIF_PAGE | SIF_POS | SIF_TRACKPOS;

// Command ids and dialog codes.
export const IDOK = 1;
export const IDCANCEL = 2;

// Last-error codes.
export const ERROR_SUCCESS = 0;
export const ERROR_INVALID_PARAMETER = 87;
export const ERROR_INVALID_WINDOW_HANDLE = 1400;
export const ERROR_CANNOT_FIND_WND_CLASS = 1407;
export const ERROR_CLASS_ALREADY_EXISTS = 1410;
export const ERROR_CONTROL_ID_NOT_FOUND = 1421;
export const ERROR_INVALID_DLG_ITEM = ERROR_CONTROL_ID_NOT_FOUND;
export const ERROR_INVALID_INDEX = 1413;
export const ERROR_RESOURCE_NAME_NOT_FOUND = 1814;

// --- Exports -------------------------------------------------------------------------------

export interface User32Exports {
  // Window classes.
  /** Returns the class atom, 0 on failure. */
  RegisterClassExW(cls: WindowClassEx): number;
  UnregisterClassW(className: string, instance: number): boolean;
  GetClassInfoExW(instance: number, className: string): WindowClassEx | null;
  GetClassNameW(hwnd: number): string | null;

  // Windows.
  /**
   * `className` is a class name or an atom; `menu` is a menu handle or a child id;
   * `param` reaches `WM_NCCREATE`/`WM_CREATE` as `CREATESTRUCT.lpCreateParams`.
   */
  CreateWindowExW(
    exStyle: number,
    className: string | number,
    windowName: string,
    style: number,
    x: number,
    y: number,
    width: number,
    height: number,
    parent: number,
    menu: number,
    instance: number,
    param: number,
  ): number;
  DestroyWindow(hwnd: number): boolean;
  IsWindow(hwnd: number): boolean;
  IsWindowVisible(hwnd: number): boolean;
  IsWindowEnabled(hwnd: number): boolean;
  /** Returns whether the window was disabled before. */
  EnableWindow(hwnd: number, enable: boolean): boolean;
  /** Returns whether the window was visible before. */
  ShowWindow(hwnd: number, cmdShow: number): boolean;
  UpdateWindow(hwnd: number): boolean;
  InvalidateRect(hwnd: number, rect: Rect | null, erase: boolean): boolean;
  LockWindowUpdate(hwnd: number): boolean;
  IsIconic(hwnd: number): boolean;
  IsZoomed(hwnd: number): boolean;
  GetParent(hwnd: number): number;
  SetParent(hwnd: number, parent: number): number;
  GetDlgCtrlID(hwnd: number): number;
  /** Calls `callback(hwnd)` for every descendant until it returns false. */
  EnumChildWindows(parent: number, callback: (hwnd: number) => boolean): boolean;
  /** Calls `callback(hwnd)` for every top-level window of the thread until it returns false. */
  EnumThreadWindows(callback: (hwnd: number) => boolean): boolean;
  GetWindowLongW(hwnd: number, index: number): number;
  SetWindowLongW(hwnd: number, index: number, value: number): number;
  GetPropW(hwnd: number, name: string): number;
  SetPropW(hwnd: number, name: string, value: number): boolean;
  RemovePropW(hwnd: number, name: string): number;
  GetWindowTextW(hwnd: number): string;
  GetWindowTextLengthW(hwnd: number): number;
  SetWindowTextW(hwnd: number, text: string): boolean;
  GetWindowRect(hwnd: number): Rect | null;
  GetClientRect(hwnd: number): Rect | null;
  SetWindowPos(
    hwnd: number,
    insertAfter: number,
    x: number,
    y: number,
    cx: number,
    cy: number,
    flags: number,
  ): boolean;
  MoveWindow(hwnd: number, x: number, y: number, w: number, h: number, repaint: boolean): boolean;
  /** Maps points from one window's client coordinates to another's (0: the screen). */
  MapWindowPoints(from: number, to: number, points: Point[]): number;
  ClientToScreen(hwnd: number, point: Point): boolean;
  ScreenToClient(hwnd: number, point: Point): boolean;
  AdjustWindowRectEx(rect: Rect, style: number, menu: boolean, exStyle: number): boolean;
  GetForegroundWindow(): number;
  SetForegroundWindow(hwnd: number): boolean;
  GetFocus(): number;
  SetFocus(hwnd: number): number;
  GetActiveWindow(): number;

  // Messages.
  /** `GetMessageExtraInfo`: the extra information of the input message being processed. */
  GetMessageExtraInfo(): number;
  SendMessageW(hwnd: number, msg: number, wParam: number, lParam: number): number;
  PostMessageW(hwnd: number, msg: number, wParam: number, lParam: number): boolean;
  CallWindowProcW(proc: number, hwnd: number, msg: number, wParam: number, lParam: number): number;
  DefWindowProcW(hwnd: number, msg: number, wParam: number, lParam: number): number;

  // Scroll bars.
  GetScrollInfo(hwnd: number, bar: number, info: ScrollInfo): boolean;
  /** Returns the new position. */
  SetScrollInfo(hwnd: number, bar: number, info: ScrollInfo, redraw: boolean): number;

  // Dialogs.
  /**
   * Creates a modeless dialog from the `DLGTEMPLATE`/`DLGTEMPLATEEX` at `template` in the
   * process memory. Returns the dialog window, 0 on failure.
   */
  CreateDialogIndirectParamW(
    instance: number,
    template: number,
    owner: number,
    dialogProc: WindowProcedure,
    initParam: number,
  ): number;
  /** Runs a modal dialog; settles with the `EndDialog` result, or -1 when it cannot start. */
  DialogBoxIndirectParamW(
    instance: number,
    template: number,
    owner: number,
    dialogProc: WindowProcedure,
    initParam: number,
  ): Promise<number>;
  EndDialog(hwnd: number, result: number): boolean;
  GetDlgItem(hwnd: number, id: number): number;
  SendDlgItemMessageW(
    hwnd: number,
    id: number,
    msg: number,
    wParam: number,
    lParam: number,
  ): number;
  GetDlgItemTextW(hwnd: number, id: number): string | null;
  SetDlgItemTextW(hwnd: number, id: number, text: string): boolean;
  /** Returns null when the text is not a number in range. */
  GetDlgItemInt(hwnd: number, id: number, signed: boolean): number | null;
  SetDlgItemInt(hwnd: number, id: number, value: number, signed: boolean): boolean;
  /** `LOWORD`: horizontal base unit, `HIWORD`: vertical (the system font). */
  GetDialogBaseUnits(): number;
  MapDialogRect(hwnd: number, rect: Rect): boolean;
  IsDialogMessageW(hwnd: number, msg: Message): boolean;

  // Message boxes.
  MessageBoxW(owner: number, text: string, caption: string, type: number): Promise<number>;

  // Painting.
  /**
   * `GetDC`: a device context drawing into the window's client surface, a 32-bit top-down
   * bitmap of the client size in the process memory that the host presents.
   */
  GetDC(hwnd: number): number;
  ReleaseDC(hwnd: number, hdc: number): boolean;

  // Icons and system.
  /** `CreateIconIndirect`: the icon keeps copies of the bitmaps' handles' contents. */
  CreateIconIndirect(info: IconInfo): number;
  /** `LoadIconW(NULL, IDI_*)`. */
  LoadIconW(instance: number, name: string | number): number;
  DestroyIcon(icon: number): boolean;
  GetSystemMetrics(index: number): number;
  GetCursorPos(): Point;
  SetCursorPos(x: number, y: number): boolean;
}

export const USER32 = defineNativeContract<User32Exports>('user32.dll', '1');
