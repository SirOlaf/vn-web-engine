import {BurikoDisplayKnob} from './display-knob.js';
import {BurikoDisplayManager, type BurikoDisplayCreateResult} from './display-manager.js';
import {BurikoNativeInput} from './input.js';
import {BurikoNativeNotifications} from './notification-queue.js';

export interface BurikoKnobPointerReceiver {
  readonly id: number;
  readonly object: BurikoDisplayKnob;
}

interface PointerReceiverNode extends BurikoKnobPointerReceiver {
  readonly sortKey: number;
  rightClickLatch: number;
  next: PointerReceiverNode | null;
}

interface WheelNode {
  readonly object: BurikoDisplayKnob;
  next: WheelNode | null;
}

/** The one Knob pool/list owner rooted at native globals 1E6CA0-1E6CC8. */
export class BurikoKnobDisplays {
  private pointerHead: PointerReceiverNode | null = null;
  private wheelHead: WheelNode | null = null;
  private current: PointerReceiverNode | null = null;
  private pointerX = 0;
  private pointerY = 0;
  private wheelMode = 1;

  constructor(
    readonly manager: BurikoDisplayManager,
    readonly input: BurikoNativeInput,
    readonly notifications: BurikoNativeNotifications,
  ) {}

  targetHasParent(handle: number): boolean {
    const target = this.manager.resolve(handle);
    return target !== null && target.parent !== null;
  }

  create(targetHandle: number): BurikoDisplayCreateResult<1 | 2 | 3> {
    const result = this.manager.createKnob(
      targetHandle,
      (creationOrder, target) =>
        new BurikoDisplayKnob(this.manager.environment, creationOrder, target),
    );
    if (result.result === 0) this.registerPointer(result.handle);
    return result;
  }

  destroy(handle: number): boolean {
    this.unregisterWheel(handle);
    this.unregisterPointer(handle);
    return this.manager.destroy('knob', handle);
  }

  setActivation(handle: number, value: number): boolean {
    const knob = this.find(handle);
    if (knob === null) return false;
    const before = knob.inputActive() !== 0;
    knob.setActivation(value);
    if (before !== (knob.inputActive() !== 0)) knob.invalidate();
    return true;
  }

  moveBase(handle: number, x: number, y: number): boolean {
    const knob = this.find(handle);
    if (knob === null) return false;
    const visible = knob.inputActive() !== 0;
    if (visible) knob.invalidate();
    knob.move(x, y);
    if (visible) knob.invalidate();
    return true;
  }

  setValue(handle: number, x: number, y: number): boolean {
    const knob = this.find(handle);
    if (knob === null) return false;
    const visible = knob.inputActive() !== 0;
    if (visible) knob.invalidate();
    knob.setValue(x, y);
    if (visible) knob.invalidate();
    return true;
  }

  value(handle: number): {x: number; y: number} | null {
    return this.find(handle)?.value() ?? null;
  }

  setPrecision(handle: number, x: number, y: number): -1 | 0 | 4 {
    const knob = this.find(handle);
    if (knob === null) return -1;
    return knob.setPrecision(x, y) !== 0 ? 0 : 4;
  }

  setRange(handle: number, width: number, height: number): -1 | 0 | 5 {
    const knob = this.find(handle);
    if (knob === null) return -1;
    return knob.setRange(width, height) !== 0 ? 0 : 5;
  }

  takeWheelBoundary(handle: number): number | null {
    const knob = this.find(handle);
    if (knob === null) return null;
    const event = knob.takeEvent();
    return event.rejected !== 0 ? event.y : 0;
  }

  setDragAnchor(handle: number, value: number): boolean {
    const knob = this.find(handle);
    if (knob === null) return false;
    knob.setDragAnchor(value);
    return true;
  }

  exchangeWheelMode(value: number): number {
    const previous = this.wheelMode;
    this.wheelMode = value | 0;
    return previous;
  }

  wheelModeValue(): number {
    return this.wheelMode;
  }

  registerWheel(handle: number): boolean {
    const object = this.find(handle);
    if (object === null) return false;
    this.wheelHead = {object, next: this.wheelHead};
    return true;
  }

