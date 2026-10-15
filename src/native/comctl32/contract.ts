import {defineNativeContract} from '../../platform/native-libraries.js';

/**
 * `comctl32.dll` (version 6): the common control classes, which `InitCommonControlsEx`
 * registers with `user32.dll`, and property sheets. Pointers are process memory addresses.
 */
export interface Comctl32Exports {
  InitCommonControls(): void;
  /** `INITCOMMONCONTROLSEX.dwICC` flags; false when a class cannot be registered. */
  InitCommonControlsEx(icc: number): boolean;
  /**
   * `CreatePropertySheetPageW` from a `PROPSHEETPAGEW` at `page` in the process memory.
   * Returns the page handle, 0 on failure.
   */
  CreatePropertySheetPageW(page: number): number;
  DestroyPropertySheetPage(page: number): boolean;
  /**
   * `PropertySheetW` from a `PROPSHEETHEADERW` at `header`: a modal property sheet that
   * settles with its result (-1 on failure).
   */
  PropertySheetW(header: number): Promise<number>;
}

export const ICC_LISTVIEW_CLASSES = 0x00000001;
export const ICC_TREEVIEW_CLASSES = 0x00000002;
export const ICC_BAR_CLASSES = 0x00000004;
export const ICC_TAB_CLASSES = 0x00000008;
export const ICC_UPDOWN_CLASS = 0x00000010;
export const ICC_PROGRESS_CLASS = 0x00000020;
export const ICC_HOTKEY_CLASS = 0x00000040;
export const ICC_ANIMATE_CLASS = 0x00000080;
export const ICC_WIN95_CLASSES = 0x000000ff;
export const ICC_DATE_CLASSES = 0x00000100;
export const ICC_USEREX_CLASSES = 0x00000200;
export const ICC_COOL_CLASSES = 0x00000400;
export const ICC_INTERNET_CLASSES = 0x00000800;
export const ICC_PAGESCROLLER_CLASS = 0x00001000;
export const ICC_NATIVEFNTCTL_CLASS = 0x00002000;
export const ICC_STANDARD_CLASSES = 0x00004000;
export const ICC_LINK_CLASS = 0x00008000;

export const COMCTL32 = defineNativeContract<Comctl32Exports>('comctl32.dll', '6');
