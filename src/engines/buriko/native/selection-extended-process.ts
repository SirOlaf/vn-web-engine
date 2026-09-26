import type {BurikoBitmapRectangle} from './bitmap.js';
import {BurikoSelectionProcess} from './selection-process.js';

/** 07DED0, vtable17E7E8: pointer-following selection with two Window-owned markers. */
export class BurikoSelectionExtendedProcess extends BurikoSelectionProcess {
  protected firstPresent = 0;
  protected secondPresent = 0;
  protected firstX = 0;
  protected firstY = 0;
  protected secondX = 0;
  protected secondY = 0;

  /** 07DCD0 copies descriptors in order, publishing offsets only after both copies succeed. */
  configureOverlays(
    first: number,
    firstX: number,
    firstY: number,
    second: number,
    secondX: number,
    secondY: number,
  ): 0 | 0x8001 | 0x8002 | 0x8003 | 0x8004 {
    this.firstPresent = 0;
    if ((first | 0) !== -1) {
      const bitmap = this.window.windowState.manager.surfaces.snapshot(first);
      if (bitmap === null) return 0x8001;
      if (this.window.setOverlayBitmap(1, bitmap) !== 0) return 0x8002;
      this.firstPresent = 1;
    }
    this.secondPresent = 0;
    if ((second | 0) !== -1) {
      const bitmap = this.window.windowState.manager.surfaces.snapshot(second);
      if (bitmap === null) return 0x8003;
      if (this.window.setOverlayBitmap(2, bitmap) !== 0) return 0x8004;
      this.secondPresent = 1;
    }
    this.secondX = secondX | 0;
    this.secondY = secondY | 0;
    this.firstX = firstX | 0;
    this.firstY = firstY | 0;
    return 0;
  }
  protected override maskInput(bits: number): number {
    return bits & 0x03ff0203;
  }
  protected override hover(): boolean {
    const next = this.pointerEligible ? this.hitTest() : -1;
    if (next === this.selection) return false;
    this.notifications.push(0x10000002, this.thread.id, next);
    this.selection = next;
    return true;
  }
  /** 07DB80 intentionally consults firstPresent for BOTH marker iterations. */
  protected override drawSelection(): void {
    super.drawSelection();
    let published: BurikoBitmapRectangle | null = null;
    for (const marker of [1, 2]) {
      const old = this.window.overlayRectangle(marker);
      if (old !== null) {
        published = old;
        this.damage(old);
      }
      if (this.selection === -1) this.window.setOverlayEnabled(marker, 0);
      else if (this.firstPresent !== 0) {
        const rectangle = this.rectangles[this.selection];
        if (rectangle === undefined)
          throw new Error('Buriko extended selection reads an undefined item');
        const x =
            marker === 1
              ? (rectangle.left + this.firstX) | 0
              : (rectangle.right + 1 + this.secondX) | 0,
          y = (rectangle.top + (marker === 1 ? this.firstY : this.secondY)) | 0;
        this.window.setOverlayPosition(marker, x, y, 0);
        this.window.setOverlayEnabled(marker, 1);
        const next = this.window.overlayRectangle(marker);
        if (next !== null) published = next;
        // Native ignores this query's status and retains earlier published stack scratch.
        if (published === null)
          throw new Error('Buriko extended selection consumes undefined overlay damage');
        this.damage(published);
      }
    }
  }
  protected override advance(): number {
    if (this.phase === 0) {
      this.drawSelection();
      this.phase = (this.phase + 1) | 0;
    }
    if (this.inputBits === 0) {
      if (!this.hover()) return 0;
    } else {
      const result = this.handleInput();
      if (result === 1) return 1;
      if (result !== 2) return 0;
    }
    this.drawSelection();
    this.notifications.push(0x10000001, this.thread.id, this.selection);
    return 0;
  }
}

/** 07DFC0, vtable17E850: twenty50ms highlight phases, with the same actual base poll. */
export class BurikoSelectionBlinkProcess extends BurikoSelectionExtendedProcess {
  private blinkSteps = 0;
  protected override interval(): number {
    return 50;
  }
  protected override advance(): number {
    if (this.blinkSteps >= 20 || this.selection === -1) return 1;
    if (this.deadlineReached()) {
      if (this.blinkSteps === 0) this.drawSelection();
      else this.blinkSelection();
      this.blinkSteps = (this.blinkSteps + 1) | 0;
    }
    return 0;
  }
}
