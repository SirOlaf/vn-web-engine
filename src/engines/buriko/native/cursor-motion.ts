import {nativeCursorInterpolation} from '../bp/opcodes/native-math.js';
import {pop32} from '../bp/state.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoCursorPolicy} from './cursor-policy.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export interface BurikoNativeCursorPosition {
  /** The native ClientToScreen/SetCursorPos primitive boundary; BOOL is discarded by the engine. */
  setClientPosition(x: number, y: number): boolean;
}

/** Browsers cannot warp the OS pointer. This is the real native failure path, without virtual motion. */
export class BurikoBrowserCursorPosition implements BurikoNativeCursorPosition {
  setClientPosition(_x: number, _y: number): boolean {
    return false;
  }
}

/** 1400eff30 and the motion section of 1400ef890; cursor auto-hide is a separate native state path. */
export class BurikoNativeCursorMotion {
  active = false;
  private startX = 0;
  private startY = 0;
  private deltaX = 0;
  private deltaY = 0;
  private expectedX = 0;
  private expectedY = 0;
  private easing = 0;
  private duration = 0;
  private steps = 0;
  private progress = 0;
  private startedAt = 0;
  private nextAt = 0;
  private cancelOnMotion = 0;

  constructor(
    readonly input: BurikoNativeInput,
    readonly clock: BurikoNativeClock,
    readonly platform: BurikoNativeCursorPosition,
  ) {}

  start(
    x: number,
    y: number,
    easing: number,
    duration: number,
    rate: number,
    cancelOnMotion: number,
  ): boolean {
    if (this.input.iconic !== 0) return false;
    [this.startX, this.startY] = this.input.pointerPosition();
    this.expectedX = this.startX;
    this.expectedY = this.startY;
    this.deltaX = (x - this.startX) | 0;
    this.deltaY = (y - this.startY) | 0;
    this.progress = 0;
    this.steps = Math.floor((Math.imul(duration, rate) >>> 0) / 1000) || 1;
    this.easing = easing | 0;
    this.duration = duration >>> 0;
    this.startedAt = Number(BigInt.asUintN(32, this.clock.read()));
    this.active = true;
    this.nextAt = (Math.floor(this.duration / this.steps) + this.startedAt) >>> 0;
    this.cancelOnMotion = cancelOnMotion | 0;
    return true;
  }

  advance(): void {
    if (!this.active) return;
    if (!this.input.foreground) {
      this.active = false;
      return;
    }
    const now = Number(BigInt.asUintN(32, this.clock.read()));
    while (this.active && this.nextAt <= now) {
      const [x, y] = this.input.pointerPosition(),
        dx = (x - this.expectedX) | 0,
        dy = (y - this.expectedY) | 0;
      const toleranceX = (this.input.display.pointerStepX + 0xffff) >>> 16,
        toleranceY = (this.input.display.pointerStepY + 0xffff) >>> 16;
      if (
        (dx < -toleranceX || dx > toleranceX || dy < -toleranceY || dy > toleranceY) &&
        this.cancelOnMotion !== 0
      ) {
        this.active = false;
        continue;
      }
      this.progress = (this.progress + 1) >>> 0;
      if (this.progress < this.steps) {
        this.expectedX =
          (this.startX +
            nativeCursorInterpolation(this.deltaX, this.easing, this.progress, this.steps)) |
          0;
        this.expectedY =
          (this.startY +
            nativeCursorInterpolation(this.deltaY, this.easing, this.progress, this.steps)) |
          0;
        this.nextAt =
          (Math.floor((Math.imul(this.progress + 1, this.duration) >>> 0) / this.steps) +
            this.startedAt) >>>
          0;
      } else {
        this.expectedX = (this.startX + this.deltaX) | 0;
        this.expectedY = (this.startY + this.deltaY) | 0;
        this.active = false;
      }
      if (this.input.pointerAvailable) {
        const [clientX, clientY] = this.input.display.transformPoint(
          this.expectedX,
          this.expectedY,
          0,
        );
        this.platform.setClientPosition(clientX, clientY);
      }
    }
  }
}

/** The cursor portion of ECB90, after sprite targets and before input capture. */
export class BurikoCursorFrameLower {
  constructor(
    readonly motion: BurikoNativeCursorMotion,
    readonly policy: BurikoCursorPolicy,
  ) {
    if (motion.input !== policy.input || motion.clock !== policy.clock)
      throw new Error('Buriko cursor frame requires one input and clock owner');
  }

  step(): void {
    this.motion.advance();
    this.policy.advanceAutoHide();
    this.policy.updateCustom();
  }
}

export function createGroup80CursorMotion(
  cursor: BurikoNativeCursorMotion,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x1f,
      nativeAddress: 0x1400e9c30,
      name: 'StartCursorMotion',
      execute: (h) => {
        const cancel = pop32(h.thread),
          rate = pop32(h.thread),
          duration = pop32(h.thread),
          easing = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread);
        cursor.start(x, y, easing, duration, rate, cancel);
        return 0;
      },
    },
  ];
}
