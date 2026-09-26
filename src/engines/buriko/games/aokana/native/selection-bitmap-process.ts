import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {push32, type AokanaBpThread} from '../bp/state.js';
import type {AokanaBitmap, AokanaBitmapRectangle} from './bitmap.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaVirtualDisplayObject} from './display-virtual.js';
import type {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaNativeNotifications} from './notification-queue.js';
import {
  AokanaProcedure,
  type AokanaProcedureState,
  type AokanaWindowMessages,
} from './procedure.js';
import type {AokanaBitmapSelectionState} from './selection-bitmap-state.js';
import type {AokanaBpProcessMessage} from './types.js';

function read(source: AokanaBpPointer | null, offset: number): number {
  if (source === null) throw new Error('Aokana bitmap selection dereferences null records');
  return pointerView({bytes: source.bytes, offset: source.offset + offset}, 4).getInt32(0, true);
}
/** C4F50 maps already-collected input bits independently from ConsumeKey. */
function keyBit(key: number, bits: number): number {
  const shifts: Record<number, number> = {
    1: 0,
    2: 1,
    4: 2,
    5: 4,
    6: 5,
    9: 30,
    14: 6,
    15: 7,
    37: 14,
    38: 12,
    39: 15,
    40: 13,
    48: 25,
    96: 25,
    193: 8,
    194: 9,
  };
  const shift =
    key >= 49 && key <= 57 ? key - 49 + 16 : key >= 97 && key <= 105 ? key - 97 + 16 : shifts[key];
  return shift === undefined ? 0 : (bits >>> shift) & 1;
}

/** 07C3B0/07BBD0 CProcSelectIcon: actual Window children, captures and VM completion. */
export class AokanaBitmapSelectionProcess extends AokanaProcedure {
  protected count = 0;
  protected records: number[][] = [];
  protected children: AokanaVirtualDisplayObject[] = [];
  protected selected = -1;
  protected dirty = false;
  protected pointerEligible = false;
  private keyCapture = false;
  private keyCodes: number[] | null = null;
  private cancelEnabled = 0;
  private inputBits = 0;
  private requested = false;
  private relativeX: number | undefined;
  private relativeY: number | undefined;

