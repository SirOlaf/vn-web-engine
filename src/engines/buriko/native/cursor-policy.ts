import {BurikoDisplayManager} from './display-manager.js';
import {BurikoNativeClock} from './clock.js';
import {BurikoNativeInput} from './input.js';
import {BurikoNativeCursor} from './engine-dialogs.js';

/** Shared custom-object/auto-hide state from 1400efcd0, efc20, ef6c0, efb40 and ef890.
 * The existing native cursor owns physical CSS visibility; script visibility is independent. */
export class BurikoCursorPolicy {
  customObject = 0;
  scriptVisibility = 1; // 1c9acc
  autoHideEnabled = 0;
  autoHideShown = 0;
  autoHideDelay = 0;
  autoHideDeadline = 0;
  private customX = 0;
  private customY = 0;
  private previousX = 0x7fffffff;
  private previousY = 0x7fffffff;
  private hideX = -2147483648;
  private hideY = -2147483648;

  constructor(
    readonly manager: BurikoDisplayManager,
    readonly input: BurikoNativeInput,
    readonly clock: BurikoNativeClock,
    readonly physical: BurikoNativeCursor,
  ) {}

  setCustom(handle: number, x: number, y: number): 0 | -1 {
    handle >>>= 0;
    if (handle === 0) {
      if (this.customObject !== 0) {
        this.manager.setActivation(this.customObject, 0);
        this.customObject = 0;
        this.manager.redraw.request(0);
        this.physical.setVisible(this.autoHideEnabled !== 0 ? this.autoHideShown : 1);
      }
      return 0;
    }
    if (!this.manager.setActivation(handle, 1)) return -1;
    this.physical.setVisible(0);
    if (this.autoHideEnabled !== 0) this.manager.setSecondaryVisibility(handle, this.autoHideShown);
    this.previousX = this.previousY = 0x7fffffff;
    this.customObject = handle;
    this.customX = x | 0;
    this.customY = y | 0;
    this.updateCustom();
    return 0;
  }

  /** 1400ef6c0 keeps the requested nonzero integer rather than normalizing it. */
  setVisible(value: number): number {
    value |= 0;
    const previous = this.scriptVisibility;
    if ((previous === 0) === (value === 0)) return previous;
    this.scriptVisibility = value;
    if (this.customObject === 0) this.physical.setVisible(value);
    else {
      this.manager.setSecondaryVisibility(this.customObject, value);
      this.manager.redraw.request(0);
    }
    return previous;
  }

  /** GetCursorInfo is represented by the actual scoped browser cursor visibility primitive. */
  queryVisible(): number {
    return this.customObject === 0 && this.scriptVisibility !== 0
      ? Number(this.physical.requestedVisibility !== 0)
      : this.scriptVisibility;
  }

  setAutoHide(delay: number): void {
    delay |= 0;
    if (delay !== 0) {
      if (this.autoHideEnabled === 0) {
        this.autoHideEnabled = this.autoHideShown = 1;
        this.hideX = this.hideY = -2147483648;
      }
      this.autoHideDelay = delay;
      this.autoHideDeadline = (Number(BigInt.asUintN(32, this.clock.read())) + delay) >>> 0;
    } else if (this.autoHideEnabled !== 0) {
      this.autoHideEnabled = 0;
      if (this.autoHideShown === 0) this.setVisible(1);
    }
  }

  /** 1400efb40 is called separately from ef890; callers preserve that controller ordering. */
  updateCustom(): void {
    if (this.customObject === 0) return;
    const [x, y] = this.input.pointerPosition();
    if (x === this.previousX && y === this.previousY) return;
    this.previousX = x;
    this.previousY = y;
    const {left, top, right, bottom} = this.manager.visibleRectangle;
    this.physical.setVisible(Number(x < left || x > right || y < top || y > bottom));
    if (!this.manager.move(this.customObject, (x + this.customX) | 0, (y + this.customY) | 0)) {
      this.customObject = 0;
      this.physical.setVisible(1);
    }
    this.manager.redraw.request(0);
  }

  /** Auto-hide is the second half of ef890, after the separately owned cursor motion. */
  advanceAutoHide(): void {
    if (this.autoHideEnabled === 0) return;
    if (!this.input.foreground) {
      if (this.autoHideShown !== 0) return;
    } else {
      const [x, y] = this.input.pointerPosition();
      const stationary = x === this.hideX && y === this.hideY;
      const inside =
        x >= 0 &&
        x < this.manager.displayState.logicalWidth &&
        y >= 0 &&
        y < this.manager.displayState.logicalHeight;
      if (stationary && inside) {
        if (this.input.iconic === 0) {
          if (this.autoHideShown === 0) return;
          if (Number(BigInt.asUintN(32, this.clock.read())) < this.autoHideDeadline) return;
          this.setVisible(0);
          this.autoHideShown = 0;
          return;
        }
        if (this.autoHideShown !== 0) return;
      } else {
        this.hideX = x;
        this.hideY = y;
        if (this.autoHideShown !== 0) {
          this.autoHideDeadline =
            (Number(BigInt.asUintN(32, this.clock.read())) + this.autoHideDelay) >>> 0;
          return;
        }
      }
    }
    this.setVisible(1);
    this.autoHideShown = 1;
    this.autoHideDeadline =
      (Number(BigInt.asUintN(32, this.clock.read())) + this.autoHideDelay) >>> 0;
  }
}