  unregisterWheel(handle: number): boolean {
    const object = this.find(handle);
    if (object === null) return false;
    let previous: WheelNode | null = null;
    for (let node = this.wheelHead; node !== null; node = node.next) {
      if (node.object === object) {
        if (previous === null) this.wheelHead = node.next;
        else previous.next = node.next;
        return true;
      }
      previous = node;
    }
    return false;
  }

  handleWheel(negative: number): boolean {
    const object = this.wheelHead?.object;
    if (object === undefined) return false;
    object.invalidate();
    object.moveWheel(negative !== 0 ? 1 : -1);
    object.invalidate();
    this.manager.redraw.request(0);
    return true;
  }

  findPointerReceiver(): BurikoKnobPointerReceiver | null {
    for (let node = this.pointerHead; node !== null; node = node.next)
      if (this.input.pointerCaptureAllowed(node.object.sortKey())) return node;
    return null;
  }

  latchRightClick(receiver: BurikoKnobPointerReceiver): void {
    const node = this.pointerNode(receiver);
    if (node !== null) node.rightClickLatch = 1;
  }

  consumeRightClick(): number {
    let result = 0;
    for (let node = this.pointerHead; node !== null; node = node.next) {
      if (node.rightClickLatch === 0) continue;
      node.rightClickLatch = 0;
      result = node.id;
    }
    return result >>> 0;
  }

  beginPointerInteraction(receiver: BurikoKnobPointerReceiver | null, x: number, y: number): void {
    const node = receiver === null ? null : this.pointerNode(receiver);
    if (node !== null) {
      node.object.beginPointerDrag(x, y);
      this.notifications.push(0x1000, node.id, 0);
      this.pointerX = x | 0;
      this.pointerY = y | 0;
    }
    this.current = node;
  }

  currentPointerId(): number {
    return this.current?.id ?? 0;
  }

  pollPointerInteraction(): void {
    const node = this.current;
    if (node === null) return;
    if ((this.input.queryKey(1) & 0x8000) === 0) {
      this.notifications.push(0x1001, node.id, 0);
      this.current = null;
      return;
    }
    const [x, y] = this.input.pointerPosition();
    if (x === this.pointerX && y === this.pointerY) return;
    node.object.invalidate();
    if (node.object.updatePointerDrag(x, y) !== 0) node.object.invalidate();
    this.manager.redraw.request(0);
    this.pointerX = x;
    this.pointerY = y;
  }

  clearPointerReceivers(): void {
    for (let node = this.pointerHead; node !== null; node = node.next)
      this.input.releaseObjectCapture(node.object);
    this.pointerHead = null;
    this.current = null;
  }

  clearWheelReceivers(): void {
    this.wheelHead = null;
  }

  dispose(): void {
    this.clearPointerReceivers();
    this.clearWheelReceivers();
  }

  private find(handle: number): BurikoDisplayKnob | null {
    const object = this.manager.find('knob', handle);
    if (object === null) return null;
    if (!(object instanceof BurikoDisplayKnob))
      throw new Error('Buriko Knob pool contains a different native display class');
    return object;
  }

  private registerPointer(handle: number): void {
    const object = this.find(handle);
    if (object === null)
      throw new Error('Buriko Knob pointer registration has no current pool object');
    const sortKey = object.sortKey() >>> 0,
      node: PointerReceiverNode = {
        id: handle >>> 0,
        object,
        sortKey,
        rightClickLatch: 0,
        next: null,
      };
    let previous: PointerReceiverNode | null = null,
      current = this.pointerHead;
    while (current !== null && sortKey < current.sortKey) {
      previous = current;
      current = current.next;
    }
    node.next = current;
    if (previous === null) this.pointerHead = node;
    else previous.next = node;
    this.input.installObjectCapture(sortKey, [0, 0, 0, 0], object);
  }

  private unregisterPointer(handle: number): boolean {
    let previous: PointerReceiverNode | null = null;
    for (let node = this.pointerHead; node !== null; node = node.next) {
      if (node.id >>> 0 === handle >>> 0) {
        if (this.current === node) this.current = null;
        if (previous === null) this.pointerHead = node.next;
        else previous.next = node.next;
        this.input.releaseObjectCapture(node.object);
        return true;
      }
      previous = node;
    }
    return false;
  }

  private pointerNode(receiver: BurikoKnobPointerReceiver): PointerReceiverNode | null {
    for (let node = this.pointerHead; node !== null; node = node.next)
      if (node === receiver) return node;
    return null;
  }
}
