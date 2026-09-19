import type {AokanaBitmapRectangle} from './bitmap.js';
import {
  AokanaDisplayObject,
  type AokanaDisplayObjectEnvironment,
  type AokanaDisplayPoint,
} from './display-object.js';

export interface AokanaKnobEvent {
  readonly pending: number;
  readonly x: number;
  readonly y: number;
  readonly rejected: number;
}

/** CDspObjKnob, the size-1B8 target controller constructed by 05C690. */
export class AokanaDisplayKnob extends AokanaDisplayObject {
  private currentX = 0;
  private currentY = 0;
  private dragAnchor = 1;
  private pickupX = 0;
  private pickupY = 0;
  private precisionX = 0;
  private precisionY = 0;
  private rangeMinimumX = 0;
  private rangeMinimumY = 0;
  private rangeMaximumX = 0;
  private rangeMaximumY = 0;
  private eventPending = 0;
  private eventX = 0;
  private eventY = 0;
  private eventRejected = 0;

  constructor(
    environment: AokanaDisplayObjectEnvironment,
    creationOrder: number,
    readonly target: AokanaDisplayObject,
  ) {
    super(environment, 10, creationOrder, 1);
    if (target.parent === null) target.parent = this;
    this.blendMode = target.blendMode;
    AokanaDisplayObject.prototype.setBlendValue.call(this, target.getBlendValue());
    this.setLayer(target.getLayer());
    this.setPrecision(0, 0);
    const rectangle = target.localRectangle();
    this.setRange(
      (rectangle.right - rectangle.left + 1) | 0,
      (rectangle.bottom - rectangle.top + 1) | 0,
    );
    this.setDragAnchor(1);
    const position = target.position();
    this.move(position.x, position.y);
    this.setValue(0, 0);
    this.takeEvent();
  }

  override dispose(): void {
    if (this.target.parent === this) this.target.parent = null;
    super.dispose();
  }

  override setActivation(value: number): void {
    super.setActivation(value);
    this.target.setActivation(value);
  }

  override invalidate(): void {
    this.check();
    this.target.invalidate();
  }

  override sortKey(): number {
    this.check();
    return this.target.sortKey();
  }

  override localRectangle(): AokanaBitmapRectangle {
    this.check();
    return this.target.localRectangle();
  }

  override inputRectangle(reference: 0 | AokanaBitmapRectangle): AokanaBitmapRectangle {
    this.check();
    return this.target.inputRectangle(reference);
  }

  override inputHitTest(x: number, y: number, checkBounds: number): number {
    this.check();
    return this.target.inputHitTest(x, y, checkBounds);
  }

  override setPosition(x: number, y: number, notifyParent: number, propagate: number): void {
    super.setPosition(x, y, notifyParent, propagate);
    const mapped = this.mappedValue();
    this.target.setPosition(((x | 0) + mapped.x) | 0, ((y | 0) + mapped.y) | 0, notifyParent, 1);
  }

  override setBlendValue(value: number): void {
    super.setBlendValue(value);
    this.target.setBlendValue(value);
  }

  value(): AokanaDisplayPoint {
    this.check();
    return {x: this.currentX, y: this.currentY};
  }

  setValue(x: number, y: number): 0 | 1 {
    this.check();
    x |= 0;
    y |= 0;
    const validX = x >= 0 && x <= this.maximumValue('x');
    const validY = y >= 0 && y <= this.maximumValue('y');
    if (validX) this.currentX = x;
    if (validY) this.currentY = y;
    if (validX && validY) {
      const base = this.position(),
        mapped = this.mappedValue();
      this.target.move((base.x + mapped.x) | 0, (base.y + mapped.y) | 0);
      return 1;
    }
    return 0;
  }

