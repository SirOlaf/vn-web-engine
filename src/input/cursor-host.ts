/** Cursor effects for a selected window/input host. The window owner maps coordinates. */
export interface CursorHost {
  setVisible(visible: boolean): void;
  setPosition(left: number, top: number): void;
}

/** Position already mapped by the selected window/input owner. Reading it must
 * not consume queued key/button edges or poll another input frame.
 */
export interface PointerPositionHost {
  readPointerPosition(): {readonly x: number; readonly y: number};
}