  constructor(
    thread: AokanaBpThread,
    shared: AokanaProcedureState,
    clock: AokanaNativeClock,
    protected readonly window: AokanaWindowDisplayObject,
    protected readonly input: AokanaNativeInput,
    private readonly waits: AokanaWindowMessages,
    private readonly notifications: AokanaNativeNotifications,
    private readonly settings: AokanaBitmapSelectionState,
    private readonly captureMode: number,
  ) {
    super(thread, shared, clock);
    window.setTextTransparency(0);
    window.setTextEnabled(1);
    window.composeAll();
    window.disableOverlays();
    waits.register(thread, 0x200);
    if (captureMode !== 0) {
      if (captureMode === 3) {
        input.installPointerCapture(window.sortKey());
        input.installKeyCapture(window.sortKey());
        this.keyCapture = true;
        shared.registerPointerPriority(this.id, window.sortKey());
      } else input.installObjectCapture(window.sortKey(), [0, 0, 0, 0], window);
    }
  }
  setCancelEnabled(value: number): void {
    this.cancelEnabled = value | 0;
  }
  configureKeys(source: AokanaBpPointer): void {
    const keys: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const key = read(source, i * 4);
      keys.push(key);
      this.input.consumeKey(key);
    }
    if (!this.keyCapture) {
      this.input.installKeyCapture(this.window.sortKey());
      this.keyCapture = true;
    }
    this.keyCodes = keys;
  }
  protected clearChildren(): void {
    for (const child of this.children) {
      this.input.releaseObjectCapture(child);
      this.window.removeChild(child);
      child.dispose();
    }
    this.children = [];
    this.count = 0;
  }
  protected copyRecord(source: AokanaBpPointer | null, index: number): void {
    this.records[index] = Array.from({length: 4}, (_, i) => read(source, index * 16 + i * 4));
  }
  protected sourceId(source: AokanaBpPointer | null, index: number): number {
    return read(source, index * 16 + 8);
  }
  protected configureMask(
    child: AokanaVirtualDisplayObject,
    bitmap: AokanaBitmap,
    _source: AokanaBpPointer | null,
    _index: number,
  ): void {
    child.setHitMask(bitmap);
  }
  protected record(index: number, word: number): number {
    const value = this.records[index]?.[word];
    if (value === undefined) throw new Error('Aokana bitmap selection consumes unwritten record');
    return value;
  }
  initialize(count: number, source: AokanaBpPointer | null, hitMask: number): number {
    this.clearChildren();
    if ((count - 1) >>> 0 >= 64) return 0x80000001;
    this.count = count;
    this.window.clearText();
    const inset = this.window.getTextRectangle(),
      area = {...inset};
    for (let i = 0; i < count; i++) {
      const bitmap = this.window.windowState.manager.surfaces.snapshot(this.sourceId(source, i));
      if (bitmap === null) return 0x80000002;
      this.copyRecord(source, i);
      const x = (inset.left + this.record(i, 0)) | 0,
        y = (inset.top + this.record(i, 1)) | 0;
      this.window.drawTextBitmap(area, x, y, bitmap, 0, 0);
      const child = new AokanaVirtualDisplayObject(this.window.environment, 0, this.window);
      this.children[i] = child;
      child.setUnbackedDimensions(bitmap.width, bitmap.height);
      child.setActivation(this.window.inputActive());
      const offset = this.window.getOffset();
      child.setOffset(offset.x, offset.y);
      const secondary = this.window.getSecondaryOffset();
      child.setSecondaryOffset(secondary.x, secondary.y);
      child.usesGlobalOrigin = this.window.usesGlobalOrigin;
      this.window.addChild(child, x, y);
      if (hitMask !== 0) this.configureMask(child, bitmap, source, i);
      this.input.installObjectCapture(child.sortKey(), [0, 0, 0, 0], child);
    }
    const position = this.window.position();
    this.window.move(position.x, position.y);
    const pointerKey = this.window.sortKey(),
      key = this.window.sortKey();
    this.input.collect(key, pointerKey);
    this.input.collect(0, this.child(0).sortKey());
    this.damage(this.window.textBitmapRectangle());
    this.renderSelection(this.hit());
    this.dirty = true;
    return 0;
  }
  private child(index: number): AokanaVirtualDisplayObject {
    const child = this.children[index];
    if (child === undefined)
      throw new Error('Aokana bitmap selection dereferences unwritten child');
    return child;
  }
  protected damage(area: AokanaBitmapRectangle): void {
    this.window.environment.damage.record(this.window.sortKey(), area);
  }
  protected renderSelection(next: number): void {
    const inset = this.window.getTextRectangle(),
      area = {...inset},
      surfaces = this.window.windowState.manager.surfaces;
    if (this.selected !== -1) {
      const highlight = surfaces.snapshot(this.record(this.selected, 3));
      if (highlight !== null) {
        const x = (inset.left + this.record(this.selected, 0)) | 0,
          y = (inset.top + this.record(this.selected, 1)) | 0;
        this.window.drawTextBitmap(area, x, y, highlight, 0x40, 1);
        this.damage(area);
        const base = surfaces.snapshot(this.record(this.selected, 2));
        if (base !== null) {
          this.window.drawTextBitmap(area, x, y, base, 0, 0);
          this.damage(area);
        }
      }
    }
    if (next !== -1) {
      const highlight = surfaces.snapshot(this.record(next, 3));
      if (highlight !== null) {
        const base = surfaces.snapshot(this.record(next, 2));
        if (base !== null) {
          const x = (inset.left + this.record(next, 0)) | 0,
            y = (inset.top + this.record(next, 1)) | 0;
          this.window.drawTextBitmap(area, x, y, base, 0x40, 1);
          this.damage(area);
          this.window.drawTextBitmap(area, x, y, highlight, 0, 0);
          this.damage(area);
        }
      }
    }
    this.selected = next;
  }
  private hit(): number {
    if (!this.pointerEligible) return -1;
    const [x, y] = this.input.pointerPosition();
    for (let i = 0; i < this.count; i++) {
      const child = this.child(i),
        rectangle = child.inputRectangle(0);
      if (x < rectangle.left || x > rectangle.right || y < rectangle.top || y > rectangle.bottom)
        continue;
      const dx = (x - rectangle.left) | 0,
        dy = (y - rectangle.top) | 0;
      if (child.inputHitTest(dx, dy, 1) === 0) continue;
      this.relativeY = dy;
      this.relativeX = dx;
      return i;
    }
    return -1;
  }
  private keys(): number {
    if (!this.input.keyCaptureAllowed(this.window.sortKey())) return 0;
    for (let i = 0; i < this.count; i++) {
      const key = this.keyCodes?.[i];
      if (key === undefined) throw new Error('Aokana bitmap selection consumes unwritten key');
      if (this.input.consumeKey(key) === 0 && keyBit(key, this.inputBits) === 0) continue;
      this.renderSelection(i);
      this.relativeX = this.relativeY = 0;
      this.dirty = true;
      return 1;
    }
    return 0;
  }
  private advance(): number {
    if ((this.inputBits & 0x202) !== 0) {
      this.renderSelection(-1);
      this.dirty = true;
      return 1;
    }
    const next = this.hit();
    if (next !== this.selected) {
      const payload = (next & 0xffff) | (next !== -1 && this.record(next, 3) !== -1 ? 0x10000 : 0);
      this.notifications.push(0x20000001, this.thread.id, payload);
      this.renderSelection(next);
      this.dirty = true;
    }
    return Number((this.inputBits & 1) !== 0 && this.selected !== -1);
  }
  protected override handleMessage(message: AokanaBpProcessMessage): void {
    if (message.code !== 0x200) return;
    this.requested = true;
    const index = message.value1 | 0;
    if (index >= 0 && index < this.count) {
      this.selected = index;
      this.relativeX = this.relativeY = 0;
    } else this.selected = -1;
  }
  poll(): number {
    this.consumeMessages();
    let bits = 0;
    if (this.captureMode !== 0) {
      const pointerKey = this.window.sortKey(),
        key = this.window.sortKey();
      bits = this.input.collect(key, pointerKey) & 0x7fffffff;
    }
    bits |= this.input.collect(0, this.child(0).sortKey()) & 0x7fffffff;
    this.inputBits = this.cancelEnabled === 0 ? bits & 0xfffffdfd : bits;
    const message = this.waits.consume(this.thread, 0x200);
    if (message === null)
      throw new Error('Aokana bitmap selection consumes unwritten window-message result');
    let finished = Number(this.requested);
    if (finished === 0) {
      if (this.keyCodes !== null) finished = this.keys();
      const previous = this.pointerEligible;
      this.pointerEligible =
        this.shared.pointerPriorityAllowed(this.window.sortKey()) &&
        (this.settings.foregroundOnly === 0 || this.input.foreground);
      if (
        finished === 0 &&
        (this.inputBits !== 0 || message.received || previous !== this.pointerEligible)
      )
        finished = this.advance();
    }
    const manager = this.window.windowState.manager;
    if (this.dirty && manager.redraw.automaticEnabled !== 0) {
      manager.redraw.request(manager.redraw.automaticMode !== 0 ? 1 : 0);
      this.dirty = false;
    }
    if (finished === 0 && this.canRun()) return 0;
    if (this.relativeX === undefined)
      throw new Error('Aokana bitmap selection consumes unwritten relative X');
    push32(this.thread, this.relativeX);
    if (this.relativeY === undefined)
      throw new Error('Aokana bitmap selection consumes unwritten relative Y');
    push32(this.thread, this.relativeY);
    push32(this.thread, this.canRun() ? this.selected : -1);
    return 1;
  }
  override dispose(): void {
    if (this.captureMode !== 0) {
      if (this.captureMode === 3) this.input.releasePointerCapture(this.window.sortKey());
      else this.input.releaseObjectCapture(this.window);
    }
    if (this.keyCapture) this.input.releaseKeyCapture(this.window.sortKey());
    this.waits.unregister(this.thread, 0x200);
    this.clearChildren();
    super.dispose();
  }
}

