import {threeKnotPath} from './three-knot-path.js';
import {push32, type BurikoBpThread} from '../bp/state.js';
import {nativeDisplayEasing} from '../bp/opcodes/native-math.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoDisplayObject} from './display-object.js';
import type {BurikoNativeInput} from './input.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import type {BurikoBpProcessMessage} from './types.js';

function divide32(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -0x80000000 && denominator === -1))
    throw new Error('Buriko display control native signed division fault');
  return Math.trunc(numerator / denominator) | 0;
}
function low32(value: bigint): number {
  return Number(BigInt.asIntN(32, value));
}
function progress24(current: number, total: number): number {
  return low32((BigInt(current | 0) << 24n) / BigInt(total | 0));
}
function multiply16(value: number, easing: number): number {
  return low32((BigInt(value | 0) * BigInt(easing | 0)) >> 16n);
}
/** CProcCtrlDspObj 070840/0702f0, using the real display and procedure owners. */
export class BurikoDisplayControlProcess extends BurikoProcedure {
  protected object: BurikoDisplayObject;
  protected current = 0;
  protected total = 1;
  protected tickMilliseconds = 1;
  protected frameLimit = 0;
  protected positionEasing = 0;
  protected blendEasing = 0;
  protected startX = 0;
  protected startY = 0;
  protected deltaX = 0;
  protected deltaY = 0;
  protected startBlend = 0;
  protected deltaBlend = 0;
  protected lastX = -0x80000000;
  protected lastY = -0x80000000;
  protected lastBlend = -1;
  protected dirty = false;
  protected startDepth = 0;
  protected deltaDepth = 0;
  protected lastDepth = -1;
  protected startTime = 0;
  protected maximumStep = 0;
  protected nextMaximum = 0;
  private updates = 0;
  private captureEnabled = 0;
  private captured = false;
  private captureToken = 0;
  private pointerAllowed = false;
  private keyAllowed = false;
  private pointerCount = 0;
  private keyCount = 0;
  private finishRequested = false;

  constructor(
    thread: BurikoBpThread,
    procedures: BurikoProcedureState,
    clock: BurikoNativeClock,
    readonly manager: BurikoDisplayManager,
    readonly input: BurikoNativeInput,
    readonly handle: number,
    private readonly missingObject: () => Promise<never>,
  ) {
    super(thread, procedures, clock);
    const object = manager.resolve(handle);
    if (object === null)
      throw new Error('Buriko display control constructor dereferences an absent object');
    this.object = object;
  }

  /** 070750/0706e0/070580. A null target preserves the current XY position. */
  initialize(
    target: readonly [number, number, number] | null,
    blend: number,
    duration: number,
    frequency: number,
    frameLimit: number,
  ): void {
    const retainedPosition = target === null ? this.object.position() : null,
      depth = this.object.getValueD8(0);
    this.initializeFull(
      target === null ? retainedPosition!.x : target[0],
      target === null ? retainedPosition!.y : target[1],
      target === null ? 0 : target[2],
      blend,
      0,
      depth,
      duration,
      frequency,
      frameLimit,
    );
  }

  /** 070580: independent XY/blend easing and a negative-depth preservation sentinel. */
  initializeFull(
    x: number,
    y: number,
    positionEasing: number,
    blend: number,
    blendEasing: number,
    depth: number,
    duration: number,
    frequency: number,
    frameLimit: number,
  ): void {
    this.current = 0;
    this.total = (duration | 0) === 0 ? 1 : duration | 0;
    const position = this.object.position();
    this.startX = position.x;
    this.startY = position.y;
    this.deltaX = (x - position.x) | 0;
    this.deltaY = (y - position.y) | 0;
    this.positionEasing = positionEasing | 0;
    this.startBlend = this.object.getBlendValue();
    this.deltaBlend = (blend - this.startBlend) | 0;
    this.blendEasing = blendEasing | 0;
    this.startDepth = this.object.getValueD8(0);
    this.deltaDepth = (depth | 0) < 0 ? 0 : (depth - this.startDepth) | 0;
    this.lastX = this.lastY = -0x80000000;
    this.lastBlend = this.lastDepth = -1;
    this.object.setActivation(1);
    this.object.invalidate();
    this.frameLimit = frameLimit | 0;
    this.updates = 0;
    this.startTime = Number(BigInt.asUintN(32, this.clock.read()));
    this.maximumStep = divide32(Math.imul(frameLimit, 1000), frequency);
    this.nextMaximum = this.maximumStep >>> 0;
    this.setDeadline(1);
  }

