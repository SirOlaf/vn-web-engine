import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaDisplayObject} from './display-object.js';
import type {AokanaNativeInput} from './input.js';

interface SpriteTarget {
  readonly id: number;
  readonly handle: number;
  readonly object: AokanaDisplayObject;
  state: number;
  next: SpriteTarget | null;
}

/** 0F9FA0..0FA180: one target registry, sharing actual Sprite and input-capture owners. */
export class AokanaSpriteTargets {
  private nextId = 0;
  private first: SpriteTarget | null = null;
  constructor(
    readonly manager: AokanaDisplayManager,
    readonly input: AokanaNativeInput,
  ) {}

  /** 0FA070 installs capture before prepending the target; duplicate handles are not deduplicated. */
  register(handle: number): boolean {
    const object = this.manager.find('sprite', handle);
    if (object === null) return false;
    this.input.installObjectCapture(object.sortKey(), [0, 0, 0, 0], object);
    const node: SpriteTarget = {
      id: this.nextId,
      handle: handle >>> 0,
      object,
      state: 0,
      next: this.first,
    };
    this.nextId = (this.nextId + 1) >>> 0;
    this.first = node;
    return true;
  }
  /** 0F9FE0 removes only the newest matching handle and first matching shared capture. */
  unregister(handle: number): boolean {
    let previous: SpriteTarget | null = null;
    for (let node = this.first; node !== null; node = node.next) {
      if (node.handle === handle >>> 0) {
        this.input.releaseObjectCapture(node.object);
        if (previous === null) this.first = node.next;
        else previous.next = node.next;
        return true;
      }
      previous = node;
    }
    return false;
  }
  /** 0FA140 resets IDs only after draining all registrations. */
  clear(): void {
    while (this.first !== null) this.unregister(this.first.handle);
    this.nextId = 0;
  }
  /** 0FA180 deliberately uses only signed inclusive geometry, independent of capture eligibility. */
  hitTarget(): number {
    const position = this.input.pointerPosition(),
      x = position[0] | 0,
      y = position[1] | 0;
    for (let node = this.first; node !== null; node = node.next) {
      const rectangle = node.object.inputRectangle(0);
      if (
        x >= rectangle.left &&
        x <= rectangle.right &&
        y >= rectangle.top &&
        y <= rectangle.bottom
      )
        return node.id;
    }
    return 0xffffffff;
  }
  /** 0FA100 does not consume the retained value. */
  readState(id: number): number | null {
    for (let node = this.first; node !== null; node = node.next)
      if (node.id === id >>> 0) return node.state;
    return null;
  }
  /** 0F9FA0 belongs before the main loop's remaining input collection; no standalone fake loop. */
  poll(): void {
    for (let node = this.first; node !== null; node = node.next)
      node.state = this.input.collect(0, node.object.sortKey()) & 1;
  }
}
