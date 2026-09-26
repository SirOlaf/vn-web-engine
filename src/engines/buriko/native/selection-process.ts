import type {BurikoBpPointer} from '../bp/memory.js';
import {push32, type BurikoBpThread} from '../bp/state.js';
import {allocateBurikoBitmap, type BurikoBitmapRectangle} from './bitmap.js';
import {clearBurikoBitmap} from './bitmap-copy.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoNativeCursorMotion} from './cursor-motion.js';
import type {BurikoWindowDisplayObject} from './display-window.js';
import {BurikoBitmapText} from './font-bitmap.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoNativeNotifications} from './notification-queue.js';
import {
  BurikoProcedure,
  type BurikoProcedureState,
  type BurikoWindowMessages,
} from './procedure.js';
import type {BurikoSelectionState} from './selection-state.js';
import {drawBurikoSelectionText} from './selection-text.js';
import {copyText, textLength} from './text.js';

/** 07DA20 CProcSelectItem, with virtual boundaries shared by its actual Ex subclasses. */
export class BurikoSelectionProcess extends BurikoProcedure {
  protected selection = 0;
  protected priorHover = -1;
  protected items: BurikoBpPointer[] = [];
  protected rectangles: BurikoBitmapRectangle[] = [];
  protected columns = 0;
  protected centered = 0;
  protected color = 0;
  protected cancelEnabled = 0;
  protected phase = 0;
  protected blink = 0;
  protected inputBits = 0;
  protected mouseMessage = false;
  protected pointerEligible = false;
  protected dirty = false;

  constructor(
    thread: BurikoBpThread,
    shared: BurikoProcedureState,
    clock: BurikoNativeClock,
    protected readonly window: BurikoWindowDisplayObject,
    protected readonly input: BurikoNativeInput,
    protected readonly waits: BurikoWindowMessages,
    protected readonly notifications: BurikoNativeNotifications,
    protected readonly cursor: BurikoNativeCursorMotion,
    protected readonly settings: BurikoSelectionState,
  ) {
    super(thread, shared, clock);
    window.setTextTransparency(0);
    window.setTextEnabled(1);
    window.composeAll();
    window.disableOverlays();
    waits.register(thread, 0x200);
    const key = window.sortKey();
    input.installPointerCapture(key);
    input.installKeyCapture(key);
    input.collect(key, key);
    shared.registerPointerPriority(this.id, window.sortKey());
  }

  initialize(
    items: readonly (BurikoBpPointer | null)[],
    columns: number,
    centered: number,
    color: number,
    selection: number,
    cancelEnabled: number,
  ): void {
    this.columns = columns | 0;
    this.items = items.map((source) => {
      if (source === null) throw new Error('Buriko selection copies a null item');
      const owned = {bytes: new Uint8Array(textLength(source) + 1), offset: 0};
      copyText(owned, source);
      return owned;
    });
    this.centered = centered | 0;
    this.color = color >>> 0;
    this.rectangles = drawBurikoSelectionText(
      this.window,
      this.items,
      this.columns,
      centered,
      color,
    );
    this.dirty = true;
    this.selection = selection | 0;
    this.cancelEnabled = cancelEnabled | 0;
  }

