import type {AokanaBpPointer} from '../bp/memory.js';
import {
  allocateAokanaBitmap,
  cropAokanaBitmap,
  fillAokanaBitmap,
  type AokanaBitmap,
} from './bitmap.js';
import {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {AokanaBitmapText, type AokanaFontTextOutput} from './font-bitmap.js';
import {AokanaSurfaces} from './surfaces.js';
import {AokanaNativeText, textBytes} from './text.js';
import {AokanaChildScroll} from './child-scroll.js';
import {AokanaChildScrollbarControl} from './child-scrollbar.js';
import {presentAokanaChildBitmap} from './child-bitmap.js';
import {AokanaWindowMessages, type AokanaWindowMessage} from './window-messages.js';
import {AokanaKeyboardMessages} from './keyboard-messages.js';
import {writeAokanaClipboard} from './modal.js';
import type {AokanaEngineDialogs} from './engine-dialogs.js';
import {writePropertyWord} from './property-values.js';

/** Native b7540 frame extents and GetSystemMetrics(2)/(3), provided by the actual window profile. */
export interface AokanaChildWindowMetrics {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly verticalScrollbarWidth: number;
  readonly horizontalScrollbarHeight: number;
}
interface ChildWindow {
  readonly target: number;
  readonly panel: HTMLElement;
  readonly heading: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly bars: readonly AokanaChildScrollbarControl[];
  minimized: boolean;
  normalHeight: string;
}
interface ChildRecord {
  window: ChildWindow | null;
  bitmap: AokanaBitmap;
  visible: number;
  closeAllowed: number;
  clipboard: Uint8Array | null;
  scroll: AokanaChildScroll;
  field4c: number;
}
function empty(): ChildRecord {
  const scroll = new AokanaChildScroll(0);
  scroll.wheelStep = 0;
  return {
    window: null,
    bitmap: {storage: null, offset: 0, stride: 0, width: 0, height: 0, format: 0, bytesPerPixel: 0},
    visible: 0,
    closeAllowed: 0,
    clipboard: null,
    scroll,
    field4c: 0,
  };
}

/** Eight native auxiliary bitmap windows at 14027c7b0, separate from surface-slot ownership. */
export class AokanaChildWindows {
  private enabled = false;
  private readonly records = Array.from({length: 8}, empty);
  // Reinitializing the native global table neither closes existing HWNDs nor frees their allocations.
  private readonly orphaned: ChildRecord[] = [];
  private readonly ownedTargets = new Set<number>();
  constructor(
    readonly document: Document,
    readonly parent: HTMLElement,
    readonly navigator: Navigator,
    readonly text: AokanaNativeText,
    readonly surfaces: AokanaSurfaces,
    readonly compositor: AokanaBitmapCompositor,
    readonly bitmapText: AokanaBitmapText,
    readonly dialogs: AokanaEngineDialogs,
    readonly messages: AokanaWindowMessages,
    readonly keyboard: AokanaKeyboardMessages,
    readonly metrics: AokanaChildWindowMetrics,
    readonly nativeWindowTitle: Uint8Array,
    readonly desktopCanvas: HTMLCanvasElement,
  ) {}

  /** 14006de40: zeroing is intentionally independent of 14006ddd0's closing pass. */
  initialize(): void {
    for (let index = 0; index < 8; index++) {
      const old = this.records[index]!;
      if (old.window !== null || old.bitmap.storage !== null || old.clipboard !== null)
        this.orphaned.push(old);
      this.records[index] = empty();
    }
    this.enabled = true;
  }
  dispose(): void {
    if (!this.enabled) return;
    for (let index = 0; index < 8; index++)
      if (this.records[index]!.window !== null) this.close(0xf8000000 + index);
    this.enabled = false;
  }
  /** 14006cd00 uses RDW_INVALIDATE|RDW_FRAME, without RDW_UPDATENOW. */
  invalidateVisible(): void {
    if (!this.enabled) return;
    for (const record of this.records)
      if (record.window !== null && record.visible !== 0)
        this.messages.invalidate(record.window.target);
  }
  private record(handle: number): ChildRecord | null {
    handle >>>= 0;
    return (handle & 0xff000000) >>> 0 === 0xf8000000 && (handle & 0xffffff) < 8
      ? this.records[handle & 0xffffff]!
      : null;
  }

  create(
    output: AokanaBpPointer | null,
    title: AokanaBpPointer | null,
    x: number,
    y: number,
    width: number,
    height: number,
    flags: number,
  ): number {
    width |= 0;
    height |= 0;
    flags >>>= 0;
    if ((width - 32) >>> 0 >= 0x7e1 || (height - 32) >>> 0 >= 0x7e1) return 0x80000001;
    const index = this.records.findIndex((record) => record.window === null);
    if (index < 0) return 0x80000002;
    const record = this.records[index]!;
    writePropertyWord(output, 0xf8000000 + index);
    if (record.bitmap.storage !== null || record.clipboard !== null)
      this.orphaned.push({...record});
    record.bitmap = allocateAokanaBitmap(width, height, this.compositor.defaultFormat);
    fillAokanaBitmap(record.bitmap, 0);
    if (title === null)
      throw new Error(
        'Aokana child creation decodes a null native title after allocating its bitmap',
      );
    const caption = this.text.decodeAuto(title);
    const scroll = new AokanaChildScroll(flags);
    let allocatedTarget: number | null = null;
    try {
      const panel = this.document.createElement('section');
      panel.setAttribute('role', 'dialog');
      panel.tabIndex = 0;
      panel.hidden = true;
      panel.style.cssText =
        'position:fixed;z-index:20;border:1px solid;background:Canvas;color:CanvasText;box-sizing:border-box;overflow:hidden';
      panel.style.borderWidth = `${this.metrics.frameWidth / 2}px`;
      const heading = this.document.createElement('header');
      heading.style.cssText = 'display:flex;align-items:center;cursor:move;touch-action:none';
      heading.style.height = `${this.metrics.frameHeight - this.metrics.frameWidth}px`;
      const titleElement = this.document.createElement('span');
      titleElement.textContent = caption;
      const minimize = this.document.createElement('button');
      minimize.type = 'button';
      minimize.textContent = '−';
      minimize.setAttribute('aria-label', 'Minimize');
      const close = this.document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Close');
      heading.append(titleElement, minimize, close);
      const body = this.document.createElement('div');
      body.style.cssText = 'display:grid;overflow:hidden';
      body.style.gridTemplateColumns = `minmax(0,1fr) ${flags & 2 ? this.metrics.verticalScrollbarWidth : 0}px`;
      body.style.gridTemplateRows = `minmax(0,1fr) ${flags & 1 ? this.metrics.horizontalScrollbarHeight : 0}px`;
      body.style.height = `calc(100% - ${this.metrics.frameHeight - this.metrics.frameWidth}px)`;
      const canvas = this.document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.style.cssText = 'grid-column:1;grid-row:1;display:block';
      body.append(canvas);
      panel.append(heading, body);
      const target = this.messages.createTarget();
      allocatedTarget = target;
      const bars: AokanaChildScrollbarControl[] = [];
      for (const axis of [0, 1] as const)
        if ((flags & (1 << axis)) !== 0) {
          const bar = new AokanaChildScrollbarControl(
            this.document,
            axis,
            scroll.bars[axis],
            this.messages,
            target,
          );
          bar.element.style.gridColumn = axis === 0 ? '1' : '2';
          bar.element.style.gridRow = axis === 0 ? '2' : '1';
          body.append(bar.element);
          bars.push(bar);
        }
      record.window = {
        target,
        panel,
        heading: titleElement,
        canvas,
        bars,
        minimized: false,
        normalHeight: '',
      };
      record.visible = 0;
      record.closeAllowed = 0;
      record.clipboard = null;
      record.scroll = scroll;
      record.field4c = 1;
      this.ownedTargets.add(target);
      this.movePanel(record, x, y, true);
      close.addEventListener('click', () =>
        this.messages.post({target, message: 0x10, wParam: 0, lParam: 0}),
      );
      // WS_MINIMIZEBOX belongs to the host window. It does not change the script-visible show integer.
      minimize.addEventListener('click', () => {
        const window = record.window;
        if (window === null) return;
        window.minimized = !window.minimized;
        body.hidden = window.minimized;
        panel.style.height = window.minimized
          ? `${this.metrics.frameHeight}px`
          : window.normalHeight;
      });
      let drag: {pointer: number; x: number; y: number; left: number; top: number} | null = null;
      heading.addEventListener('pointerdown', (event) => {
        if (event.target === close || event.target === minimize) return;
        event.preventDefault();
        const bounds = panel.getBoundingClientRect();
        drag = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: bounds.left,
          top: bounds.top,
        };
        heading.setPointerCapture(event.pointerId);
      });
      heading.addEventListener('pointermove', (event) => {
        if (drag?.pointer !== event.pointerId) return;
        panel.style.left = `${Math.trunc(drag.left + event.clientX - drag.x)}px`;
        panel.style.top = `${Math.trunc(drag.top + event.clientY - drag.y)}px`;
      });
      const stop = (event: PointerEvent): void => {
        if (drag?.pointer !== event.pointerId) return;
        drag = null;
        if (heading.hasPointerCapture(event.pointerId))
          heading.releasePointerCapture(event.pointerId);
      };
      heading.addEventListener('pointerup', stop);
      heading.addEventListener('pointercancel', stop);
      for (const name of ['keydown', 'keyup'] as const)
        panel.addEventListener(name, (event) => {
          this.keyboard.post(target, event);
          event.stopPropagation();
          if (event.key !== 'Tab') event.preventDefault();
        });
      panel.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          const delta = event.deltaY === 0 ? 0 : event.deltaY < 0 ? 120 : -120;
          const keyFlags = (event.shiftKey ? 4 : 0) | (event.ctrlKey ? 8 : 0);
          const position =
            ((Math.trunc(event.screenY) & 0xffff) << 16) | (Math.trunc(event.screenX) & 0xffff);
          this.messages.post({
            target,
            message: 0x20a,
            wParam: (((delta & 0xffff) << 16) | keyFlags) >>> 0,
            lParam: position >>> 0,
          });
        },
        {passive: false},
      );
      this.parent.append(panel);
      return 0;
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      // Native CreateWindowExW failure leaves the newly allocated bitmap in a slot whose HWND is NULL.
      if (allocatedTarget !== null) {
        this.messages.forgetTarget(allocatedTarget);
        this.ownedTargets.delete(allocatedTarget);
      }
      record.window?.panel.remove();
      record.window = null;
      record.visible = 0;
      record.closeAllowed = 0;
      record.clipboard = null;
      record.scroll = scroll;
      record.field4c = 1;
      return 0;
    }
  }
  private movePanel(record: ChildRecord, x: number, y: number, creating: boolean): void {
    const window = record.window;
    if (window === null) return;
    window.panel.style.left = `${x | 0}px`;
    window.panel.style.top = `${y | 0}px`;
    window.panel.style.width = `${(record.bitmap.width + this.metrics.frameWidth + (creating && (record.scroll.flags & 2) !== 0 ? this.metrics.verticalScrollbarWidth : 0)) | 0}px`;
    window.normalHeight = `${(record.bitmap.height + this.metrics.frameHeight + (creating && (record.scroll.flags & 1) !== 0 ? this.metrics.horizontalScrollbarHeight : 0)) | 0}px`;
    window.panel.style.height = window.minimized
      ? `${this.metrics.frameHeight}px`
      : window.normalHeight;
  }
  setPosition(handle: number, x: number, y: number): 0 | 1 {
    const record = this.record(handle);
    if (record === null) return 0;
    this.movePanel(record, x, y, false);
    if (record.window !== null) this.messages.invalidate(record.window.target);
    return 1;
  }
  getPosition(output: AokanaBpPointer | null, handle: number): 0 | 1 {
    const record = this.record(handle);
    if (record === null) return 0;
    if (record.window === null)
      throw new Error(
        'Aokana child GetWindowRect reads an uninitialized RECT after its null HWND fails',
      );
    const bounds = record.window.panel.getBoundingClientRect();
    writePropertyWord(output, Math.trunc(bounds.left));
    writePropertyWord(
      output === null ? null : {bytes: output.bytes, offset: output.offset + 4},
      Math.trunc(bounds.top),
    );
    return 1;
  }
  show(handle: number, visible: number): 0 | 1 {
    const record = this.record(handle);
    if (record === null) return 0;
    visible |= 0;
    if ((visible === 0) === (record.visible === 0)) return 1;
    record.visible = visible;
    this.dialogs.transition(visible !== 0);
    if (record.window !== null) {
      record.window.panel.hidden = visible === 0;
      if (visible !== 0) this.messages.invalidate(record.window.target);
    }
    return 1;
  }
  close(handle: number): 0 | 1 {
    const record = this.record(handle);
    if (record === null) return 0;
    record.closeAllowed = 1;
    if (record.window !== null) this.closeWindow(record);
    return 1;
  }
  private closeWindow(record: ChildRecord): void {
    if (record.closeAllowed === 0 || record.window === null) return;
    if (record.visible !== 0) this.dialogs.transition(false);
    const window = record.window;
    window.panel.remove();
    record.bitmap.storage?.release();
    this.messages.forgetTarget(window.target);
    this.ownedTargets.delete(window.target);
    Object.assign(record, empty());
  }
  setTitle(handle: number, title: AokanaBpPointer | null): 0 | 1 {
    const record = this.record(handle);
    if (record === null) return 0;
    const value = this.text.decodeAuto(title ?? {bytes: this.nativeWindowTitle, offset: 0});
    if (record.window !== null) record.window.heading.textContent = value;
    return 1;
  }
  setClipboard(handle: number, source: AokanaBpPointer | null): number {
    const record = this.record(handle);
    if (record === null) return 0xffffffff;
    record.clipboard = null;
    if (source === null)
      throw new Error(
        'Aokana child clipboard replacement scans null after freeing its previous text',
      );
    record.clipboard = textBytes(source, true).slice();
    return 0;
  }
  setScrollProperty(handle: number, selector: number, value: number): number {
    const record = this.record(handle);
    if (record === null) return 0xffffffff;
    const result = record.scroll.setProperty(selector, value);
    for (const bar of record.window?.bars ?? []) bar.update();
    return result;
  }
  getScrollProperty(output: AokanaBpPointer | null, handle: number, selector: number): number {
    const record = this.record(handle);
    if (record === null) return 0xffffffff;
    const found = record.scroll.getProperty(selector);
    if (found.result === 0) writePropertyWord(output, found.value!);
    return found.result;
  }
  private present(record: ChildRecord, bitmap = record.bitmap, x = 0, y = 0): void {
    presentAokanaChildBitmap(record.window?.canvas ?? this.desktopCanvas, bitmap, x, y);
  }
  fill(handle: number, color: number): 0 | 1 {
    const record = this.record(handle);
    if (record === null) return 0;
    fillAokanaBitmap(record.bitmap, color);
    this.present(record);
    return 1;
  }
  copy(
    handle: number,
    x: number,
    y: number,
    surface: number,
    mode: number,
    opacity: number,
  ): number {
    const record = this.record(handle);
    if (record === null) return 0xffffffff;
    const source = this.surfaces.snapshot(surface);
    if (source === null) return 0x80000003;
    const result = this.compositor.draw(record.bitmap, x | 0, y | 0, source, mode, opacity);
    if (result !== 0) return (0x80000003 + result) >>> 0;
    this.present(record);
    return 0;
  }
  copyCrop(
    handle: number,
    x: number,
    y: number,
    surface: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ): number {
    left |= 0;
    top |= 0;
    width |= 0;
    height |= 0;
    if (left < 0 || top < 0) return 0x8000000e;
    if (width < 1 || height < 1) return 0x80000008;
    const record = this.record(handle);
    if (record === null) return 0xffffffff;
    const source = this.surfaces.snapshot(surface);
    if (source === null) return 0x80000003;
    if (
      !cropAokanaBitmap(source, {
        left,
        top,
        right: (left + width - 1) | 0,
        bottom: (top + height - 1) | 0,
      })
    )
      return 0x8000000e;
    const result = this.compositor.draw(record.bitmap, x | 0, y | 0, source, 0x80, 0);
    if (result !== 0) return (0x80000003 + result) >>> 0;
    const updated = {...record.bitmap};
    cropAokanaBitmap(updated, {
      left: x | 0,
      top: y | 0,
      right: (x + width - 1) | 0,
      bottom: (y + height - 1) | 0,
    });
    this.present(record, updated, x, y);
    return 0;
  }
  async drawText(
    handle: number,
    x: number,
    y: number,
    source: AokanaBpPointer | null,
    nameIndex: number,
    size: number,
    widthPercent: number,
    bold: number,
    proportional: number,
    color: number,
    output: AokanaFontTextOutput,
  ): Promise<number> {
    const record = this.record(handle);
    if (record === null) return 0xffffffff;
    const font = await this.bitmapText.fonts.get(
      this.bitmapText.fonts.name(nameIndex),
      size,
      widthPercent,
      bold,
    );
    if (font.result !== 0)
      return font.result === 0x80000002
        ? 0x80000009
        : font.result === 0x80000003
          ? 0x8000000a
          : font.result === 0x80000004
            ? 0x8000000b
            : font.id;
    this.bitmapText.draw(
      record.bitmap,
      output,
      x,
      y,
      source,
      font.id,
      color,
      0,
      proportional,
      0,
      0,
    );
    this.present(record);
    return 0;
  }

  /** Main-window message dispatch routes every owned auxiliary HWND here, including orphans. */
  async handleMessage(message: AokanaWindowMessage): Promise<boolean> {
    if (typeof message.target !== 'number' || !this.ownedTargets.has(message.target)) return false;
    const record = this.records.find((record) => record.window?.target === message.target);
    const wParam = Number(BigInt(message.wParam) & 0xffffffffn) >>> 0;
    const required = (): ChildRecord => {
      if (record === undefined)
        throw new Error('Aokana child WndProc dereferences a missing native window record');
      return record;
    };
    if (message.message === 2) {
      const value = required();
      value.bitmap.storage?.release();
      this.orphaned.push({...value});
      Object.assign(value, empty());
    } else if (message.message === 0xf) this.present(required());
    else if (message.message === 0x10) this.closeWindow(required());
    else if (message.message === 0x100 || message.message === 0x101) {
      if (
        message.message === 0x100 &&
        BigInt(message.wParam) === 0x43n &&
        (this.messages.input.asynchronousKeyState(0x11) & 0x8000) !== 0
      ) {
        const clipboard = required().clipboard;
        if (clipboard !== null)
          await writeAokanaClipboard(
            this.navigator,
            this.text.decodeAuto({bytes: clipboard, offset: 0}),
          );
      } else if (this.messages.hasTarget('main')) this.messages.post({...message, target: 'main'});
    } else if (message.message === 0x114 || message.message === 0x115) {
      const value = required();
      value.scroll.notify(message.message === 0x114 ? 0 : 1, wParam);
      for (const bar of value.window?.bars ?? []) bar.update();
    } else if (message.message === 0x20a) required().scroll.wheel(wParam);
    return true;
  }
}
