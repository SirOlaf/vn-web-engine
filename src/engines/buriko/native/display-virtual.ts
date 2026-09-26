import {BurikoDisplayObject, type BurikoDisplayObjectEnvironment} from './display-object.js';

/** CDspObjVirtual, 066c10 and vtable 17d738. It forwards through its existing parent,
 * while its bitmap/mask geometry and all other native virtuals remain the shared base's. */
export class BurikoVirtualDisplayObject extends BurikoDisplayObject {
  value170 = 1;

  constructor(
    environment: BurikoDisplayObjectEnvironment,
    depthOrder: number,
    parent: BurikoDisplayObject | null,
  ) {
    super(environment, 8, depthOrder, 1);
    // 056700 only writes +148; it does not create a child-list entry in the parent.
    this.parent = parent;
  }

  /** 066a50 stores the raw DWORD used by the concrete DCIP animation consumers. */
  setValue170(value: number): void {
    this.check();
    this.value170 = value >>> 0;
  }

  override inputActive(): 0 | 1 {
    this.check();
    return this.parent === null ? super.inputActive() : this.parent.inputActive();
  }

  override sortKey(): number {
    this.check();
    return this.parent === null ? super.sortKey() : (this.parent.sortKey() + 0x8000) >>> 0;
  }

  override getLayer(): number {
    this.check();
    return this.parent === null ? super.getLayer() : this.parent.getLayer();
  }

  /** 066a60 scales into the child's bit mask before forwarding the original point to its parent. */
  override inputHitTest(x: number, y: number, checkBounds: number): number {
    this.check();
    x |= 0;
    y |= 0;
    const width = this.bitmap.width >>> 0,
      height = this.bitmap.height >>> 0;
    if (width === 0 || height === 0)
      throw new Error('Buriko virtual display hit test divides by zero native geometry');
    const maskX = Math.floor((Math.imul(this.hitWidth, x) >>> 0) / width),
      maskY = Math.floor((Math.imul(this.hitHeight, y) >>> 0) / height);
    if (BurikoDisplayObject.prototype.inputHitTest.call(this, maskX, maskY, checkBounds) === 0)
      return 0;
    const parent = this.parent;
    if (parent === null) return 1;
    // Virtual60 is raw GetPosition; effective position is the separate virtual68.
    const childPoint = this.position(),
      parentPoint = parent.position();
    return parent.inputHitTest(
      (childPoint.x - parentPoint.x + x) | 0,
      (childPoint.y - parentPoint.y + y) | 0,
      checkBounds,
    );
  }
}