  protected maskInput(bits: number): number {
    return bits & 0x03fff3c3;
  }
  protected interval(): number {
    return this.settings.interval;
  }
  protected damage(area: BurikoBitmapRectangle | null): void {
    if (area !== null) this.window.environment.damage.record(this.window.sortKey(), area);
  }
  protected hitTest(): number {
    const [x, y] = this.input.pointerPosition(),
      position = this.window.position(),
      localX = (x - position.x) | 0,
      localY = (y - position.y) | 0;
    return this.rectangles.findIndex(
      (r) => r.left <= localX && localX <= r.right && r.top <= localY && localY <= r.bottom,
    );
  }
  protected hover(): boolean {
    if (!this.pointerEligible) return false;
    const next = this.hitTest();
    const changed = next >= 0 && next !== this.selection;
    if (changed) this.selection = next;
    if (next !== this.priorHover) {
      this.notifications.push(0x10000002, this.thread.id, next);
      this.priorHover = next;
    }
    return changed;
  }
  protected drawHighlight(color: number): void {
    const rectangle = this.rectangles[this.selection],
      source = this.items[this.selection];
    if (rectangle === undefined || source === undefined)
      throw new Error('Buriko selection highlight consumes an undefined item');
    const bitmap = allocateBurikoBitmap(
      (rectangle.right - rectangle.left + 1) | 0,
      this.window.fontSize,
      1,
    );
    clearBurikoBitmap(bitmap);
    const surfaces = this.window.windowState.manager.surfaces;
    new BurikoBitmapText(surfaces.fonts, surfaces.compositor).draw(
      bitmap,
      {value: 0},
      0,
      0,
      source,
      this.window.fontId,
      color,
      0x80,
      this.window.characterSpacing,
      0,
      0,
    );
    this.window.setOverlayBitmap(0, bitmap);
    bitmap.storage?.release();
  }
  protected drawSelection(): void {
    this.damage(this.window.overlayRectangle(0));
    if (this.selection === -1) {
      this.setDeadline(0);
      this.window.setOverlayEnabled(0, 0);
      this.dirty = true;
      return;
    }
    this.setDeadline(this.interval());
    const color = this.settings.colors[0]!;
    if (color !== 0) this.drawHighlight(color);
    const rectangle = this.rectangles[this.selection];
    if (rectangle === undefined) throw new Error('Buriko selection positions an undefined item');
    this.window.setOverlayPosition(0, rectangle.left, rectangle.top, 0);
    this.window.setOverlayEnabled(0, Number(color !== 0));
    this.damage(this.window.overlayRectangle(0));
    this.blink = 0;
    this.dirty = true;
  }
  protected blinkSelection(): void {
    this.setDeadline(this.interval());
    this.damage(this.window.overlayRectangle(0));
    this.blink ^= 1;
    const color = this.settings.colors[this.blink]!;
    if (color !== 0) this.drawHighlight(color);
    this.window.setOverlayEnabled(0, Number(color !== 0));
    this.damage(this.window.overlayRectangle(0));
    this.dirty = true;
  }
  protected moveCursor(index: number): void {
    const r = this.rectangles[index];
    if (r === undefined) throw new Error('Buriko selection cursor reads an undefined rectangle');
    const p = this.window.position();
    this.cursor.start(
      (p.x + r.left + (((r.right - r.left + 1) | 0) >> 1)) | 0,
      (p.y + r.top + (((r.bottom - r.top + 1) | 0) >> 1)) | 0,
      this.settings.cursorEasing,
      this.settings.cursorDuration,
      this.settings.cursorRate,
      0,
    );
  }
  /** 07CF20 preserves bit priority and wraps across missing cells in the final row. */
  protected handleInput(): 0 | 1 | 2 {
    const bits = this.inputBits;
    if ((bits & 0x03ff0000) !== 0) {
      for (let index = 0; index < 10; index++)
        if ((bits & (0x10000 << index)) !== 0 && index < this.items.length) {
          this.selection = index;
          return 1;
        }
      return 0;
    }
    if ((bits & 0x303) !== 0) {
      if ((bits & 0x202) !== 0) {
        this.selection = -1;
        return 1;
      }
      if ((bits & 1) === 0) return 1;
      const hit = this.hitTest();
      if (hit < 0) return 0;
      this.selection = hit;
      return 1;
    }
    if ((bits & 0xf0c0) === 0) return 0;
    const order =
        this.settings.wheelMotion === 0
          ? [0x1000, 0x2000, 0x4000, 0x8000]
          : [0x40, 0x80, 0x1000, 0x2000, 0x4000, 0x8000],
      direction = order.find((bit) => (bits & bit) !== 0) ?? 0;
    if (this.columns === 0) throw new RangeError('Buriko selection navigation divides by zero');
    let row = Math.trunc(this.selection / this.columns),
      column = this.selection % this.columns;
    const rows = Math.trunc((this.items.length - 1 + this.columns) / this.columns);
    const vertical =
      direction === 0x40 || direction === 0x80 || direction === 0x1000 || direction === 0x2000;
    const limit = vertical ? rows : this.columns;
    if (direction !== 0)
      for (let attempt = 0; attempt < limit; attempt++) {
        if (vertical)
          row =
            direction === 0x40 || direction === 0x1000
              ? (row - 1 < 0 ? rows : row) - 1
              : row + 1 < rows
                ? row + 1
                : 0;
        else
          column =
            direction === 0x4000
              ? (column - 1 < 0 ? this.columns : column) - 1
              : column + 1 < this.columns
                ? column + 1
                : 0;
        const index = (Math.imul(this.columns, row) + column) | 0;
        if (index < this.items.length) {
          if (direction === 0x40 || direction === 0x80) this.moveCursor(index);
          else this.selection = index;
          break;
        }
      }
    return direction === 0 ? 0 : 2;
  }
  protected advance(): number {
    if (this.phase === 0) {
      this.drawSelection();
      this.phase = (this.phase + 1) | 0;
    }
    if (this.inputBits === 0) {
      if (this.mouseMessage && this.hover()) {
        this.drawSelection();
        this.notifications.push(0x10000001, this.thread.id, this.selection);
        return 0;
      }
    } else {
      const result = this.handleInput();
      if (result === 1) {
        this.phase = 0;
        this.drawSelection();
        return 1;
      }
      if (result === 2) {
        this.drawSelection();
        this.notifications.push(0x10000001, this.thread.id, this.selection);
        return 0;
      }
    }
    if (this.deadlineReached()) this.blinkSelection();
    return 0;
  }
  poll(): number {
    this.consumeMessages();
    const key = this.window.sortKey();
    this.inputBits = this.maskInput(this.input.collect(key, key));
    if (this.cancelEnabled === 0) this.inputBits &= ~0x202;
    const message = this.waits.consume(this.thread, 0x200);
    if (message === null)
      throw new Error('Buriko selection consumes undefined window-message scratch');
    this.mouseMessage = message.received;
    const previous = this.pointerEligible;
    this.pointerEligible =
      this.shared.pointerPriorityAllowed(this.window.sortKey()) &&
      (this.settings.foregroundOnly === 0 || this.input.foreground);
    let finished = 0;
    if (
      this.deadlineReached() ||
      this.inputBits !== 0 ||
      this.mouseMessage ||
      previous !== this.pointerEligible
    )
      finished = this.advance();
    const manager = this.window.windowState.manager;
    if (
      this.dirty &&
      manager.minimumKey >>> 0 <= this.window.sortKey() >>> 0 &&
      manager.redraw.automaticEnabled !== 0
    ) {
      manager.redraw.request(manager.redraw.automaticMode !== 0 ? 1 : 0);
      this.dirty = false;
    }
    if (finished === 0 && this.canRun()) return 0;
    push32(this.thread, this.selection);
    push32(this.thread, this.canRun() ? this.selection : 0xffffffff);
    return 1;
  }
  override dispose(): void {
    this.input.releasePointerCapture(this.window.sortKey());
    this.input.releaseKeyCapture(this.window.sortKey());
    this.waits.unregister(this.thread, 0x200);
    this.items = [];
    super.dispose();
  }
}
