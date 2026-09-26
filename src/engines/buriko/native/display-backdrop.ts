import {
  burikoBitmapRectangle,
  cropBurikoBitmap,
  translateBurikoBitmapRectangle,
  type BurikoBitmap,
  type BurikoBitmapRectangle,
} from './bitmap.js';
import {clearBurikoBitmap} from './bitmap-copy.js';
import {displaceBurikoBitmap} from './bitmap-displacement.js';
import {BurikoDisplayObject, BurikoDisplayObjectEnvironment} from './display-object.js';
import {BurikoSurfaces} from './surfaces.js';

/** CDspObjBack, constructor057210 and its four additional virtuals F0..108. */
export class BurikoBackdrop extends BurikoDisplayObject {
  contentEnabled = 0;
  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly backdropType: number,
  ) {
    super(environment, 0, 0, 1);
    // During the native base constructor the installed vtable is CDspObjBack, not its final subtype.
    const bitmap = environment.displayBitmap();
    if (
      bitmap.width !== this.bitmap.width ||
      bitmap.height !== this.bitmap.height ||
      bitmap.format !== this.bitmap.format
    )
      BurikoDisplayObject.prototype.configureGeometry.call(this, bitmap.width, bitmap.height);
    BurikoDisplayObject.prototype.setActivation.call(this, 1);
  }
  override invalidate(): void {
    this.check();
    if (this.contentEnabled !== 0) this.environment.damage.force();
  }
  override inputRectangle(reference: 0 | BurikoBitmapRectangle): BurikoBitmapRectangle {
    this.check();
    return reference === 0 ? this.localRectangle() : {...reference};
  }
  /** Native0571c0 is the actual empty backdrop move override. */
  override move(_x: number, _y: number): void {
    this.check();
  }
  override draw(destination: BurikoBitmap, rectangle: BurikoBitmapRectangle, _key: number): void {
    this.check();
    if (this.contentEnabled !== 0 && this.drawContent(destination, rectangle) !== 0) return;
    clearBurikoBitmap(destination);
  }
  setContentEnabled(value: number): void {
    this.check();
    this.contentEnabled = value | 0;
  }
  /** 0570c0 returns one on a geometry change even when virtual E8 itself returns zero. */
  resizeToDisplay(): 0 | 1 {
    this.check();
    const bitmap = this.environment.displayBitmap();
    if (
      bitmap.width === this.bitmap.width &&
      bitmap.height === this.bitmap.height &&
      bitmap.format === this.bitmap.format
    )
      return 0;
    this.configureGeometry(bitmap.width, bitmap.height);
    return 1;
  }
  acceptsBitmap(bitmap: BurikoBitmap): 0 | 1 {
    this.check();
    const display = this.environment.displayBitmap();
    return bitmap.width === display.width &&
      bitmap.height === display.height &&
      bitmap.format === display.format
      ? 1
      : 0;
  }
  /** 057010 is the actual complete base virtual108, returning zero. */
  drawContent(_destination: BurikoBitmap, _rectangle: BurikoBitmapRectangle): 0 | 1 {
    this.check();
    return 0;
  }
  acceptsSurface(surfaces: BurikoSurfaces, index: number): 0 | 1 {
    this.check();
    const bitmap = surfaces.snapshot(index);
    return bitmap === null ? 0 : this.acceptsBitmap(bitmap);
  }
}

/** CDspObjBackN, constructor0599f0 and content draw0598d0. */
export class BurikoNormalBackdrop extends BurikoBackdrop {
  surface = -1;
  private imageId: number | undefined;
  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
  ) {
    super(environment, 1);
  }
  /** 059960 tests current display geometry before retaining slot and stable image identity. */
  setSurface(index: number): 0 | 1 {
    this.check();
    if (this.acceptsSurface(this.surfaces, index) === 0) return 0;
    this.surface = index | 0;
    this.imageId = this.surfaces.imageId(index);
    return 1;
  }
  override drawContent(destination: BurikoBitmap, rectangle: BurikoBitmapRectangle): 0 | 1 {
    this.check();
    const bitmap = this.surfaces.snapshot(this.surface);
    if (bitmap === null) return 0;
    const imageId = this.surfaces.imageId(this.surface);
    if (this.imageId === undefined)
      throw new Error('Buriko normal backdrop reads unwritten image ID');
    if (this.imageId !== imageId) return 0;
    cropBurikoBitmap(bitmap, rectangle);
    this.environment.compositor.composite(destination, bitmap, 0x80, 0, true);
    return 1;
  }
}

export type BurikoRippleBackdropStatus =
  0 | 0x80000001 | 0x80000002 | 0x80000003 | 0x80000004 | 0x80000005 | 0x80000006 | 0x80000007;