/** 07C990 CProcSelectIconEx; extension is native contiguous sparse4096-byte storage. */
export class AokanaExtendedBitmapSelectionProcess extends AokanaBitmapSelectionProcess {
  private readonly extended: (number | undefined)[] = Array(1024);
  protected override sourceId(source: AokanaBpPointer | null, index: number): number {
    return read(source, index * 64 + 8);
  }
  protected override copyRecord(source: AokanaBpPointer | null, index: number): void {
    const x = read(source, index * 64),
      y = read(source, index * 64 + 4),
      base = read(source, index * 64 + 8);
    this.records[index] = [x, y, base, base];
    for (let word = 0; word < 16; word++)
      this.extended[index * 16 + word] = read(source, index * 64 + word * 4);
  }
  protected override configureMask(
    child: AokanaVirtualDisplayObject,
    bitmap: AokanaBitmap,
    source: AokanaBpPointer | null,
    index: number,
  ): void {
    const id = read(source, index * 64 + 60);
    const mask = id === -1 ? bitmap : this.window.windowState.manager.surfaces.snapshot(id);
    if (mask !== null) child.setHitMask(mask);
  }
  private word(index: number): number {
    const value = this.extended[index];
    if (value === undefined)
      throw new Error('Aokana extended bitmap selection consumes unwritten contiguous record');
    return value;
  }
  protected override renderSelection(next: number): void {
    let area: AokanaBitmapRectangle | undefined;
    for (let i = 0; i < 8; i++) {
      const prior = this.window.overlayRectangle(i);
      if (prior !== null) {
        area = prior;
        this.damage(area);
      }
    }
    if (next === -1) this.window.disableOverlays();
    else
      for (let i = 0; i < 8; i++) {
        const at = next * 16 + 3 + i * 3,
          bitmap = this.window.windowState.manager.surfaces.snapshot(this.word(at + 2));
        if (bitmap === null) this.window.setOverlayEnabled(i, 0);
        else {
          const inset = this.window.getTextRectangle();
          this.window.setOverlayBitmap(i, bitmap);
          const y = (inset.top + this.word(at + 1)) | 0,
            x = (inset.left + this.word(at)) | 0;
          this.window.setOverlayPosition(i, x, y, 0);
          this.window.setOverlayEnabled(i, 1);
          const written = this.window.overlayRectangle(i);
          if (written !== null) area = written;
          if (area === undefined)
            throw new Error(
              'Aokana extended bitmap selection consumes unwritten overlay rectangle',
            );
          this.damage(area);
        }
      }
    this.selected = next;
  }
}
