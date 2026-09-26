export interface BurikoChildScrollbar {
  maximum: number;
  page: number;
  position: number;
  enabled: boolean;
}

/** Script-visible child-window scroll fields are separate from the actual scrollbar state. */
export class BurikoChildScroll {
  readonly ranges = [0, 0]; // Native +3c/+40, not reset by setProperty(...,0).
  readonly positions = [0, 0]; // Native +44/+48, written by notifications only.
  wheelStep = 1;
  readonly bars: readonly [BurikoChildScrollbar, BurikoChildScrollbar] = [
    {maximum: 0, page: 0, position: 0, enabled: false},
    {maximum: 0, page: 0, position: 0, enabled: false},
  ];
  constructor(readonly flags: number) {}

  private setPosition(axis: 0 | 1, value: number): void {
    const bar = this.bars[axis];
    bar.position = Math.min(
      Math.max(value | 0, 0),
      Math.max(0, bar.maximum - Math.max(bar.page - 1, 0)),
    );
  }

  /** 14006d180 receives DWORD operands from its sole executable caller, native B0 1400d5390. */
  setProperty(selector: number, value: number): number {
    selector >>>= 0;
    value |= 0;
    if (selector < 2) {
      const axis = selector as 0 | 1;
      if ((this.flags & (1 << axis)) === 0) return 0x8000000c;
      const bar = this.bars[axis];
      if (value === 0) {
        bar.maximum = 0;
        bar.page = 0;
      } else {
        const count = value & 0xffff;
        const page = value >>> 16;
        const maximum = (count - 1 + page) >>> 0;
        if (maximum <= page) return 0x8000000d;
        this.ranges[axis] = count;
        bar.maximum = maximum;
        bar.page = Math.min(page, maximum + 1);
      }
      this.setPosition(axis, bar.position);
      bar.enabled = bar.maximum > 0;
      return 0;
    }
    if (selector === 2 || selector === 3) {
      const axis = (selector - 2) as 0 | 1;
      if ((this.flags & (1 << axis)) === 0) return 0x8000000c;
      // The native selector-zero comparison in this branch is unreachable: both use +40.
      if (value > this.ranges[1]!) return 0x8000000d;
      this.setPosition(axis, value);
      return 0;
    }
    if (selector === 5) {
      this.wheelStep = value;
      return 0;
    }
    return 0x8000000c;
  }

  /** 14006d100 reads retained engine fields, never GetScrollInfo's clamped position. */
  getProperty(selector: number): {result: number; value?: number} {
    selector |= 0;
    if (selector === 0 || selector === 1) return {result: 0, value: this.ranges[selector]!};
    if (selector === 2 || selector === 3) return {result: 0, value: this.positions[selector - 2]!};
    return {result: 0x8000000c};
  }

  /** 14006cd70 handles WM_HSCROLL/WM_VSCROLL action values 0..5, including 16-bit thumbs. */
  notify(axis: 0 | 1, wParam: number): void {
    const action = wParam & 0xffff;
    if (action > 5) return;
    const bar = this.bars[axis];
    let value: number;
    if (action > 3) value = (wParam >>> 16) & 0xffff;
    else if (action === 0 || action === 2)
      value = Math.max(0, (bar.position - (action === 2 ? bar.page : 1)) | 0);
    else {
      const maximum = axis === 0 ? this.ranges[0]! : (bar.maximum - bar.page + 1) | 0;
      value = Math.min(maximum, (bar.position + (action === 3 ? bar.page : 1)) | 0);
    }
    this.setPosition(axis, value);
    this.positions[axis] = value;
  }

  /** The native wheel branch passes an unwritten SCROLLINFO.cbSize after computing its position. */
  wheel(wParam: number): void {
    const delta = wParam >> 16;
    if ((this.flags & 2) === 0 || delta === 0) return;
    const step = this.wheelStep;
    const numerator = (this.positions[1]! + (delta > 0 ? -step : step)) | 0;
    if (step === 0 || (numerator === -2147483648 && step === -1))
      throw new RangeError('Buriko child wheel reaches native IDIV overflow or zero divisor');
    // IDIV and all preceding native faults occur before SetScrollInfo reads this field.
    const remainder = numerator % step;
    const position = Math.min(this.ranges[1]!, Math.max(0, (numerator - remainder) | 0));
    throw new Error(
      `Buriko child wheel passes uninitialized native SCROLLINFO.cbSize for position ${position}`,
    );
  }
}