  setPrecision(x: number, y: number): 0 | 1 {
    this.check();
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0) return 0;
    this.precisionX = x;
    this.precisionY = y;
    return 1;
  }

  setRange(width: number, height: number): 0 | 1 {
    this.check();
    width |= 0;
    height |= 0;
    const rectangle = this.target.localRectangle(),
      targetWidth = (rectangle.right - rectangle.left + 1) | 0,
      targetHeight = (rectangle.bottom - rectangle.top + 1) | 0;
    if (width < targetWidth || height < targetHeight) return 0;
    this.rangeMinimumX = this.rangeMinimumY = 0;
    this.rangeMaximumX = (width - 1) | 0;
    this.rangeMaximumY = (height - 1) | 0;
    return 1;
  }

  setDragAnchor(value: number): void {
    this.check();
    this.dragAnchor = value | 0;
  }

  beginPointerDrag(x: number, y: number): void {
    this.check();
    if (this.dragAnchor !== 0) {
      const position = this.target.position();
      this.pickupX = ((x | 0) - position.x) | 0;
      this.pickupY = ((y | 0) - position.y) | 0;
    } else this.pickupX = this.pickupY = 0;
  }

  updatePointerDrag(x: number, y: number): 0 | 1 {
    this.check();
    const base = this.position(),
      rectangle = this.target.localRectangle(),
      relativeX = this.clamp(
        ((x | 0) - this.pickupX - base.x) | 0,
        this.rangeMinimumX,
        (this.rangeMaximumX - rectangle.right) | 0,
      ),
      relativeY = this.clamp(
        ((y | 0) - this.pickupY - base.y) | 0,
        this.rangeMinimumY,
        (this.rangeMaximumY - rectangle.bottom) | 0,
      ),
      valueX = this.pointerValue('x', relativeX),
      valueY = this.pointerValue('y', relativeY);
    if (valueX === this.currentX && valueY === this.currentY) return 0;
    this.setValue(valueX, valueY);
    return 1;
  }

  moveWheel(delta: number): void {
    this.check();
    delta |= 0;
    this.eventPending = 1;
    this.eventX = 0;
    this.eventY = delta;
    this.eventRejected = this.setValue(this.currentX, (this.currentY + delta) | 0) === 0 ? 1 : 0;
  }

  takeEvent(): AokanaKnobEvent {
    this.check();
    const result = {
      pending: this.eventPending,
      x: this.eventX,
      y: this.eventY,
      rejected: this.eventRejected,
    };
    this.eventPending = this.eventX = this.eventY = this.eventRejected = 0;
    return result;
  }

  private available(axis: 'x' | 'y'): number {
    const rectangle = this.target.localRectangle();
    return axis === 'x'
      ? (this.rangeMaximumX - this.rangeMinimumX - rectangle.right) | 0
      : (this.rangeMaximumY - this.rangeMinimumY - rectangle.bottom) | 0;
  }

  private step(axis: 'x' | 'y'): number {
    const precision = axis === 'x' ? this.precisionX : this.precisionY,
      numerator = this.available(axis) << 16,
      value = precision > 2 ? Math.trunc(numerator / (precision - 1)) | 0 : numerator;
    return value > 0 ? value : 1;
  }

  private maximumValue(axis: 'x' | 'y'): number {
    const precision = axis === 'x' ? this.precisionX : this.precisionY;
    if (precision <= 0) return this.available(axis);
    if (precision === 1) return 0;
    return Math.trunc((this.available(axis) << 16) / this.step(axis)) | 0;
  }

  private mappedValue(): AokanaDisplayPoint {
    return {
      x:
        this.precisionX > 0
          ? Math.imul(this.currentX, (this.step('x') + 1) | 0) >> 16
          : this.currentX,
      y:
        this.precisionY > 0
          ? Math.imul(this.currentY, (this.step('y') + 1) | 0) >> 16
          : this.currentY,
    };
  }

  private pointerValue(axis: 'x' | 'y', position: number): number {
    const precision = axis === 'x' ? this.precisionX : this.precisionY;
    if (precision <= 0) return position | 0;
    const minimum = axis === 'x' ? this.rangeMinimumX : this.rangeMinimumY,
      denominator = (Math.imul(precision, 2) - 2) | 0,
      bias = precision > 1 ? Math.trunc(this.available(axis) / denominator) | 0 : 0;
    return Math.trunc((((position - minimum + bias) | 0) << 16) / this.step(axis)) | 0;
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value | 0, minimum | 0), maximum | 0) | 0;
  }
}
