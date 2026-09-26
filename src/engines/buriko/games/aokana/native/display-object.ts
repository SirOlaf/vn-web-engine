import {
  displayPropertyOutput,
  type AokanaDisplayPropertyDestination,
} from './display-property-output.js';
import {
  AokanaBitmapStorage,
  aokanaBitmapPixelSize,
  bitmapStorage,
  cropAokanaBitmap,
  intersectAokanaBitmapRectangle,
  translateAokanaBitmapRectangle,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {AokanaDisplayDamage, aokanaRectangleContained} from './display-damage.js';
import {AokanaMemoryDx} from './memory-dx.js';

export type AokanaDisplayPoint = {x: number; y: number};
export type AokanaDisplayCoordinates = {x: number; y: number; z: number};
export interface AokanaDisplayContext {
  bitmap: AokanaBitmap;
  bounds: AokanaBitmapRectangle;
}
/** Shared native globals used by CDspObj, including the independent 1d1d20 point. */
export class AokanaDisplayObjectEnvironment {
  readonly origin = {x: 0, y: 0};
  /** Native 0871a0 returns a zero descriptor while the display-manager global is null. */
  displayContext: AokanaDisplayContext | null = null;
  displayBitmap(): AokanaBitmap {
    return this.displayContext === null
      ? {storage: null, offset: 0, stride: 0, width: 0, height: 0, format: 0, bytesPerPixel: 0}
      : {...this.displayContext.bitmap};
  }
  constructor(
    readonly compositor: AokanaBitmapCompositor,
    readonly damage: AokanaDisplayDamage,
  ) {}
}
interface Child {
  object: AokanaDisplayObject;
  x: number;
  y: number;
  next: Child | null;
}

/** CDspObj, constructor 056df0 and all thirty slots of vtable 17bf50. */
export class AokanaDisplayObject {
  secondaryVisibility = 1;
  propagateSecondaryVisibility = 0;
  suppression = 0;
  propagateSuppression = 0;
  activation = 0;
  layer = 0;
  sortBias = 0;
  sortMode = 0;
  readonly memory = new AokanaMemoryDx();
  readonly bitmap: AokanaBitmap = {
    storage: null,
    offset: 0,
    stride: 0,
    width: 0,
    height: 0,
    format: 0,
    bytesPerPixel: 0,
  };
  positionUsesCoordinates = 1;
  coordinateRounding = 0;
  coordinateRoundingAtDepth = 0;
  coordinateOption = 0;
  usesGlobalOrigin = 1;
  option5c = 1;
  blendMode = 0x80;
  blendValue = 0;
  transparency = 0;
  opacityScale = 0x100;
  valueD8 = 0;
  conditionalDamage = 0;
  flags = 0xffffffff;
  handle = 0;
  value124: number | undefined;
  hitEnabled = 1;
  parent: AokanaDisplayObject | null = null;
  /** CDspObj +168 is an associated DCIndProc pointer, used here only by identity. */
  private owner: object | null = null;
  private firstChild: Child | null = null;
  private keys = new Uint32Array(0);
  protected point = {x: 0, y: 0};
  protected offset = {x: 0, y: 0};
  protected secondaryOffset = {x: 0, y: 0};
  protected coordinatesValue = {x: 0, y: 0, z: 0};
  protected coordinateOffset = {x: 0, y: 0, z: 0};
  protected secondaryCoordinateOffset = {x: 0, y: 0, z: 0};
  private custom = new Uint32Array(16);
  protected hitMask: AokanaBitmapStorage | null = null;
  protected hitWidth = 0;
  protected hitHeight = 0;
  protected hitStride = 0;
  private disposed = false;

  constructor(
    readonly environment: AokanaDisplayObjectEnvironment,
    public category: number,
    public depthOrder: number,
    public value120: number,
  ) {
    this.category >>>= 0;
    this.depthOrder >>>= 0;
    this.value120 >>>= 0;
  }
  protected check(): void {
    if (this.disposed) throw new Error('Aokana accesses a deleted CDspObj');
  }
  /** ABB40 borrows these raw fields; no virtual coordinate/visibility evaluation occurs. */
  diagnosticPropertyWord(offset: number): number {
    this.check();
    switch (offset) {
      case 0x08:
        return this.secondaryVisibility;
      case 0x10:
        return this.suppression;
      case 0x18:
        return this.activation;
      case 0x20:
        return this.layer;
      case 0x40:
        return this.point.x;
      case 0x44:
        return this.point.y;
      case 0x48:
        return this.offset.x;
      case 0x4c:
        return this.offset.y;
      case 0x50:
        return this.secondaryOffset.x;
      case 0x54:
        return this.secondaryOffset.y;
      case 0x60:
        return this.coordinatesValue.x;
      case 0x64:
        return this.coordinatesValue.y;
      case 0x68:
        return this.coordinatesValue.z;
      case 0x70:
        return this.coordinateOffset.x;
      case 0x74:
        return this.coordinateOffset.y;
      case 0x78:
        return this.coordinateOffset.z;
      case 0x80:
        return this.secondaryCoordinateOffset.x;
      case 0x84:
        return this.secondaryCoordinateOffset.y;
      case 0x88:
        return this.secondaryCoordinateOffset.z;
      case 0xc8:
        return this.blendMode;
      case 0xcc:
        return this.blendValue;
      case 0xd0:
        return this.transparency;
      case 0xd4:
        return this.opacityScale;
      default:
        throw new Error('Aokana object diagnostic references an unsupported field');
    }
  }
  /** 056670. This association does not own or invoke the procedure. */
  getOwner(): object | null {
    this.check();
    return this.owner;
  }
  /** 055e60 returns the stored +48 point, independently of coordinate evaluation. */
  getOffset(): AokanaDisplayPoint {
    this.check();
    return {...this.offset};
  }
  /** 055df0 returns the stored +50 point. */
  getSecondaryOffset(): AokanaDisplayPoint {
    this.check();
    return {...this.secondaryOffset};
  }
  /** 056680. */
  setOwner(owner: object | null): void {
    this.check();
    this.owner = owner;
  }
  /** 0566c0. */
  attachOwnerIfEmpty(owner: object | null): 0 | 1 {
    if (this.getOwner() !== null) return 0;
    this.setOwner(owner);
    return 1;
  }
  /** 056690. */
  removeOwnerIfMatches(owner: object | null): 0 | 1 {
    if (this.getOwner() !== owner) return 0;
    this.setOwner(null);
    return 1;
  }
  *children(): IterableIterator<AokanaDisplayObject> {
    this.check();
    for (let child = this.firstChild; child !== null; child = child.next) yield child.object;
  }
  /** Base destructor removes relationship nodes; it does not delete child objects. */
  dispose(): void {
    this.check();
    this.memory.dispose();
    this.setHitMask(null);
    this.replaceExpandedSortKeys(null);
    while (this.firstChild !== null) this.removeChild(this.firstChild.object);
    this.parent?.removeChild(this);
    this.disposed = true;
  }
  setActivation(value: number): void {
    this.check();
    this.activation = value | 0;
    for (const child of this.children()) child.setActivation(value);
  }
  inputActive(): 0 | 1 {
    this.check();
    return this.activation !== 0 &&
      this.secondaryVisibility !== 0 &&
      this.suppression === 0 &&
      this.transparency >>> 0 < 0x100 &&
      this.opacityScale !== 0
      ? 1
      : 0;
  }
  invalidate(): void {
    this.check();
    if (this.bitmap.stride !== 0)
      this.environment.damage.record(this.sortKey(), this.inputRectangle(0));
    for (const child of this.children()) child.invalidate();
  }
  hasExpandedSortKeys(): number {
    this.check();
    return 0;
  }
  findExpandedSortKey(key: number): number {
    this.check();
    const index = this.keys.indexOf(key >>> 0);
    return index === -1 ? 0xffffffff : index;
  }
  /** 0561a0 is the native empty base draw virtual; derived classes supply their own actual draw. */
  draw(_destination: AokanaBitmap, _rectangle: AokanaBitmapRectangle, _key: number): void {
    this.check();
  }
  sortKey(): number {
    this.check();
    const z = this.effectiveCoordinates().z;
    if (this.sortMode === 0) {
      const depth = this.positionUsesCoordinates === 0 ? 0xfff - (z >> 19) : this.depthOrder;
      return (
        (Math.imul(Math.min(this.category >>> 0, 7) + Math.imul(this.getLayer(), 8), 0x2000) +
          (depth & 0x1fff) +
          this.sortBias) >>>
        0
      );
    }
    if (this.sortMode === 1)
      return (this.sortBias - (z >> 16) + 0x7fff + Math.imul(this.getLayer(), 0x10000)) >>> 0;
    return 0;
  }
  localRectangle(): AokanaBitmapRectangle {
    this.check();
    return {
      left: 0,
      top: 0,
      right: (this.bitmap.width - 1) | 0,
      bottom: (this.bitmap.height - 1) | 0,
    };
  }
  inputRectangle(_reference: 0 | AokanaBitmapRectangle): AokanaBitmapRectangle {
    const rectangle = this.localRectangle(),
      point = this.effectivePosition();
    translateAokanaBitmapRectangle(rectangle, point.x, point.y);
    return rectangle;
  }
  setPosition(x: number, y: number, notifyParent: number, propagate: number): void {
    this.check();
    this.point = {x: x | 0, y: y | 0};
    if (notifyParent !== 0) this.parent?.updateChildOffset(this);
    if (propagate !== 0)
      for (let child = this.firstChild; child !== null; child = child.next)
        child.object.setPosition((x + child.x) | 0, (y + child.y) | 0, 0, 1);
  }
  move(x: number, y: number): void {
    this.setPosition(x, y, 1, 1);
  }
  position(): AokanaDisplayPoint {
    this.check();
    return {...this.point};
  }
  effectivePosition(): AokanaDisplayPoint {
    this.check();
    const origin = this.usesGlobalOrigin !== 0 ? this.environment.origin : {x: 0, y: 0};
    return {
      x: (this.point.x + this.offset.x + this.secondaryOffset.x + origin.x) | 0,
      y: (this.point.y + this.offset.y + this.secondaryOffset.y + origin.y) | 0,
    };
  }
  setOffset(x: number, y: number): void {
    this.check();
    this.offset = {x: x | 0, y: y | 0};
    for (const child of this.children()) child.setOffset(x, y);
  }
  setCoordinates(x: number, y: number, z: number): void {
    this.check();
    x |= 0;
    y |= 0;
    z |= 0;
    if (this.coordinateRounding !== 0 && (z === 0 || this.coordinateRoundingAtDepth === 1)) {
      x = (x + 0x8000) & 0xffff0000;
      y = (y + 0x8000) & 0xffff0000;
    }
    const old = this.coordinatesValue;
    this.coordinatesValue = {x, y, z};
    if (this.positionUsesCoordinates !== 0) this.setPosition(x >> 16, y >> 16, 1, 1);
    for (const child of this.children()) {
      const position = child.coordinates();
      child.setCoordinates(
        (position.x - old.x + x) | 0,
        (position.y - old.y + y) | 0,
        (position.z - old.z + z) | 0,
      );
    }
  }
  /** Native virtual80 copies an extra unwritten padding DWORD; the three actual coordinates are defined. */
  coordinates(): AokanaDisplayCoordinates {
    this.check();
    return {...this.coordinatesValue};
  }
  setCoordinateOffset(x: number, y: number, z: number): void {
    this.check();
    this.coordinateOffset = {x: x | 0, y: y | 0, z: z | 0};
    for (const child of this.children()) child.setCoordinateOffset(x, y, z);
  }
  setBlendValue(value: number): void {
    this.check();
    this.blendValue = value | 0;
    for (const child of this.children()) child.setBlendValue(value);
  }
  getBlendValue(): number {
    this.check();
    return this.blendValue;
  }
  setValueD8(mode: number, value: number): void {
    this.check();
    this.valueD8 = mode === 1 ? value | 0 : value << 16;
    for (const child of this.children()) child.setValueD8(mode, value);
  }
  setLayer(value: number): 0 | 1 {
    this.check();
    if (value >>> 0 >= 0x10000) return 0;
    this.layer = value >>> 0;
    return 1;
  }
  getLayer(): number {
    this.check();
    return this.layer;
  }
  setProperty(selector: number, first: number, second: number): number {
    this.check();
    selector >>>= 0;
    switch (selector) {
      case 0:
        this.move(first, second);
        break;
      case 1:
        this.blendMode = first | 0;
        break;
      case 2:
        this.setBlendValue(first);
        break;
      case 0xc0:
        this.propagateSecondaryVisibility = first | 0;
        break;
      case 0xc1:
        this.propagateSuppression = first | 0;
        break;
      case 0xc4:
        this.usesGlobalOrigin = first | 0;
        break;
      case 0xc5:
        this.option5c = first | 0;
        break;
      case 0x8000:
        this.coordinateRounding = first | 0;
        this.coordinateRoundingAtDepth = second | 0;
        break;
      case 0x8001:
        this.coordinateOption = first | 0;
        break;
      case 0x8100:
        this.sortBias = first | 0;
        break;
      case 0x8101:
        if (first >>> 0 >= 2) return 0xffff0002;
        this.sortMode = first | 0;
        break;
      case 0xffff:
        this.setMaskedFlags(first, second);
        break;
      case 0x7fff0000:
        this.conditionalDamage = first | 0;
        break;
      case 0x7fffffff:
        if (!this.setCustom(first, second)) return 0xffff0002;
        break;
      default:
        return 0xffff0001;
    }
    return 0;
  }
  /** Output is native caller memory: unsupported selectors do not dereference it. */
  getProperty(selector: number, output: AokanaDisplayPropertyDestination): number {
    this.check();
    const access = displayPropertyOutput(output),
      write = (index: number, value: number): void => access.write32(index, value >>> 0);
    switch (selector >>> 0) {
      case 0: {
        const p = this.position();
        write(0, p.x);
        write(1, p.y);
        break;
      }
      case 1:
        write(0, this.blendMode);
        break;
      case 2:
        write(0, this.getBlendValue());
        break;
      case 3:
        write(0, this.getLayer());
        break;
      case 0x20: {
        const p = this.coordinates();
        write(0, p.x);
        write(1, p.y);
        write(2, p.z);
        break;
      }
      case 0x7fffffff: {
        const value = this.getCustom(access.read32(0));
        if (value === null) return 0xffff0002;
        write(0, value);
        break;
      }
      case 0xfffffffe:
        write(0, this.sortKey());
        break;
      case 0xffffffff:
        if (this.value124 === undefined) throw new Error('CDspObj reads unwritten field +124');
        write(0, this.value124);
        break;
      default:
        return 0xffff0001;
    }
    return 0;
  }
  inputHitTest(x: number, y: number, checkBounds: number): number {
    this.check();
    x |= 0;
    y |= 0;
    if (
      this.hitEnabled === 0 ||
      x < 0 ||
      y < 0 ||
      (checkBounds !== 0 &&
        (x >>> 0 >= this.bitmap.width >>> 0 || y >>> 0 >= this.bitmap.height >>> 0))
    )
      return 0;
    if (this.hitMask === null) return 1;
    if (x >>> 0 >= this.hitWidth >>> 0 || y >>> 0 >= this.hitHeight >>> 0) return 0;
    const at = ((x >>> 3) + Math.imul(this.hitStride, y)) >>> 0;
    this.hitMask.range(at, 1, true);
    return this.hitMask.bytes[at]! & (1 << (x & 7));
  }
  /** 055140, the native empty virtual D0. */
  notify(..._arguments: unknown[]): void {
    this.check();
  }
  /** 055130, the complete native default virtual D8. */
  defaultOperation(..._arguments: unknown[]): number {
    this.check();
    return 0x80000001;
  }
  usesCoordinateParenting(): number {
    this.check();
    return 0;
  }
  configureGeometry(width: number, height: number): 0 | 1 {
    this.check();
    width |= 0;
    height |= 0;
    if (width === 0 || height === 0) return 0;
    this.bitmap.width = width;
    this.bitmap.height = height;
    const format = this.environment.compositor.defaultFormat;
    this.bitmap.format = format;
    const bytesPerPixel = aokanaBitmapPixelSize(format);
    this.bitmap.bytesPerPixel = bytesPerPixel;
    this.bitmap.storage = null;
    this.bitmap.offset = 0;
    this.bitmap.stride = Math.imul(width, bytesPerPixel);
    return 1;
  }

  /** 0568E0 changes only dimensions when the descriptor has no pixel backing. */
  setUnbackedDimensions(width: number, height: number): 0 | 1 {
    this.check();
    if (this.bitmap.storage !== null) return 0;
    this.bitmap.width = width | 0;
    this.bitmap.height = height | 0;
    return 1;
  }

  setSecondaryVisibility(value: number): void {
    this.check();
    this.secondaryVisibility = value | 0;
    if (this.propagateSecondaryVisibility !== 0)
      for (const child of this.children())
        AokanaDisplayObject.prototype.setSecondaryVisibility.call(child, value);
  }
  setSuppression(value: number): void {
    this.check();
    this.suppression = value | 0;
    if (this.propagateSuppression !== 0)
      for (const child of this.children())
        AokanaDisplayObject.prototype.setSuppression.call(child, value);
  }
  setSecondaryOffset(x: number, y: number): void {
    this.check();
    this.secondaryOffset = {x: x | 0, y: y | 0};
    for (const child of this.children())
      AokanaDisplayObject.prototype.setSecondaryOffset.call(child, x, y);
  }
  setSecondaryCoordinateOffset(x: number, y: number, z: number): void {
    this.check();
    this.secondaryCoordinateOffset = {x: x | 0, y: y | 0, z: z | 0};
    for (const child of this.children())
      AokanaDisplayObject.prototype.setSecondaryCoordinateOffset.call(child, x, y, z);
    const p = this.coordinateOffset;
    this.setCoordinateOffset(p.x, p.y, p.z);
  }
  effectiveCoordinates(): AokanaDisplayCoordinates {
    this.check();
    const a = this.coordinatesValue,
      b = this.coordinateOffset,
      c = this.secondaryCoordinateOffset;
    return {x: (a.x + b.x + c.x) | 0, y: (a.y + b.y + c.y) | 0, z: (a.z + b.z + c.z) | 0};
  }
  setTransparency(value: number): void {
    this.check();
    if ((this.flags & 1) !== 0) this.transparency = value | 0;
    for (const child of this.children())
      AokanaDisplayObject.prototype.setTransparency.call(child, value);
  }
  setOpacityScale(value: number): void {
    this.check();
    this.opacityScale = value | 0;
    for (const child of this.children())
      AokanaDisplayObject.prototype.setOpacityScale.call(child, value);
  }
  getValueD8(mode: number): number {
    this.check();
    return mode === 1 ? this.valueD8 >>> 0 : this.valueD8 >>> 16;
  }
  effectiveBlendValue(): number {
    this.check();
    if ([1, 0x20, 0x21, 0x22, 0x23, 0x24].includes(this.blendMode))
      return (
        (0x100 -
          (Math.imul(
            Math.imul(0x100 - this.transparency, 0x100 - this.blendValue),
            this.opacityScale,
          ) >>>
            16)) >>>
        0
      );
    if ([2, 3, 4, 0xc0, 0xc1].includes(this.blendMode))
      return (
        Math.imul(Math.imul(0x100 - this.transparency, this.opacityScale), this.blendValue) >>> 16
      );
    return this.blendValue >>> 0;
  }
  setMaskedFlags(mask: number, value: number): void {
    this.check();
    mask >>>= 0;
    if (mask === 0) mask = 0xffffffff;
    this.flags = (value !== 0 ? this.flags | mask : this.flags & ~mask) >>> 0;
  }
  setCustom(index: number, value: number): boolean {
    this.check();
    index >>>= 0;
    if (index >= 16) return false;
    this.custom[index] = value >>> 0;
    return true;
  }
  getCustom(index: number): number | null {
    this.check();
    return this.custom[index >>> 0] ?? null;
  }
  replaceExpandedSortKeys(keys: Uint32Array | null): void {
    this.check();
    this.keys = new Uint32Array(0);
    if (keys !== null) this.keys = keys.slice();
  }
  copyExpandedSortKeys(output: Uint32Array | null): number {
    this.check();
    if (output !== null) {
      if (output.length < this.keys.length)
        throw new RangeError('CDspObj expanded keys exceed native output');
      output.set(this.keys);
    }
    return this.keys.length;
  }
  addChild(object: AokanaDisplayObject, x: number, y: number): 0 | 1 {
    this.check();
    object.check();
    if (object.parent !== null && object.category !== 8) return 0;
    this.firstChild = {object, x: x | 0, y: y | 0, next: this.firstChild};
    object.parent = this;
    if (this.usesCoordinateParenting() !== 0 && object.usesCoordinateParenting() !== 0) {
      const p = this.coordinates();
      object.setCoordinates((p.x + x) | 0, (p.y + y) | 0, p.z);
    } else {
      const p = this.position();
      object.setPosition((p.x + x) | 0, (p.y + y) | 0, 0, 1);
    }
    return 1;
  }
  removeChild(object: AokanaDisplayObject): 0 | 1 {
    this.check();
    let previous: Child | null = null;
    for (let child = this.firstChild; child !== null; child = child.next) {
      if (child.object === object) {
        if (previous === null) this.firstChild = child.next;
        else previous.next = child.next;
        object.parent = null;
        return 1;
      }
      previous = child;
    }
    return 0;
  }
  updateChildOffset(object: AokanaDisplayObject): boolean {
    this.check();
    for (let child = this.firstChild; child !== null; child = child.next)
      if (child.object === object) {
        const a = this.position(),
          b = object.position();
        child.x = (b.x - a.x) | 0;
        child.y = (b.y - a.y) | 0;
        return true;
      }
    return false;
  }
  setHitMask(source: AokanaBitmap | null): void {
    this.check();
    if (this.hitMask !== null) {
      this.hitMask.release();
      this.hitMask = null;
      this.hitEnabled = 0;
      this.hitWidth = this.hitHeight = this.hitStride = 0;
    }
    if (source !== null) {
      this.hitWidth = source.width;
      this.hitHeight = source.height;
      this.hitStride = (source.width + 7) >>> 3;
      this.hitMask = new AokanaBitmapStorage(
        new Uint8Array(Math.imul(this.hitHeight, this.hitStride) >>> 0),
        false,
      );
      for (let y = 0; y < this.hitHeight >>> 0; y++) {
        const row = y * (this.hitStride | 0);
        this.hitMask.range(row, this.hitStride | 0, false);
        this.hitMask.bytes.fill(0, row, row + (this.hitStride | 0));
        this.hitMask.written(row, this.hitStride | 0);
        for (let x = 0; x < this.hitWidth >>> 0; x++) {
          const offset = source.offset + y * (source.stride | 0) + x * (source.bytesPerPixel >>> 0);
          let selected = 0;
          switch (source.format) {
            case 0:
              selected = bitmapStorage(source, offset, 2, true).view.getUint16(offset, true);
              break;
            case 1:
              selected =
                bitmapStorage(source, offset, 4, true).view.getUint32(offset, true) & 0xffffff;
              break;
            case 2:
              selected =
                bitmapStorage(source, offset, 4, true).view.getUint32(offset, true) & 0xff000000;
              break;
            case 3:
              selected = bitmapStorage(source, offset, 1, true).bytes[offset]!;
              break;
          }
          if (selected !== 0) {
            const target = y * (this.hitStride | 0) + (x >>> 3);
            this.hitMask.range(target, 1, true);
            this.hitMask.bytes[target] = this.hitMask.bytes[target]! | (1 << (x & 7));
          }
        }
      }
    }
    this.hitEnabled = 1;
  }
  /** 0561b0 clips a copied target descriptor, then passes local coordinates to virtual30. */
  drawClipped(
    context: AokanaDisplayContext,
    clip: AokanaBitmapRectangle,
    key: number,
    alternate: AokanaDisplayContext | null,
  ): 0 | 1 {
    if (!this.inputActive()) return 1;
    const rectangle = this.inputRectangle(alternate?.bounds ?? 0),
      selected = alternate ?? context;
    if (!intersectAokanaBitmapRectangle(rectangle, selected.bounds)) return 0;
    const contained = aokanaRectangleContained(rectangle, clip) ? 1 : 0;
    if (intersectAokanaBitmapRectangle(rectangle, clip)) {
      const destination = {...selected.bitmap};
      if (alternate !== null)
        translateAokanaBitmapRectangle(rectangle, -alternate.bounds.left, -alternate.bounds.top);
      cropAokanaBitmap(destination, rectangle);
      if (alternate !== null)
        translateAokanaBitmapRectangle(rectangle, alternate.bounds.left, alternate.bounds.top);
      const position = this.effectivePosition();
      translateAokanaBitmapRectangle(rectangle, -position.x, -position.y);
      this.draw(destination, rectangle, key >>> 0);
    }
    return contained;
  }
}
