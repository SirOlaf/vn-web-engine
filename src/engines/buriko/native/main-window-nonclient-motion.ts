import {refinedReciprocal} from '../bp/opcodes/fixed.js';
import {BurikoBrowserMainWindow} from './browser-main-window.js';
import {BurikoDisplayController} from './display-controller.js';
import {BurikoNativeInput} from './input.js';

type OuterRect = readonly [left: number, top: number, right: number, bottom: number];

function snappedClientSize(value: number): number {
  value = Math.fround(value);
  const floor = Math.fround(Math.floor(value)),
    fraction = Math.fround(value - floor),
    tolerance = 2 ** -14;
  if (fraction >= Math.fround(1 - tolerance)) value = Math.fround(Math.ceil(value));
  else if (fraction <= tolerance) value = floor;
  return Math.trunc(value) | 0;
}

/** WM_NCLBUTTONDOWN's saved rectangle and ECB90 FEE40's later mouse-held poll. */
export class BurikoMainWindowNonclientMotion {
  private dragOffset: readonly [number, number] | null = null;
  private resize: {
    hit: number;
    start: readonly [number, number];
    last: readonly [number, number];
    rect: OuterRect;
  } | null = null;

  constructor(
    readonly host: BurikoBrowserMainWindow,
    readonly input: BurikoNativeInput,
    readonly controller: BurikoDisplayController,
  ) {
    if (
      host.display !== input.display ||
      controller.display !== input.display ||
      controller.host !== host
    )
      throw new Error('Buriko nonclient motion requires the shared main window and display owners');
  }

  /** The native receiver accepts HTCAPTION and the eight sizing hit-test values. */
  begin(hit: number, x: number, y: number): boolean {
    hit >>>= 0;
    if (hit !== 2 && (hit < 10 || hit > 17)) return false;
    if (
      !this.host.isLiveMainWindow() ||
      this.host.display.windowMoveImmediate === 0 ||
      this.host.display.fullscreen !== 0
    )
      return true;
    const rect = this.host.readRestoredOuterScreenRectangle();
    if (hit === 2) this.dragOffset = [(x - rect[0]) | 0, (y - rect[1]) | 0];
    else this.resize = {hit, start: [x | 0, y | 0], last: [x | 0, y | 0], rect};
    return true;
  }

  /** FEE40 clears each latch on the first frame without the physical left button. */
  async poll(): Promise<void> {
    if (this.dragOffset === null && this.resize === null) return;
    if ((this.input.asynchronousKeyState(1) & 0x8000) === 0) {
      if (this.dragOffset !== null) this.dragOffset = null;
      else this.resize = null;
      return;
    }
    const [x, y] = this.input.screenCursorPosition();
    if (this.dragOffset !== null) {
      const top = (y - this.dragOffset[1]) | 0;
      this.host.applyPosition((x - this.dragOffset[0]) | 0, top);
      this.host.callbacks.geometryChanged(top);
      return;
    }
    const drag = this.resize!;
    if (x === drag.last[0] && y === drag.last[1]) return;
    const [left, top, right, bottom] = drag.rect,
      display = this.host.display,
      insetX = display.frameInsetWidth | 0,
      insetY = display.frameInsetHeight | 0,
      minimumWidth = (display.logicalWidth | 0) >> 2,
      minimumHeight = (display.logicalHeight | 0) >> 2,
      maximumWidth = display.aspectWidth | 0,
      maximumHeight = display.aspectHeight | 0,
      aspect = Math.fround(
        Math.fround(display.logicalWidth) * refinedReciprocal(Math.fround(display.logicalHeight)),
      ),
      hit = drag.hit;
    let width: number,
      height: number,
      nextLeft = left,
      nextTop = top;
    if (hit === 12 || hit === 15) {
      const measured =
        hit === 12
          ? (bottom - insetY - y + drag.start[1] - top) | 0
          : (y - top - (drag.start[1] - bottom) - insetY) | 0;
      height = Math.min(Math.max(measured, minimumHeight), maximumHeight);
      width = snappedClientSize(Math.fround(Math.fround(height) * aspect));
      if (hit === 12) {
        nextLeft = (right - insetX - width) | 0;
        nextTop = (bottom - insetY - height) | 0;
      }
    } else {
      const isLeft = hit === 10 || hit === 13 || hit === 16,
        measured = isLeft
          ? (right - insetX - x + drag.start[0] - left) | 0
          : (x - left - (drag.start[0] - right) - insetX) | 0;
      width = Math.min(Math.max(measured, minimumWidth), maximumWidth);
      height = snappedClientSize(Math.fround(Math.fround(width) * refinedReciprocal(aspect)));
      if (isLeft) nextLeft = (right - insetX - width) | 0;
      if (hit === 10 || hit === 13 || hit === 14) nextTop = (bottom - insetY - height) | 0;
    }
    display.requestedWidth = width >>> 0;
    display.requestedHeight = height >>> 0;
    display.useSizePreset = 0;
    if (display.fullscreen === 0)
      await this.controller.reconfigure(
        display.selectedSizePreset,
        display.selectedWindowParameter,
        0,
        [nextLeft, nextTop],
        0,
      );
    this.resize = {...drag, last: [x, y]};
  }
}