  /** 070210 advances sampled paths and object shake through the same deadline owner. */
  protected advanceFrames(): boolean {
    let steps = 0;
    while (this.deadlineReached() && this.total > ((this.current + steps) | 0)) {
      this.deadline = (this.deadline + this.tickMilliseconds) >>> 0;
      steps = (steps + 1) | 0;
      if (this.deadlineReached() && steps === this.frameLimit) {
        this.setDeadline(this.tickMilliseconds);
        break;
      }
    }
    this.current = (this.current + steps) | 0;
    if (this.deadlineReached() && this.current === this.total)
      this.setDeadline(this.tickMilliseconds);
    return this.current === this.total;
  }

  /** 0704d0 installs captures without collecting them; eligibility needs two polls. */
  configureCapture(enabled: number, priority: number): void {
    this.captureEnabled = enabled | 0;
    if (enabled === 0) return;
    if (this.captured) {
      this.input.releasePointerCapture(this.captureToken);
      this.input.releaseKeyCapture(this.captureToken);
    }
    this.captureToken = ((priority << 16) | 0xffff) >>> 0;
    this.input.installPointerCapture(this.captureToken);
    this.input.installKeyCapture(this.captureToken);
    this.pointerCount = this.input.groupPressCount(1) >>> 0;
    this.keyCount = this.input.groupPressCount(this.input.allowMask | 0x180) >>> 0;
    this.captured = true;
  }

  protected override handleMessage(message: BurikoBpProcessMessage): void {
    if (message.code === 1 && (message.value1 !== 0 || this.captureEnabled !== 0))
      this.finishRequested = true;
  }

  poll(): number | Promise<number> {
    const object = this.manager.resolve(this.handle);
    if (object === null) return this.missingObject();
    this.object = object;
    this.consumeMessages();
    let inputFinish = 0;
    if (this.captureEnabled !== 0) {
      const pointers = this.input.groupPressCount(1) >>> 0,
        pointerAllowed = this.input.pointerCaptureAllowed(this.captureToken);
      if (pointerAllowed && this.pointerAllowed && this.pointerCount < pointers) inputFinish = 1;
      const keys = this.input.groupPressCount(this.input.allowMask | 0x180) >>> 0,
        keyAllowed = this.input.keyCaptureAllowed(this.captureToken);
      if (keyAllowed && this.keyAllowed && this.keyCount < keys) inputFinish = 0x100;
      if (this.input.skipRequested()) inputFinish = 0x80000000;
      if (inputFinish !== 0) this.input.collect(this.captureToken, this.captureToken);
      this.pointerAllowed = pointerAllowed;
      this.keyAllowed = keyAllowed;
      this.pointerCount = pointers;
      this.keyCount = keys;
    }
    let finished = !this.canRun(),
      status = 0xffffffff;
    if (!finished && (this.deadlineReached() || inputFinish !== 0 || this.finishRequested)) {
      finished = this.update(inputFinish !== 0 || this.finishRequested);
      if (finished) status = inputFinish !== 0 || this.finishRequested ? 1 : 0;
      if (this.dirty && this.manager.redraw.automaticEnabled !== 0) {
        this.manager.redraw.request(this.manager.redraw.automaticMode !== 0 ? 1 : 0);
        this.dirty = false;
      }
      this.updates = (this.updates + 1) | 0;
    }
    if (!finished) return 0;
    push32(this.thread, divide32(Math.imul(this.updates, 1000), this.total));
    push32(this.thread, status);
    return 1;
  }