/** CDspObjBackRPL, constructor05A000 and its complete coefficient/displacement family. */
export class BurikoRippleBackdrop extends BurikoBackdrop {
  sourceSurface = -1;
  mapSurface = -1;
  sampling = 0;
  private sourceImageId: number | undefined;
  private mapImageId: number | undefined;
  private samplePosition = {x: 0, y: 0};
  private gradientCount: number | undefined;
  private coefficientSlot: number | undefined;
  private coefficientOffset: number | undefined;
  private expanded: Uint32Array | null = null;

  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
  ) {
    super(environment, 8);
  }

  /** 059FA0/059F80 use the backdrop position as the source sampling offset. */
  override move(x: number, y: number): void {
    this.check();
    this.samplePosition = {x: x | 0, y: y | 0};
  }
  override position(): {x: number; y: number} {
    this.check();
    return {...this.samplePosition};
  }
  /** 059F70 is the actual empty offset override. */
  override setOffset(_x: number, _y: number): void {
    this.check();
  }

  /** 059CC0 accepts a source solely when its format equals the current display format. */
  override acceptsBitmap(bitmap: BurikoBitmap): 0 | 1 {
    this.check();
    return bitmap.format === this.bitmap.format ? 1 : 0;
  }

  /** 059EE0 retains the source slot and stable image identity after validation. */
  setSourceSurface(index: number): 0 | 0x80000001 | 0x80000002 {
    this.check();
    const bitmap = this.surfaces.snapshot(index);
    if (bitmap === null) return 0x80000001;
    if (this.acceptsBitmap(bitmap) === 0) return 0x80000002;
    this.sourceSurface = index | 0;
    this.sourceImageId = this.surfaces.imageId(index);
    return 0;
  }

  /** 059B70 requires a screen-covering six-byte vector/distance map. */
  private acceptsMap(bitmap: BurikoBitmap): 0 | 1 {
    return bitmap.format === 6 &&
      bitmap.width >>> 0 >= this.bitmap.width >>> 0 &&
      bitmap.height >>> 0 >= this.bitmap.height >>> 0
      ? 1
      : 0;
  }

  /** 059D90 allocates/query-validates before publishing the new map and coefficient state. */
  configureMap(
    mapSurface: number,
    gradientCount: number,
    coefficientSlot: number,
    blend: number,
  ): 0 | 0x80000003 | 0x80000004 | 0x80000005 | 0x80000006 | 0x80000007 {
    this.check();
    const map = this.surfaces.snapshot(mapSurface);
    if (map === null) return 0x80000003;
    if (this.acceptsMap(map) === 0) return 0x80000004;
    gradientCount >>>= 0;
    if (gradientCount === 0) return 0x80000005;
    const expanded = new Uint32Array(Math.imul(gradientCount, 4) >>> 0),
      query = this.surfaces.coefficientTables.query(coefficientSlot, 0, gradientCount);
    if (query.status !== 0) return 0x80000006;
    if (query.available === 0) return 0x80000007;
    this.mapSurface = mapSurface | 0;
    this.mapImageId = this.surfaces.imageId(mapSurface);
    this.gradientCount = gradientCount;
    this.expanded = expanded;
    this.coefficientSlot = coefficientSlot | 0;
    this.coefficientOffset = 0;
    this.setBlendValue(blend);
    return 0;
  }

  /** 059D40 updates the base value first, then synchronously refreshes count*4 DWORDs. */
  override setBlendValue(value: number): void {
    super.setBlendValue(value);
    if (
      this.expanded === null ||
      this.gradientCount === undefined ||
      this.coefficientSlot === undefined ||
      this.coefficientOffset === undefined
    )
      throw new Error('Buriko ripple backdrop expands before map configuration');
    this.surfaces.coefficientTables.expand(
      this.expanded,
      this.coefficientSlot,
      this.coefficientOffset,
      value,
      this.gradientCount,
    );
  }

  /** 059BF0 validates a new offset and uses values above 256 as keep-current sentinels. */
  setCoefficientOffset(offset: number, blend: number): 0 | 0x80000006 | 0x80000007 {
    this.check();
    if (this.gradientCount === undefined || this.coefficientSlot === undefined)
      throw new Error('Buriko ripple backdrop changes coefficient offset before configuration');
    const query = this.surfaces.coefficientTables.query(
      this.coefficientSlot,
      offset,
      this.gradientCount,
    );
    if (query.status !== 0) return 0x80000006;
    if (query.available === 0) return 0x80000007;
    this.coefficientOffset = offset | 0;
    if (blend >>> 0 > 0x100) blend = this.getBlendValue();
    this.setBlendValue(blend);
    return 0;
  }

  override setProperty(selector: number, first: number, second: number): number {
    this.check();
    if (selector >>> 0 === 0xff) {
      this.sampling = first | 0;
      return 0;
    }
    if (selector >>> 0 === 0x100)
      return this.setCoefficientOffset(first, second) === 0 ? 0 : 0xffff0002;
    return super.setProperty(selector, first, second);
  }

  /** 059A30 verifies both image identities, crops by offset/damage, then dispatches 048640. */
  override drawContent(destination: BurikoBitmap, rectangle: BurikoBitmapRectangle): 0 | 1 {
    this.check();
    const fullSource = this.surfaces.snapshot(this.sourceSurface);
    if (fullSource === null || this.sourceImageId !== this.surfaces.imageId(this.sourceSurface))
      return 0;
    const map = this.surfaces.snapshot(this.mapSurface);
    if (map === null || this.mapImageId !== this.surfaces.imageId(this.mapSurface)) return 0;
    if (this.expanded === null)
      throw new Error('Buriko ripple backdrop draws before coefficient configuration');
    const source = {...fullSource},
      sourceRectangle = burikoBitmapRectangle(fullSource);
    translateBurikoBitmapRectangle(sourceRectangle, this.samplePosition.x, this.samplePosition.y);
    cropBurikoBitmap(source, sourceRectangle);
    cropBurikoBitmap(source, rectangle);
    cropBurikoBitmap(map, rectangle);
    displaceBurikoBitmap(
      this.environment.compositor,
      destination,
      source,
      fullSource,
      map,
      this.expanded,
      this.sampling,
    );
    return 1;
  }

  override dispose(): void {
    this.check();
    this.expanded = null;
    super.dispose();
  }
}
