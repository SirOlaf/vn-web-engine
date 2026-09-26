import type {AokanaBitmapRectangle} from './bitmap.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaCursorPolicy} from './cursor-policy.js';
import {AokanaVirtualDisplayObject} from './display-virtual.js';
import type {AokanaWindowDisplayObject} from './display-window.js';
import {
  AokanaIconWords,
  type AokanaIconDescription,
  type AokanaIconRow,
} from './icon-description.js';
import {
  AokanaIndependentProcedure,
  type AokanaIndependentProcedures,
} from './independent-procedure.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaProcedureState} from './procedure.js';

const bits = [
  1, 2, 4, 16, 32, 64, 128, 256, 512, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288,
  1048576, 2097152, 4194304, 8388608, 16777216, 33554432, 1073741824,
];
const literalMaps = [
  [1, 2, 0, 0, 0, 0, 0, 3, 4, 7, 8, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19],
  [1, 2, 0, 0, 0, 0, 0, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19],
  [1, 2, 0, 0, 0, 0, 0, 3, 4, 11, 12, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19],
  [1, 2, 0, 0, 0, 0, 0, 3, 4, 9, 10, 11, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19],
];
/** 091530/091400: actual once-initialized maps and the Icon foreground default. */
export class AokanaIndependentIconState {
  foregroundOnly = 0;
  private initialized = false;
  readonly maps: number[][] = [];
  initialize(): void {
    if (this.initialized) return;
    for (let i = 0; i < 4; i++) this.maps.push(Array<number>(24).fill(0));
    this.initialized = true;
  }
  setMap(mode: number, read: (index: number) => number): boolean {
    this.initialize();
    if ((mode - 4) >>> 0 >= 4) return false;
    for (let i = 0; i < 24; i++) this.maps[mode - 4]![i] = read(i) | 0;
    return true;
  }
  map(mode: number): readonly number[] {
    this.initialize();
    return mode < 4 ? literalMaps[mode]! : this.maps[mode - 4]!;
  }
}
interface FlatIcon {
  present: boolean;
  row: number;
  column: number;
  data: AokanaIconWords;
  child: AokanaVirtualDisplayObject | null;
}
const rectangle = (): AokanaBitmapRectangle => ({left: 0, top: 0, right: 0, bottom: 0});
function prepare(window: AokanaWindowDisplayObject): void {
  window.disableOverlays();
  window.configureInnerObjects(0);
  window.clearText();
  window.setTextTransparency(0);
  window.setTextEnabled(1);
  window.composeAll();
}
/** 090AB0 draws copied descriptions without publishing an independent controller. */
export function drawAokanaIconDescription(
  window: AokanaWindowDisplayObject,
  description: AokanaIconDescription,
): number {
  prepare(window);
  let status = 0x80000001;
  const n = description.header.read(0);
  if ((n - 1) >>> 0 < 256) {
    const inset = window.getTextRectangle();
    status = 0;
    for (const row of description.rows)
      if (((row.data.read(0) & 0xffff) - 1) >>> 0 >= 1024) status = 0x80000002;
    if (status === 0)
      for (const row of description.rows)
        for (let column = 0; column < (row.data.read(0) & 0xffff); column++) {
          const icon = row.icons[column]!;
          if (icon.read(0) === 0) continue;
          let id = icon.read(3);
          if (id !== -1 && column === row.data.read(4) && icon.read(4) !== -1) id = icon.read(4);
          const bitmap = window.windowState.manager.surfaces.snapshot(id);
          if (bitmap !== null)
            window.drawTextBitmap(
              rectangle(),
              (inset.left + icon.read(1)) | 0,
              (inset.top + icon.read(2)) | 0,
              bitmap,
              0,
              0,
            );
        }
  }
  window.environment.damage.record(window.sortKey(), window.textBitmapRectangle());
  return status;
}
/** Concrete DCIPIcon, 091610 and vtable17ECE0. No timer-based behavior is invented for its empty tick. */
export class AokanaIndependentIcon extends AokanaIndependentProcedure {
  readonly type: number = 0;
  protected readonly helper: AokanaVirtualDisplayObject;
  protected running = 0;
  protected rows: AokanaIconRow[] = [];
  protected flat: FlatIcon[] = [];
  protected grid: readonly [number, number][] = [];
  protected currentRow = -1;
  protected modal = 0;
  protected captureParent = 0;
  protected ignoredBits = 0;
  protected actionMap = 0;
  protected selectOnClick = 0;
  protected resultRow: number | undefined;
  protected resultColumn: number | undefined;
  protected resultFlag: number | undefined;
  protected relative: readonly [number, number] | undefined;
  protected hover = -1;
  protected pointerPrevious: readonly [number, number] | undefined;
  protected unmaskedHover: number | undefined;
  protected pressedHover: number | undefined;
  protected inputEnabled = 1;
  protected inputBits: number | undefined;
  protected pressed = -1;
  private readonly notifications: Uint32Array[] = [];
  constructor(
    shared: AokanaIndependentProcedures,
    readonly window: AokanaWindowDisplayObject,
    protected readonly input: AokanaNativeInput,
    protected readonly priorities: AokanaProcedureState,
    protected readonly clock: AokanaNativeClock,
    protected readonly cursor: AokanaCursorPolicy,
    protected readonly settings: AokanaIndependentIconState,
  ) {
    super(shared, window);
    settings.initialize();
    this.helper = this.createChild(0, 0, 0, 0, 0, false);
  }
  protected createChild(
    order: number,
    width: number,
    height: number,
    x: number,
    y: number,
    activate: boolean,
  ): AokanaVirtualDisplayObject {
    const child = new AokanaVirtualDisplayObject(this.window.environment, order, this.window);
    child.setUnbackedDimensions(width, height);
    if (activate) child.setActivation(this.window.inputActive());
    const offset = this.window.getOffset();
    child.setOffset(offset.x, offset.y);
    const secondary = this.window.getSecondaryOffset();
    child.setSecondaryOffset(secondary.x, secondary.y);
    child.usesGlobalOrigin = this.window.usesGlobalOrigin;
    this.window.addChild(child, x, y);
    return child;
  }
  protected mark(): void {
    this.dirty = 1;
  }
  protected damage(r: AokanaBitmapRectangle): void {
    this.window.environment.damage.record(this.window.sortKey(), r);
  }
  protected tick(_elapsed: bigint): void {}
  protected hoverChanged(packed: number, alternate: number): void {
    this.notify(0x10000002, packed, alternate);
  }
  protected finishSelection(): number {
    return 1;
  }
  protected clickOutside(): void {}
  protected selectable(_row: number, _column: number): number {
    return 1;
  }
  protected clickImmediate(_index: number): number {
    return 1;
  }
  protected flatIndex(index: number): number {
    return index >= 0 && index < this.flat.length ? index : -1;
  }
  protected notify(code: number, first: number, second: number): void {
    this.notifications.push(Uint32Array.of(code, first, second));
  }
  consumeNotification(write: (words: Uint32Array) => void): void {
    const first = this.notifications[0];
    write(first ?? new Uint32Array(3));
    if (first !== undefined) this.notifications.shift();
  }
  writeSelectedColumns(write: (index: number, value: number) => void): void {
    for (let i = 0; i < this.rows.length; i++) write(i, this.rows[i]!.data.read(4));
  }
  selectedRow(): number {
    return this.currentRow;
  }
  private defined(value: number | undefined): number {
    if (value === undefined) throw new Error('Aokana Icon consumes uninitialized controller state');
    return value;
  }
  protected row(index: number): AokanaIconRow {
    const row = this.rows[index];
    if (row === undefined) throw new Error('Aokana Icon indexes outside its native row array');
    return row;
  }
  protected item(index: number): FlatIcon {
    const item = this.flat[index];
    if (item === undefined)
      throw new Error('Aokana Icon indexes outside its native flattened array');
    return item;
  }
  protected valid(row: number, column: number): number {
    return Number(
      row >= 0 && row < this.rows.length && column >= 0 && column < this.row(row).data.read(0),
    );
  }
  protected childFor(row: number, column: number): AokanaVirtualDisplayObject | null {
    return this.flat.find((x) => x.present && x.row === row && x.column === column)?.child ?? null;
  }
  protected pointerRepeat(token: number): number {
    if (!this.input.pointerCaptureAllowed(token)) return 0;
    let result = 0;
    for (const [key, mask] of [
      [1, 1],
      [2, 2],
      [4, 4],
      [5, 16],
      [6, 32],
    ])
      if (this.input.repeatReady(key!)) result |= mask!;
    return result;
  }
  protected installObject(object: AokanaVirtualDisplayObject | AokanaWindowDisplayObject): void {
    this.input.installObjectCapture(object.sortKey(), [0, 0, 0, 0], object);
  }
  initialize(description: AokanaIconDescription): number {
    this.reset();
    prepare(this.window);
    let status = 0x80000001;
    const n = description.header.read(0);
    if ((n - 1) >>> 0 < 256) {
      const inset = this.window.getTextRectangle();
      const grid: [number, number][] = [];
      let total = 0;
      for (const row of description.rows) {
        const packed = row.data.read(0) >>> 0,
          count = packed & 0xffff,
          high = packed >>> 16;
        const width = high !== 0 && high <= count ? high : count;
        if (width === 0) throw new Error('Aokana Icon grid divides by zero native width');
        grid.push([width, Math.trunc((width - 1 + count) / width)]);
        row.data.write(0, count);
        total = (total + count) | 0;
        if ((count - 1) >>> 0 >= 1024) {
          status = 0x80000002;
          this.damage(this.window.textBitmapRectangle());
          this.mark();
          return status;
        }
      }
      this.grid = grid;
      this.currentRow = description.header.read(4);
      if (this.currentRow < 0 || this.currentRow >= n) this.currentRow = -1;
      this.modal = description.header.read(5);
      this.captureParent = description.header.read(6);
      this.ignoredBits = description.header.read(7);
      this.actionMap = description.header.read(8) & 7;
      this.selectOnClick = description.header.read(9);
      this.rows = [];
      this.flat = [];
      for (let r = 0; r < n; r++) {
        const original = description.rows[r]!,
          data = original.data.clone();
        let selected = data.read(4);
        if (selected < 0 || selected >= data.read(0)) selected = -1;
        data.write(4, selected);
        const row: AokanaIconRow = {data, icons: []};
        this.rows.push(row);
        for (let c = 0; c < data.read(0); c++) {
          const icon = original.icons[c]!;
          if (c === data.read(4) && icon.read(0) === 0) data.write(4, -1);
          let id = icon.read(3);
          if (id !== -1 && c === data.read(4) && icon.read(4) !== -1) id = icon.read(4);
          const bitmap = icon.read(0) === 0 ? null : this.shared.surfaces.snapshot(id);
          const copied = bitmap === null ? new AokanaIconWords(Array(18)) : icon.clone();
          const entry: FlatIcon = {
            present: bitmap !== null,
            row: r,
            column: c,
            data: copied,
            child: null,
          };
          this.flat.push(entry);
          row.icons.push(copied);
          if (bitmap === null) {
            for (const [i, v] of [
              [1, 0],
              [2, 0],
              [3, -1],
              [4, -1],
              [5, -1],
              [6, -1],
              [7, 0],
              [8, 0],
              [9, -1],
              [10, 0],
              [11, 0],
              [12, -1],
              [16, 0],
            ])
              copied.write(i!, v!);
          } else {
            const x = (inset.left + icon.read(1)) | 0,
              y = (inset.top + icon.read(2)) | 0;
            this.window.drawTextBitmap(rectangle(), x, y, bitmap, 0, 0);
            const child = this.createChild(
              this.flat.length - 1,
              bitmap.width,
              bitmap.height,
              x,
              y,
              true,
            );
            entry.child = child;
            if (icon.read(6) === -2) {
              child.setHitMask(null);
              child.hitEnabled = 0;
            } else {
              const mask = this.shared.surfaces.snapshot(icon.read(6));
              if (mask !== null) child.setHitMask(mask);
            }
            this.installObject(child);
            if (icon.read(16) !== 0) this.input.consumeKey(icon.read(16) & 0x7fffffff);
          }
        }
      }
      if (this.flat.length !== total)
        throw new Error('Aokana Icon native flattened allocation differs from row traversal');
      const point = this.window.position();
      this.window.move(point.x, point.y);
      if (this.modal !== 0) {
        this.input.installPointerCapture(this.window.sortKey());
        this.input.installKeyCapture(this.window.sortKey());
        const key = this.window.sortKey();
        this.priorities.registerPointerPriority(this.id | 0x80000000, key);
        this.selectRow(this.currentRow);
      } else if (this.captureParent !== 0) this.installObject(this.window);
      const pointerKey = this.window.sortKey(),
        key = this.window.sortKey();
      this.input.collect(key, pointerKey);
      this.input.collect(0, this.helper.sortKey());
      if (this.setHover(this.readHover(), 1) !== 0) this.publishHover();
      const initial = description.header.read(4);
      this.pointerPrevious =
        initial === -1 || description.rows[initial]!.data.read(4) === -1
          ? [0x7fffffff, 0x7fffffff]
          : this.input.pointerPosition();
      this.unmaskedHover = this.hit(null, 0, 0);
      this.pressedHover = -1;
      this.running = 1;
      status = 0;
    }
    this.damage(this.window.textBitmapRectangle());
    this.mark();
    return status;
  }
  protected publishHover(): void {
    if (this.hover === -1) this.hoverChanged(-1, 0);
    else {
      const e = this.item(this.hover);
      this.hoverChanged((e.row << 16) | e.column, Number(e.data.read(5) !== -1));
    }
  }
  /** 08F3C0's negative indices are not normalized into valid array indices. */
  protected bitmapFor(
    row: number,
    column: number,
    hovered: number,
    selected: number,
  ): number | undefined {
    if (row >= this.rows.length) return undefined;
    const r = this.row(row);
    if (column >= r.data.read(0)) return undefined;
    const i = r.icons[column];
    if (i === undefined) throw new Error('Aokana Icon reads a negative native icon index');
    let id = i.read(3);
    if (hovered !== 0 && i.read(5) !== -1) id = i.read(5);
    if (selected !== 0 && column === r.data.read(4) && i.read(4) !== -1) id = i.read(4);
    return id;
  }
  protected redrawIcon(
    icon: AokanaIconWords,
    next: number | undefined,
    old: number | undefined,
  ): number {
    if (next === undefined || old === undefined)
      throw new Error('Aokana Icon consumes unwritten bitmap selection scratch');
    const fresh = this.shared.surfaces.snapshot(next);
    if (fresh === null) return 0;
    const previous = this.shared.surfaces.snapshot(old);
    if (previous === null) return 0;
    const damage = this.window.getTextRectangle(),
      x = (damage.left + icon.read(1)) | 0,
      y = (damage.top + icon.read(2)) | 0;
    this.window.drawTextBitmap(damage, x, y, previous, 0x40, 1);
    this.damage(damage);
    this.window.drawTextBitmap(damage, x, y, fresh, 0, 0);
    this.damage(damage);
    this.mark();
    return 1;
  }
  protected clearOtherRows(row: number): number {
    if (row < 0 || row >= this.rows.length) return 0;
    const r = this.row(row);
    if (r.data.read(4) === -1) return 1;
    const group = r.data.read(8);
    if (group !== -1)
      for (let i = 0; i < this.rows.length; i++)
        if (i !== row && this.row(i).data.read(8) === group) this.selectColumn(i, -1);
    return 1;
  }
  protected selectRow(row: number): number {
    if (row < 0 || row >= this.rows.length) return 0;
    const data = this.row(row).data;
    if (data.read(5) === 0) return 0;
    this.updateOverlays(data, 9, 0);
    this.currentRow = row;
    this.clearOtherRows(row);
    return 1;
  }
  protected updateOverlays(data: AokanaIconWords, firstWord: number, firstLayer: number): void {
    const inset = this.window.getTextRectangle();
    for (let i = 0; i < 2; i++) {
      const old = this.window.overlayRectangle(firstLayer + i);
      if (old !== null) {
        this.damage(old);
        this.mark();
      }
    }
    for (let i = 0; i < 2; i++) {
      const at = firstWord + i * 3,
        id = data.read(at + 2),
        bitmap = this.shared.surfaces.snapshot(id),
        layer = firstLayer + i;
      if (bitmap === null) this.window.setOverlayEnabled(layer, 0);
      else {
        this.window.setOverlayBitmap(layer, bitmap);
        this.window.setOverlayPosition(
          layer,
          (inset.left + data.read(at)) | 0,
          (inset.top + data.read(at + 1)) | 0,
          0,
        );
        this.window.setOverlayEnabled(layer, 1);
        const area = this.window.overlayRectangle(layer);
        if (area === null) throw new Error('Aokana Icon consumes unpublished overlay rectangle');
        this.damage(area);
      }
      this.mark();
    }
  }
  protected setHover(index: number, force: number): number {
    if (index === this.hover && force === 0) return 0;
    const inset = this.window.getTextRectangle();
    // 08F430 records old overlays before replacing the prior icon bitmap.
    for (let i = 2; i < 4; i++) {
      const old = this.window.overlayRectangle(i);
      if (old !== null) {
        this.damage(old);
        this.mark();
      }
    }
    if (this.hover !== -1) {
      const e = this.item(this.hover);
      this.redrawIcon(
        e.data,
        this.bitmapFor(e.row, e.column, 0, 1),
        this.bitmapFor(e.row, e.column, 1, 1),
      );
    }
    if (index === -1) {
      this.window.setOverlayEnabled(2, 0);
      this.window.setOverlayEnabled(3, 0);
      this.mark();
    } else {
      const e = this.item(index);
      this.redrawIcon(
        e.data,
        this.bitmapFor(e.row, e.column, 1, 1),
        this.bitmapFor(e.row, e.column, 0, 1),
      );
      for (let i = 0; i < 2; i++) {
        const at = 7 + i * 3,
          layer = 2 + i,
          bitmap = this.shared.surfaces.snapshot(e.data.read(at + 2));
        if (bitmap === null) this.window.setOverlayEnabled(layer, 0);
        else {
          this.window.setOverlayBitmap(layer, bitmap);
          this.window.setOverlayPosition(
            layer,
            (inset.left + e.data.read(at)) | 0,
            (inset.top + e.data.read(at + 1)) | 0,
            0,
          );
          this.window.setOverlayEnabled(layer, 1);
          const area = this.window.overlayRectangle(layer);
          if (area === null) throw new Error('Aokana Icon consumes unpublished hover rectangle');
          this.damage(area);
        }
        this.mark();
      }
    }
    this.hover = index;
    return 1;
  }
  protected selectColumn(row: number, column: number): number {
    if (row < 0 || row >= this.rows.length) return 0;
    const r = this.row(row),
      old = r.data.read(4);
    if (((column < 0 || column >= r.data.read(0)) && column !== -1) || column === old) return 0;
    const hovering = this.hover === -1 ? null : this.item(this.hover);
    if (old !== -1) {
      const h = Number(hovering?.row === row && hovering.column === old);
      this.redrawIcon(
        r.icons[old]!,
        this.bitmapFor(row, old, h, 0),
        this.bitmapFor(row, old, h, 1),
      );
    }
    r.data.write(4, column);
    if (column !== -1) {
      if (r.icons[column]!.read(3) === -1) return 0;
      const h = Number(hovering?.row === row && hovering.column === column);
      this.redrawIcon(
        r.icons[column]!,
        this.bitmapFor(row, column, h, 1),
        this.bitmapFor(row, column, h, 0),
      );
      this.clearOtherRows(row);
    }
    return 1;
  }
  protected setResult(row: number, column: number, flag: number): number {
    if (row !== -1 && (row < 0 || row >= this.rows.length)) return 0;
    if (column !== -1 && (column < 0 || column >= this.row(row).data.read(0))) return 0;
    this.resultRow = row;
    this.resultColumn = column;
    this.resultFlag = flag;
    return 1;
  }
  protected setFlatResult(index: number, flag: number): number {
    if (index !== -1 && (index < 0 || index >= this.flat.length)) return 0;
    if (index === -1) {
      this.resultRow = this.resultColumn = -1;
    } else {
      const e = this.item(index);
      this.resultRow = e.row;
      this.resultColumn = e.column;
    }
    this.resultFlag = flag;
    return 1;
  }
  writeResult(write: (index: number, value: number) => void): void {
    // 090A20 reads these three words even before a selection writes them. The
    // native constructor leaves them in readable operator_new storage.
    const row = this.resultRow ?? 0,
      column = this.resultColumn ?? 0,
      flag = this.resultFlag ?? 0;
    let point: readonly [number, number] = [0, 0];
    if (flag !== 0) point = this.clickPoint(row, column);
    write(0, this.running);
    write(1, row);
    write(2, column);
    write(3, flag);
    write(4, point[0]);
    write(5, point[1]);
  }
  /** 08E2A0 leaves the caller's initial zero point when no matching rectangle contains it. */
  protected clickPoint(row: number, column: number): readonly [number, number] {
    const child = this.childFor(row, column);
    if (child !== null) {
      const current =
        this.row(row).data.read(7) !== 0 && (this.pointerRepeat(this.helper.sortKey()) & 1) !== 0;
      const p = current ? this.input.pointerPosition() : this.input.clickPosition(0)!;
      const r = child.inputRectangle(0);
      if (p[0] >= r.left && p[0] <= r.right && p[1] >= r.top && p[1] <= r.bottom)
        return [(p[0] - r.left) | 0, (p[1] - r.top) | 0];
    }
    return [0, 0];
  }
  protected replaceBitmap(row: number, column: number, kind: number, value: number): number {
    if (!this.valid(row, column)) return 0;
    const e = this.row(row).icons[column]!,
      h = this.hover === -1 ? null : this.item(this.hover),
      active = Number(h?.row === row && h.column === column),
      old = this.bitmapFor(row, column, active, 1);
    const field = kind === 0 ? 3 : kind === 1 ? 5 : kind === 2 ? 4 : -1;
    if (field !== -1) e.write(field, value);
    else if (kind === 4) {
      e.write(6, value);
      const child = this.childFor(row, column);
      if (child === null) return 0;
      if (value === -2) {
        child.setHitMask(null);
        child.hitEnabled = 0;
        return 1;
      }
      if (value === -1) {
        child.setHitMask(null);
        return 1;
      }
      const mask = this.shared.surfaces.snapshot(value);
      if (mask === null) return 0;
      child.setHitMask(mask);
      return 1;
    } else return 0;
    this.redrawIcon(e, this.bitmapFor(row, column, active, 1), old);
    return 1;
  }
  protected moveIcon(
    row: number,
    column: number,
    _x: number,
    _y: number,
    _duration: number,
    _extra: number,
  ): number {
    return this.valid(row, column);
  }
  protected changeIcon(row: number, column: number, _value: number): number {
    return this.valid(row, column);
  }
  protected configureIcon(row: number, column: number, _first: number, _second: number): number {
    return this.valid(row, column);
  }
  protected override handleMessage(words: Uint32Array): number {
    const a = (i: number) => words[i]! | 0;
    switch (words[0]) {
      case 0x10000000:
        if (words.length !== 3) return 0;
        if (!this.setResult(a(1) >> 16, (a(1) << 16) >> 16, a(2))) return 0;
        if (this.finishSelection() !== 0) this.running = 0;
        return 1;
      case 0x10000001:
        return words.length === 2 ? this.selectRow(a(1)) : 0;
      case 0x10000002:
        return words.length === 3 ? this.selectColumn(a(1), a(2)) : 0;
      case 0x10000003:
        if (words.length !== 2) return 0;
        this.inputEnabled = a(1);
        return 1;
      case 0x10000004:
        return words.length === 5 ? this.replaceBitmap(a(1), a(2), a(3), a(4)) : 0;
      case 0x10000005:
        if (words.length !== 4 || !this.valid(a(1), a(2))) return 0;
        {
          const e = this.row(a(1)).icons[a(2)]!;
          return this.moveIcon(a(1), a(2), e.read(1), e.read(2), a(3), 0);
        }
      case 0x10000006:
        return words.length === 5 ? this.configureIcon(a(1), a(2), a(3), a(4)) : 0;
      case 0x10000007:
        return words.length === 6 ? this.moveIcon(a(1), a(2), a(3), a(4), a(5), 0) : 0;
      case 0x10000008:
        return words.length === 4 ? this.changeIcon(a(1), a(2), a(3)) : 0;
    }
    return 0;
  }
  protected hit(
    output: {point?: readonly [number, number]} | null,
    checkMask: number,
    force: number,
  ): number {
    if (
      this.inputEnabled === 0 ||
      !this.priorities.pointerPriorityAllowed(this.window.sortKey()) ||
      (this.settings.foregroundOnly !== 0 && !this.input.foreground) ||
      (this.cursor.queryVisible() === 0 && force === 0)
    )
      return -1;
    const [x, y] = this.input.pointerPosition();
    for (let i = 0; ; i++) {
      const index = this.flatIndex(i);
      if (index === -1) return -1;
      const e = this.item(index);
      if (!e.present) continue;
      const child = e.child!;
      if (child.value170 === 0 || child.secondaryVisibility === 0) continue;
      const r = child.inputRectangle(0);
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (
        checkMask !== 0 &&
        (this.selectable(e.row, e.column) === 0 ||
          !this.input.pointerCaptureAllowed(child.sortKey()) ||
          child.inputHitTest((x - r.left) | 0, (y - r.top) | 0, 1) === 0)
      )
        continue;
      if (output !== null) output.point = [(x - r.left) | 0, (y - r.top) | 0];
      return index;
    }
  }
  protected readHover(): number {
    this.relative = [-1, -1];
    const result: {point?: readonly [number, number]} = {};
    const index = this.hit(result, 1, 0);
    if (index !== -1) this.relative = result.point!;
    return index;
  }
  private keyFromMask(key: number): boolean {
    let shift = (
      {
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
        193: 8,
        194: 9,
      } as Record<number, number>
    )[key];
    if (key >= 0x30 && key <= 0x39) shift = key === 0x30 ? 25 : key - 0x31 + 16;
    if (key >= 0x60 && key <= 0x69) shift = key === 0x60 ? 25 : key - 0x61 + 16;
    return shift !== undefined && ((this.defined(this.inputBits) >>> shift) & 1) !== 0;
  }
  protected shortcut(): number {
    if (this.modal === 0 || !this.priorities.pointerPriorityAllowed(this.window.sortKey()))
      return -1;
    for (let i = 0; i < this.flat.length; i++) {
      const e = this.item(i);
      if (!this.input.keyCaptureAllowed(this.window.sortKey()) || !e.present) continue;
      const raw = e.data.read(16),
        key = raw & 0x7fffffff;
      if (key === 0) continue;
      const repeat = raw < 0 ? this.input.repeatReady(key) : false;
      if (this.input.consumeKey(key) !== 0 || this.keyFromMask(key) || repeat) return i;
    }
    return -1;
  }
  override async poll(): Promise<number> {
    const operationAllocator = this.shared.surfaces.allocator,
      operationActor = operationAllocator.currentActor;
    const runAsActor = <T>(operation: () => T): T =>
      operationAllocator.withActor(operationActor, operation);

    await runAsActor(() => this.drainMessages());
    if (this.running === 0) return 0;
    let input = 0;
    if (this.inputEnabled === 0) this.inputBits = 0;
    else {
      if (this.modal !== 0) {
        const pointer = this.window.sortKey(),
          key = this.window.sortKey();
        input = this.input.collect(key, pointer);
      } else if (this.captureParent !== 0) input = this.input.collect(0, this.window.sortKey());
      this.inputBits = (this.input.collect(0, this.helper.sortKey()) | input) >>> 0;
      if (this.modal === 0) this.inputBits &= 0x2c3;
    }
    this.running = Number(runAsActor(() => this.advance()) === 0);
    runAsActor(() => this.flushRedraw());
    return 0;
  }
  protected advance(): number {
    this.tick(this.clock.read());
    let row = this.currentRow,
      selectedRow = row >= 0 && row < this.rows.length ? this.row(row) : null,
      column = selectedRow?.data.read(4) ?? -1;
    if (selectedRow === null) row = -1;
    const unmasked = this.hit(null, 0, 0);
    if (unmasked !== this.unmaskedHover) {
      this.unmaskedHover = unmasked;
      const e = unmasked === -1 ? null : this.item(unmasked);
      this.notify(0x10000001, e?.row ?? -1, e?.column ?? -1);
    }
    if (this.setHover(this.readHover(), 0) !== 0) this.publishHover();
    const relative: {point?: readonly [number, number]} = {};
    const pressedHover = this.hit(relative, 1, 1);
    if (pressedHover !== this.pressedHover) {
      this.pressedHover = pressedHover;
      // 08F990 copies the stack scratch even when 08F790 misses and leaves it unwritten.
      // Preserve that indeterminate value rather than treating a normal miss as fatal.
      this.relative = relative.point;
    }
    if (this.inputEnabled !== 0) {
      if (this.hover !== -1 && this.row(this.item(this.hover).row).data.read(6) !== 0) {
        const p = this.input.pointerPosition();
        if (this.pointerPrevious === undefined)
          throw new Error('Aokana Icon reads unwritten prior pointer');
        if (p[0] !== this.pointerPrevious[0] || p[1] !== this.pointerPrevious[1]) {
          const e = this.item(this.hover);
          this.selectRow(e.row);
          const changed = this.selectColumn(e.row, e.column);
          if (selectedRow !== null) column = selectedRow.data.read(4);
          this.pointerPrevious = p;
          if (changed !== 0) this.notify(0x10000004, (e.row << 16) | e.column, 0);
        }
      }
      if (
        this.inputEnabled !== 0 &&
        this.hover !== -1 &&
        this.row(this.item(this.hover).row).data.read(7) !== 0 &&
        (this.pointerRepeat(this.helper.sortKey()) & 1) !== 0
      )
        this.inputBits = this.defined(this.inputBits) | 1;
    }
    let action = 0;
    const input = this.defined(this.inputBits) & ~this.ignoredBits,
      map = this.settings.map(this.actionMap);
    for (let i = 0; i < 24; i++)
      if ((input & bits[i]!) !== 0) {
        action = map[i]!;
        if (action === 19) action = 8 - Number((this.input.queryKey(16) & 0x8000) !== 0);
        break;
      }
    if (this.pressed !== -1) {
      if (action === 0) {
        if ((this.input.queryKey(1) & 0x8000) === 0) {
          if (this.pressedHover === this.pressed) action = 1;
          else this.pressed = -1;
        }
      } else this.pressed = -1;
    }
    if ((action - 1) >>> 0 > 17) {
      const i = this.shortcut();
      if (i === -1) return 0;
      this.setFlatResult(i, 0);
      return 1;
    }
    const changed = (value: number, direction: number): void =>
      this.notify(0x10000004, (row << 16) | value, direction);
    const blocked = (direction: number): void =>
      this.notify(0x10000005, (row << 16) | (column & 0xffff), direction);
    switch (action) {
      case 1: {
        const index = this.defined(this.pressedHover);
        if (index === -1) {
          this.clickOutside();
          return 0;
        }
        const e = this.item(index);
        if (!this.selectable(e.row, e.column)) return 0;
        if (this.clickImmediate(index) === 0 && this.pressed === -1) {
          this.pressed = index;
          return 0;
        }
        this.setFlatResult(index, 1);
        if (this.selectOnClick !== 0) this.selectColumn(e.row, e.column);
        const done = this.finishSelection();
        if (done === 0) this.selectRow(e.row);
        this.pressed = -1;
        return done;
      }
      case 2:
      case 4:
        this.setFlatResult(-1, action === 2 ? 1 : 0);
        return this.finishSelection();
      case 3:
        if (this.selectable(row, column) !== 0 && row !== -1 && column !== -1) {
          this.setResult(row, column, 0);
          return this.finishSelection();
        }
        return 0;
      case 5:
      case 6:
        if (selectedRow !== null) {
          for (let i = 0; i < selectedRow.data.read(0); i++) {
            const n = selectedRow.data.read(0);
            if (action === 5) {
              const old = column;
              column = (column - 1) | 0;
              if (column < 0 || old > n) column = n - 1;
            } else {
              column = (column + 1) | 0;
              if (column < 0 || column >= n) column = 0;
            }
            if (this.selectColumn(row, column) !== 0) {
              changed(column, action === 5 ? -1 : 1);
              break;
            }
          }
        }
        return 0;
      case 7:
      case 8:
        for (let i = 0; i < this.rows.length; i++) {
          const n = this.rows.length;
          if (action === 7) {
            const old = row;
            row = (row - 1) | 0;
            if (row < 0 || old > n) row = n - 1;
          } else {
            row = (row + 1) | 0;
            if (row < 0 || row >= n) row = 0;
          }
          if (this.selectRow(row) !== 0) {
            this.notify(0x10000003, row, action === 7 ? -1 : 1);
            break;
          }
        }
        return 0;
      case 9:
      case 10:
      case 11:
      case 12:
        if (selectedRow !== null) {
          const [w, h] = this.grid[row]!;
          if (w === 0) throw new Error('Aokana Icon navigation divides by zero');
          const limit = action < 11 ? w : h;
          for (let i = 0; i < limit; i++) {
            const q = Math.trunc(column / w),
              r = column % w;
            if (action === 9) column = (Math.imul(w, q) + (r < 1 ? w : r) - 1) | 0;
            else if (action === 10) column = (column + ((r + 1 < w ? r + 1 : 0) - r)) | 0;
            else if (action === 11) column = (Math.imul((q < 1 ? h : q) - 1, w) + r) | 0;
            else column = (Math.imul(q + 1 < h ? q + 1 : 0, w) + r) | 0;
            if (this.selectColumn(row, column) !== 0) {
              changed(
                column,
                action === 9 ? 0xffff : action === 10 ? 1 : action === 11 ? 0xffff0000 : 0x10000,
              );
              break;
            }
          }
        }
        return 0;
      case 13:
      case 14:
        if (selectedRow !== null) {
          const next = (column + (action === 13 ? -1 : 1)) | 0;
          if ((action === 14 || column > 0) && this.selectColumn(row, next) !== 0)
            changed(next, action === 13 ? -1 : 1);
          else blocked(action === 13 ? -1 : 1);
        }
        return 0;
      case 15:
      case 16:
      case 17:
      case 18:
        if (selectedRow !== null) {
          const [w, h] = this.grid[row]!;
          if (w === 0) throw new Error('Aokana Icon navigation divides by zero');
          const q = Math.trunc(column / w),
            r = column % w,
            vertical = action >= 17,
            back = action === 15 || action === 17,
            direction = vertical ? (back ? 0xffff0000 : 0x10000) : back ? 0xffff : 1;
          let at = (vertical ? q : r) + (back ? -1 : 1);
          const limit = vertical ? h : w;
          while (back ? at >= 0 : at < limit) {
            const next = vertical ? (Math.imul(at, w) + r) | 0 : (Math.imul(w, q) + at) | 0;
            if (this.selectColumn(row, next) !== 0) {
              changed(next, direction);
              return 0;
            }
            at += back ? -1 : 1;
          }
          blocked(direction);
        }
        return 0;
    }
    return 0;
  }
  protected reset(): void {
    this.running = 0;
    const pointer = this.window.sortKey(),
      key = this.window.sortKey();
    this.input.collect(key, pointer);
    this.input.collect(0, this.helper.sortKey());
    for (const e of this.flat)
      if (e.present) {
        this.input.releaseObjectCapture(e.child!);
        this.window.removeChild(e.child!);
        e.child!.dispose();
      }
    if (this.modal !== 0) {
      this.input.releasePointerCapture(this.window.sortKey());
      this.input.releaseKeyCapture(this.window.sortKey());
      this.priorities.releasePointerPriority(this.id | 0x80000000);
    } else if (this.captureParent !== 0) this.input.releaseObjectCapture(this.window);
    this.rows = [];
    this.flat = [];
    this.grid = [];
    this.modal = this.captureParent = this.ignoredBits = this.actionMap = this.selectOnClick = 0;
    this.currentRow = this.hover = -1;
    this.notifications.length = 0;
  }
  override dispose(): void {
    this.check();
    // 0915A0 calls08EA30 directly after any derived destructor reset.
    AokanaIndependentIcon.prototype.reset.call(this);
    this.window.removeChild(this.helper);
    this.helper.dispose();
    this.notifications.length = 0;
    super.dispose();
  }
}
