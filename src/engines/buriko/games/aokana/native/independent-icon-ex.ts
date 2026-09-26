import type {AokanaBitmapRectangle} from './bitmap.js';
import type {AokanaBitmapGroupDescription} from './bitmap-group-description.js';
import {AokanaDisplayObject} from './display-object.js';
import {AokanaVirtualDisplayObject} from './display-virtual.js';
import {AokanaIconWords, type AokanaIconRow} from './icon-description.js';
import {AokanaIndependentIcon} from './independent-icon.js';
import {requireAokanaResourceRange} from './bf-entropy.js';

interface Animation {
  present: number;
  visible: number;
  unit: AokanaIconWords | null;
  index: number;
  layer: number;
  frame: number;
  frameDeadline: bigint;
  angle: number;
  rotation: number;
  step: number;
  steps: number;
  rotationDeadline: bigint;
  depth: number;
}
interface Group {
  words: AokanaIconWords;
  units: AokanaIconWords[];
  animations: Animation[];
}
const u64 = (value: bigint): bigint => BigInt.asUintN(64, value);
const scratch = (): AokanaBitmapRectangle => ({left: 0, top: 0, right: 0, bottom: 0});

/** 094190/type1 and vtable17ED88, over the actual inherited controller and Window owners. */
export class AokanaIndependentIconEx extends AokanaIndependentIcon {
  override readonly type: number = 1;
  private groupCount = 0;
  private groups: Group[] | null = null;
  private sorted: number[] = [];
  private readonly writtenRectangles = new WeakSet<AokanaBitmapRectangle>();

  private group(index: number): Group {
    const group = this.groups?.[index];
    if (group === undefined) throw new Error('Aokana IconEx consumes an absent native group');
    return group;
  }
  private animation(row: number, column: number): Animation {
    const animation = this.group(row).animations[column];
    if (animation === undefined) throw new Error('Aokana IconEx indexes outside animation storage');
    return animation;
  }
  private unit(animation: Animation): AokanaIconWords {
    if (animation.unit === null) throw new Error('Aokana IconEx dereferences an absent unit');
    return animation.unit;
  }
  private readonly bitmapScratch = new WeakMap<AokanaBitmapRectangle, number>();
  private selectedBitmap(value: number | undefined): number {
    if (value === undefined) throw new Error('Aokana IconEx consumes unwritten bitmap scratch');
    return value;
  }
  private compose(animation: Animation, output: AokanaBitmapRectangle): void {
    if (this.window.composeInnerObject(output, animation.index) !== 0)
      this.writtenRectangles.add(output);
    if (!this.writtenRectangles.has(output))
      throw new Error('Aokana IconEx consumes unwritten inner-object rectangle');
    this.damage(output);
  }
  private erase(animation: Animation, output: AokanaBitmapRectangle): void {
    if (this.window.eraseInnerObject(output, animation.index) !== 0)
      this.writtenRectangles.add(output);
    if (!this.writtenRectangles.has(output))
      throw new Error('Aokana IconEx consumes unwritten erased-object rectangle');
    this.damage(output);
  }
  private replace(
    animation: Animation,
    source: number | undefined,
    area: AokanaBitmapRectangle,
  ): void {
    if (source !== undefined) this.bitmapScratch.set(area, source);
    this.window.replaceInnerSource(
      animation.index,
      this.selectedBitmap(this.bitmapScratch.get(area)),
    );
    this.compose(animation, area);
  }