  /** 070020 uses elapsed milliseconds, unsigned limiting, then a signed duration clamp. */
  protected update(forceFinish: boolean): boolean {
    if (forceFinish) this.current = this.total;
    else {
      let elapsed = (Number(BigInt.asUintN(32, this.clock.read())) - this.startTime) >>> 0;
      if (this.frameLimit !== 0) {
        elapsed = Math.min(elapsed, this.nextMaximum);
        this.nextMaximum = (elapsed + this.maximumStep) >>> 0;
      }
      this.current = (elapsed | 0) >= this.total ? this.total : elapsed | 0;
    }
    const finished = this.current === this.total,
      progress = finished ? 0 : progress24(this.current, this.total),
      eased = finished ? 0 : nativeDisplayEasing(progress, this.positionEasing),
      x = (this.startX + (finished ? this.deltaX : multiply16(this.deltaX, eased))) | 0,
      y = (this.startY + (finished ? this.deltaY : multiply16(this.deltaY, eased))) | 0,
      blend =
        (this.startBlend +
          (finished
            ? this.deltaBlend
            : multiply16(this.deltaBlend, nativeDisplayEasing(progress, this.blendEasing)))) |
        0,
      depth = finished
        ? (this.startDepth + this.deltaDepth) << 16
        : (low32((BigInt(Math.imul(this.current, this.deltaDepth)) << 16n) / BigInt(this.total)) +
            (this.startDepth << 16)) |
          0;
    if (
      x !== this.lastX ||
      y !== this.lastY ||
      blend !== this.lastBlend ||
      depth !== this.lastDepth
    ) {
      this.lastX = x;
      this.lastY = y;
      this.lastBlend = blend;
      this.lastDepth = depth;
      this.object.invalidate();
      this.object.move(x, y);
      this.object.setBlendValue(blend);
      this.object.setValueD8(1, depth);
      this.object.invalidate();
      this.dirty = true;
    }
    this.setDeadline(1);
    return finished;
  }

  override dispose(): void {
    if (this.captured) {
      this.input.releasePointerCapture(this.captureToken);
      this.input.releaseKeyCapture(this.captureToken);
    }
    super.dispose();
  }
}

/** CProcCtrlDspObjSp 071060: its own sampled XY path and deadline catch-up. */
export class BurikoSplineDisplayControlProcess extends BurikoDisplayControlProcess {
  private path: Int32Array = new Int32Array(0);
  private targetX = 0;
  private targetY = 0;
  private targetBlend = 0;

  initializeSpline(
    viaX: number,
    viaY: number,
    endX: number,
    endY: number,
    easing: number,
    blend: number,
    duration: number,
    frequency: number,
    frameLimit: number,
  ): number {
    if (frequency >>> 0 === 0) return 0x80000001;
    this.current = 0;
    this.total = Math.floor((Math.imul(duration, frequency) >>> 0) / 1000) || 1;
    this.tickMilliseconds = this.total > 1 ? Math.floor(1000 / (frequency >>> 0)) : duration | 0;
    const position = this.object.position();
    this.path = new Int32Array(0);
    const path = threeKnotPath(position.x, position.y, viaX, viaY, endX, endY, this.total + 1);
    if (path === null) return 0x80000002;
    this.path = path;
    this.positionEasing = easing | 0;
    this.startBlend = this.object.getBlendValue();
    this.deltaBlend = (blend - this.startBlend) | 0;
    this.object.setActivation(1);
    this.object.invalidate();
    this.setDeadline(this.tickMilliseconds);
    this.frameLimit = frameLimit | 0;
    this.targetX = endX | 0;
    this.targetY = endY | 0;
    this.targetBlend = blend | 0;
    return 0;
  }

  protected override update(forceFinish: boolean): boolean {
    const finished = forceFinish || this.advanceFrames();
    let x = this.targetX,
      y = this.targetY,
      blend = this.targetBlend;
    if (forceFinish) this.current = this.total;
    if (!finished) {
      const eased = nativeDisplayEasing(progress24(this.current, this.total), this.positionEasing),
        index = low32((BigInt(eased | 0) * BigInt(this.total + 1)) >> 16n);
      if (index < 0 || index >= this.path.length / 2)
        throw new Error('Buriko spline display control reads outside its native sampled path');
      x = this.path[index * 2]!;
      y = this.path[index * 2 + 1]!;
      blend =
        (divide32(Math.imul(this.deltaBlend, this.current), this.total) + this.startBlend) | 0;
    }
    if (x !== this.lastX || y !== this.lastY || blend !== this.lastBlend) {
      this.lastX = x;
      this.lastY = y;
      this.lastBlend = blend;
      this.object.invalidate();
      this.object.move(x, y);
      this.object.setBlendValue(blend);
      this.object.invalidate();
      this.dirty = true;
    }
    return finished;
  }

  override dispose(): void {
    this.path = new Int32Array(0);
    super.dispose();
  }
}