  /** 093640 copies the complete description, then creates independent input and rendering owners. */
  initializeGroups(description: AokanaBitmapGroupDescription): number {
    this.reset();
    this.window.disableOverlays();
    this.window.configureInnerObjects(0);
    this.window.clearText();
    this.window.setTextTransparency(0);
    this.window.setTextEnabled(0);
    this.window.composeAll();
    const header = description.words,
      count = header[0]! | 0;
    let status = 0x80000001;
    if ((count - 1) >>> 0 < 256) {
      const grid: [number, number][] = [];
      let total = 0;
      for (let r = 0; r < count; r++) {
        const words = description.groups[r]!.words,
          n = words[0]! | 0,
          requested = words[1]! | 0,
          width = requested > 0 && requested <= n ? requested : n;
        if (width === 0) throw new Error('Aokana IconEx grid divides by zero');
        grid.push([width, Math.trunc(((width - 1 + n) | 0) / width)]);
        total = (total + n) | 0;
        if ((n - 1) >>> 0 >= 1024) {
          this.window.invalidate();
          this.mark();
          return 0x80000002;
        }
      }
      this.grid = grid;
      this.window.configureInnerObjects(total);
      this.groupCount = count;
      this.groups = [];
      this.rows = [];
      this.flat = [];
      this.currentRow = header[2]! | 0;
      if (this.currentRow < 0 || this.currentRow >= count) this.currentRow = -1;
      this.modal = header[3]! | 0;
      this.captureParent = header[4]! | 0;
      this.ignoredBits = header[5]! | 0;
      this.actionMap = header[6]! & 7;
      this.selectOnClick = header[7]! | 0;
      this.inputEnabled = Number(header[8] === 0);
      const sorted: {layer: number; index: number}[] = [];
      for (let r = 0; r < count; r++) {
        const original = description.groups[r]!,
          words = new AokanaIconWords(Array.from(original.words)),
          data = new AokanaIconWords(Array(16)),
          group: Group = {words, units: [], animations: []},
          row: AokanaIconRow = {data, icons: []};
        this.groups.push(group);
        this.rows.push(row);
        const n = words.read(0);
        data.write(0, n);
        let selected = words.read(3);
        if (selected < 0 || selected >= n) selected = -1;
        data.write(4, selected);
        for (let i = 5; i <= 14; i++) data.write(i, words.read(i));
        for (let c = 0; c < n; c++) {
          requireAokanaResourceRange(original.units.length, c * 0xc4, 0xc4);
          const view = new DataView(
              original.units.buffer,
              original.units.byteOffset + c * 0xc4,
              0xc4,
            ),
            unit = new AokanaIconWords(
              Array.from({length: 49}, (_, i) => view.getInt32(i * 4, true)),
            ),
            base = new AokanaIconWords(Array(18)),
            index = this.flat.length,
            animation: Animation = {
              present: 0,
              visible: 0,
              unit: null,
              index: 0,
              layer: 0,
              frame: 0,
              frameDeadline: 0n,
              angle: 0,
              rotation: 0,
              step: 0,
              steps: 0,
              rotationDeadline: 0n,
              depth: 0,
            };
          group.units.push(unit);
          group.animations.push(animation);
          row.icons.push(base);
          if (c === data.read(4) && unit.read(1) === 0) {
            data.write(4, -1);
            words.write(3, -1);
          }
          let source = unit.read(8);
          if (source !== -1 && c === data.read(4) && unit.read(10) !== -1) source = unit.read(10);
          const bitmap = unit.read(1) !== 0 ? this.shared.surfaces.snapshot(source) : null;
          const entry = {
            present: bitmap !== null,
            row: r,
            column: c,
            data: base,
            child: null as AokanaVirtualDisplayObject | null,
          };
          this.flat.push(entry);
          if (bitmap === null) {
            for (const [i, value] of [
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
              base.write(i!, value!);
            continue;
          }
          animation.present = 1;
          animation.visible = ~(unit.read(48) >>> 6) & 1;
          animation.unit = unit;
          animation.index = index;
          animation.layer =
            (unit.read(48) & 0x10) !== 0
              ? unit.read(1)
              : (unit.read(48) & 2) !== 0
                ? unit.read(3)
                : index;
          for (const [to, from] of [
            [0, 0],
            [1, 2],
            [2, 3],
            [3, 8],
            [4, 10],
            [5, 9],
            [6, 12],
            [7, 42],
            [8, 43],
            [9, 44],
            [10, 45],
            [11, 46],
            [12, 47],
          ])
            base.write(to!, unit.read(from!));
          base.write(14, 0);
          base.write(15, 0);
          base.write(16, 0);
          this.window.createInnerSprite(
            index,
            source,
            (unit.read(2) + unit.read(4)) | 0,
            (unit.read(3) + unit.read(5)) | 0,
            unit.read(4),
            unit.read(5),
            animation.layer,
          );
          this.window.setInnerVisibility(index, animation.visible);
          this.window.composeInnerObject(scratch(), index);
          const child = new AokanaVirtualDisplayObject(this.window.environment, index, this.window);
          entry.child = child;
          child.setUnbackedDimensions(bitmap.width, bitmap.height);
          AokanaDisplayObject.prototype.setSecondaryVisibility.call(child, animation.visible);
          child.setActivation(this.window.inputActive());
          const offset = this.window.getOffset();
          child.setOffset(offset.x, offset.y);
          const secondary = this.window.getSecondaryOffset();
          child.setSecondaryOffset(secondary.x, secondary.y);
          child.usesGlobalOrigin = this.window.usesGlobalOrigin;
          this.window.addChild(child, unit.read(2), unit.read(3));
          if (unit.read(0) === 0 || unit.read(12) === -2) {
            child.setHitMask(null);
            child.hitEnabled = 0;
          } else {
            const mask = this.shared.surfaces.snapshot(unit.read(12));
            if (mask !== null) child.setHitMask(mask);
          }
          this.installObject(child);
          let at = 0;
          while (at < sorted.length && sorted[at]!.layer >>> 0 > animation.layer >>> 0) at++;
          sorted.splice(at, 0, {layer: animation.layer, index});
        }
      }
      this.sorted = sorted.map((entry) => entry.index);
      const point = this.window.position();
      this.window.move(point.x, point.y);
      if (this.modal !== 0) {
        this.input.installPointerCapture(this.window.sortKey());
        this.input.installKeyCapture(this.window.sortKey());
        this.priorities.registerPointerPriority(this.id | 0x80000000, this.window.sortKey());
        this.selectRow(this.currentRow);
      } else if (this.captureParent !== 0) this.installObject(this.window);
      const pointerKey = this.window.sortKey(),
        key = this.window.sortKey();
      this.input.collect(key, pointerKey);
      this.input.collect(0, this.helper.sortKey());
      if (this.setHover(this.readHover(), 1) !== 0) this.publishHover();
      const initial = header[2]! | 0;
      this.pointerPrevious =
        initial === -1 || (description.groups[initial]!.words[3]! | 0) === -1
          ? [0x7fffffff, 0x7fffffff]
          : this.input.pointerPosition();
      this.unmaskedHover = this.hit(null, 0, 0);
      this.pressedHover = -1;
      this.running = 1;
      status = 0;
    }
    this.window.invalidate();
    this.mark();
    return status;
  }

  protected override flatIndex(index: number): number {
    return index >= 0 && index < this.sorted.length ? this.sorted[index]! : -1;
  }
  protected override finishSelection(): number {
    return 0;
  }
  protected override clickImmediate(index: number): number {
    if (index !== -1) {
      const e = this.item(index);
      if (
        (this.group(e.row).words.read(15) & 2) !== 0 ||
        (this.group(e.row).units[e.column]!.read(48) & 0x20) !== 0
      )
        return 0;
    }
    return 1;
  }
  protected override selectable(row: number, column: number): number {
    return Number(
      this.valid(row, column) !== 0 &&
        (this.group(row).units[column]!.read(13) === 0 || column !== this.row(row).data.read(4)),
    );
  }
  protected override hoverChanged(packed: number, alternate: number): void {
    const row = packed >> 16,
      column = (packed << 16) >> 16;
    if (
      row < 0 ||
      row >= this.groupCount ||
      column < 0 ||
      column >= this.group(row).words.read(0) ||
      (this.group(row).units[column]!.read(48) & 4) === 0
    )
      this.notify(0x10000002, packed, alternate);
  }
  protected override clickOutside(): void {
    const point = this.input.clickPosition(0);
    if (point === null) throw new Error('Aokana IconEx consumes an unwritten click');
    let [x, y] = point;
    if (this.modal === 0) {
      const p = this.window.position();
      x = (x - p.x) | 0;
      y = (y - p.y) | 0;
    }
    this.notify(0x10000007, -1, (y << 16) | (x & 0xffff));
  }
  protected override setResult(row: number, column: number, flag: number): number {
    const result = super.setResult(row, column, flag);
    if (result !== 0) {
      if (row === -1 || column === -1) this.notify(0x10000006, -1, flag);
      else {
        if (flag !== 0) {
          const p = this.clickPoint(row, column);
          this.notify(0x10000007, (row << 16) | column, (p[1] << 16) | (p[0] & 0xffff));
        }
        this.notify(0x10000006, (row << 16) | column, flag);
      }
    }
    return result;
  }
  protected override setFlatResult(index: number, flag: number): number {
    const result = super.setFlatResult(index, flag);
    if (result !== 0) {
      if (index === -1) this.notify(0x10000006, -1, flag);
      else {
        if (flag !== 0) {
          const e = this.item(index),
            p = this.clickPoint(e.row, e.column);
          this.notify(
            0x10000007,
            (this.item(index).row << 16) | this.item(index).column,
            (p[1] << 16) | (p[0] & 0xffff),
          );
        }
        const e = this.item(index);
        this.notify(0x10000006, (e.row << 16) | e.column, flag);
      }
    }
    return result;
  }
  protected override bitmapFor(
    row: number,
    column: number,
    hovered: number,
    selected: number,
  ): number | undefined {
    if (row < 0 || row >= this.groupCount || column >= this.group(row).words.read(0))
      return undefined;
    const a = this.animation(row, column);
    if (a.present === 0) return undefined;
    const unit = this.unit(a),
      flags = unit.read(48);
    let source = unit.read(8),
      bit = flags & 1;
    const chosen = selected !== 0 && column === this.group(row).words.read(3);
    let animate = true;
    if (hovered === 0) animate = chosen ? bit === 0 : bit === 0 && (flags & 8) === 0;
    else if (unit.read(9) !== -1) source = unit.read(9);
    else animate = chosen ? bit === 0 : bit === 0 && (flags & 8) === 0;
    if (chosen) {
      if (unit.read(10) === -1) bit = 0;
      else source = unit.read(10);
      if (hovered !== 0) {
        if (unit.read(11) === -1) return animate && bit === 0 ? (source + a.frame) | 0 : source;
        source = unit.read(11);
      }
    }
    return animate ? (source + a.frame) | 0 : source;
  }
  protected override selectColumn(row: number, column: number): number {
    if (row < 0 || row >= this.rows.length) return 0;
    const data = this.row(row).data,
      old = data.read(4);
    if ((column < 0 || column >= data.read(0)) && column !== -1) return 0;
    if (
      column !== -1 &&
      (this.group(row).units[column]!.read(0) === 0 || this.animation(row, column).visible === 0)
    )
      return 0;
    if (column === old) return 0;
    const area = scratch(),
      h = this.hover === -1 ? null : this.item(this.hover);
    if (old !== -1) {
      const a = this.animation(row, old);
      if ((this.unit(a).read(48) & 8) !== 0) {
        a.frame = 0;
        a.frameDeadline = 0n;
      }
      const bitmap = this.bitmapFor(row, old, Number(h?.row === row && h.column === old), 0);
      if (bitmap !== undefined) {
        this.replace(a, bitmap, area);
        this.mark();
      }
    }
    data.write(4, column);
    this.group(row).words.write(3, column);
    if (column !== -1) {
      this.replace(
        this.animation(row, column),
        this.bitmapFor(row, column, Number(h?.row === row && h.column === column), 1),
        area,
      );
      this.clearOtherRows(row);
      this.mark();
    }
    return 1;
  }
  protected override setHover(index: number, force: number): number {
    if (index === this.hover && force === 0) return 0;
    const inset = this.window.getTextRectangle(),
      area = scratch();
    for (let i = 2; i < 4; i++) {
      const old = this.window.overlayRectangle(i);
      if (old !== null) {
        Object.assign(area, old);
        this.writtenRectangles.add(area);
        this.damage(area);
        this.mark();
      }
    }
    if (this.hover !== -1) {
      const e = this.item(this.hover),
        g = this.group(e.row),
        a = this.animation(e.row, e.column),
        flags = this.unit(a).read(48);
      if ((flags & 1) !== 0 || ((flags & 8) !== 0 && e.column !== g.words.read(3))) {
        a.frame = 0;
        a.frameDeadline = 0n;
      }
      if ((g.words.read(15) & 1) !== 0) this.window.setInnerLayer(a.index, a.layer);
      this.replace(a, this.bitmapFor(e.row, e.column, 0, 1), area);
      this.mark();
    }
    if (index === -1) {
      this.window.setOverlayEnabled(2, 0);
      this.window.setOverlayEnabled(3, 0);
      this.mark();
    } else {
      const e = this.item(index),
        a = this.animation(e.row, e.column);
      if ((this.group(e.row).words.read(15) & 1) !== 0)
        this.window.setInnerLayer(a.index, (a.layer + 0x400) | 0);
      this.replace(a, this.bitmapFor(e.row, e.column, 1, 1), area);
      this.mark();
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
          const overlay = this.window.overlayRectangle(layer);
          if (overlay !== null) {
            Object.assign(area, overlay);
            this.writtenRectangles.add(area);
          }
          if (!this.writtenRectangles.has(area))
            throw new Error('Aokana IconEx consumes unwritten overlay rectangle');
          this.damage(area);
        }
        this.mark();
      }
    }
    this.hover = index;
    return 1;
  }
  protected override replaceBitmap(
    row: number,
    column: number,
    kind: number,
    value: number,
  ): number {
    if (row < 0 || row >= this.rows.length || column < 0 || column >= this.group(row).words.read(0))
      return 0;
    if (kind >>> 0 >= 4) return super.replaceBitmap(row, column, kind, value);
    this.group(row).units[column]!.write(8 + kind, value);
    const area = scratch(),
      h = this.hover === -1 ? null : this.item(this.hover);
    this.replace(
      this.animation(row, column),
      this.bitmapFor(row, column, Number(h?.row === row && h.column === column), 1),
      area,
    );
    this.mark();
    return 1;
  }
  protected override configureIcon(
    row: number,
    column: number,
    count: number,
    interval: number,
  ): number {
    if (!this.valid(row, column)) return 0;
    const a = this.animation(row, column);
    if (a.visible !== 0) {
      const unit = this.unit(a);
      unit.write(6, count);
      unit.write(7, interval);
      a.frame = 0;
      a.frameDeadline = 0n;
    }
    return 1;
  }
  /** C2ED0 calls092DD0 nonvirtually. */
  setIconVisibility(row: number, column: number, value: number): number {
    return AokanaIndependentIconEx.prototype.changeIcon.call(this, row, column, value);
  }
  /** 092D90 publishes row flags only after its signed row bound check. */
  protected motionRowFlags(row: number): number | undefined {
    if (row < 0 || row >= this.groupCount) return undefined;
    return this.group(row).words.read(15);
  }
  /** 092D20 deliberately has no separate negative-column check. */
  protected motionIndexStatus(row: number, column: number): number {
    if (row < 0 || row >= this.groupCount) return 0x80000001;
    return this.group(row).words.read(0) <= column ? 0x80000002 : 0;
  }
  protected override changeIcon(row: number, column: number, value: number): number {
    if (row < 0 || row >= this.groupCount) return 0x80000001;
    if (column >= this.group(row).words.read(0)) return 0x80000002;
    const a = this.animation(row, column);
    if (a.present !== 0) {
      for (let i = 0; ; i++) {
        const index = this.flatIndex(i);
        if (index === -1) break;
        const e = this.item(index);
        if (e.row === row && e.column === column) {
          AokanaDisplayObject.prototype.setSecondaryVisibility.call(e.child!, value);
          break;
        }
      }
      this.window.setInnerVisibility(a.index, value);
      this.compose(a, scratch());
      a.visible = value;
      this.mark();
    }
    return 0;
  }
  protected override moveIcon(
    row: number,
    column: number,
    x: number,
    y: number,
    depth: number,
    blend: number,
  ): number {
    if (row < 0 || row >= this.rows.length || column < 0 || column >= this.group(row).words.read(0))
      return 0;
    const a = this.animation(row, column);
    if (a.visible !== 0) {
      const unit = this.unit(a);
      unit.write(2, x);
      unit.write(3, y);
      a.depth = depth;
      const base = this.row(row).icons[column]!;
      base.write(1, x);
      base.write(2, y);
      const area = scratch();
      this.erase(a, area);
      this.window.setInnerCoordinates(
        a.index,
        (unit.read(4) + x) | 0,
        (unit.read(5) + y) | 0,
        depth,
      );
      this.window.setInnerBlendValue(a.index, blend);
      this.compose(a, area);
      this.mark();
      for (let i = 0; ; i++) {
        const index = this.flatIndex(i);
        if (index === -1) break;
        const e = this.item(index);
        if (e.row === row && e.column === column) {
          e.child!.move(area.left, area.top);
          e.child!.setUnbackedDimensions(
            (area.right - area.left + 1) | 0,
            (area.bottom - area.top + 1) | 0,
          );
          return 1;
        }
      }
    }
    return 1;
  }
  protected override tick(elapsed: bigint): void {
    const area = scratch(),
      now = u64(elapsed),
      h = this.hover === -1 ? null : this.item(this.hover);
    for (let row = 0; row < this.groupCount; row++)
      for (let column = 0; column < this.group(row).words.read(0); column++) {
        const a = this.animation(row, column);
        if (a.present === 0) continue;
        let unit = this.unit(a);
        if (unit.read(6) > 1 && unit.read(7) > 0) {
          const hovered = Number(h?.row === row && h.column === column),
            flags = unit.read(48);
          const eligible =
            (flags & 1) !== 0
              ? hovered !== 0
              : (flags & 8) === 0 || hovered !== 0 || column === this.group(row).words.read(3);
          if (eligible) {
            if (a.frameDeadline === 0n) {
              a.frame = 0;
              a.frameDeadline = u64(now + BigInt(unit.read(7)));
            } else if (a.frameDeadline <= now) {
              a.frame = (a.frame + 1) | 0;
              if (a.frame === unit.read(6)) a.frame = 0;
              a.frameDeadline = u64(a.frameDeadline + BigInt(unit.read(7)));
              this.replace(a, this.bitmapFor(row, column, hovered, 1), area);
              this.mark();
              unit = this.unit(a);
            }
          }
        }
        if (unit.read(14) <= 0) continue;
        const rotate =
          unit.read(40) === 0 ||
          (this.hover !== -1 &&
            this.selectable(row, column) !== 0 &&
            this.item(this.hover).row === row &&
            this.item(this.hover).column === column);
        if (!rotate) {
          if (a.rotationDeadline !== 0n) {
            if (this.unit(a).read(41) === 0) {
              this.erase(a, area);
              this.window.setInnerRotation(a.index, 0);
              this.compose(a, area);
              this.mark();
              a.rotationDeadline = 0n;
            } else a.rotationDeadline = u64(now + 4n);
          }
          continue;
        }
        if (a.rotationDeadline === 0n) {
          a.angle = this.unit(a).read(39);
          a.rotationDeadline = u64(now + 4n);
          a.rotation = 0;
          a.step = 0;
          continue;
        }
        if (a.rotationDeadline > now) continue;
        if (a.step === 0)
          a.steps = Math.max(1, Math.trunc(this.unit(a).read(16 + a.rotation * 3) / 4));
        a.step = (a.step + 1) | 0;
        this.erase(a, area);
        const delta = Number(
          BigInt.asIntN(
            32,
            (BigInt(this.unit(a).read(15 + a.rotation * 3)) * BigInt(a.step)) / BigInt(a.steps),
          ),
        );
        this.window.setInnerRotation(a.index, (delta + a.angle) | 0);
        this.compose(a, area);
        this.mark();
        if (a.step === a.steps) {
          const unit = this.unit(a);
          a.angle = ((unit.read(15 + a.rotation * 3) + a.angle) | 0) % 0x1680000;
          a.rotation = (a.rotation + 1) | 0;
          a.step = 0;
          if (a.rotation === unit.read(14)) a.rotation = 0;
        }
        a.rotationDeadline = u64(a.rotationDeadline + 4n);
      }
  }
  protected override reset(): void {
    // 091C10 retains E8 count while freeing/nulling extension pointers.
    if (this.groupCount > 0 && this.groups === null)
      throw new Error('Aokana IconEx dereferences freed native groups');
    this.groups = null;
    this.sorted = [];
    super.reset();
  }
  override dispose(): void {
    this.check();
    this.reset();
    super.dispose();
  }
}
