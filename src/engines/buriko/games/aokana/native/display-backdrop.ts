import {cropAokanaBitmap, type AokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {AokanaDisplayObject, AokanaDisplayObjectEnvironment} from './display-object.js';
import {AokanaSurfaces} from './surfaces.js';

/** CDspObjBack, constructor057210 and its four additional virtuals F0..108. */
export class AokanaBackdrop extends AokanaDisplayObject {
  contentEnabled = 0;
  constructor(
    environment: AokanaDisplayObjectEnvironment,
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
      AokanaDisplayObject.prototype.configureGeometry.call(this, bitmap.width, bitmap.height);
    AokanaDisplayObject.prototype.setActivation.call(this, 1);
  }
  override invalidate(): void {
    this.check();
    if (this.contentEnabled !== 0) this.environment.damage.force();
  }
  override inputRectangle(reference: 0 | AokanaBitmapRectangle): AokanaBitmapRectangle {
    this.check();
    return reference === 0 ? this.localRectangle() : {...reference};
  }
  /** Native0571c0 is the actual empty backdrop move override. */
  override move(_x: number, _y: number): void {
    this.check();
  }
  override draw(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle, _key: number): void {
    this.check();
    if (this.contentEnabled !== 0 && this.drawContent(destination, rectangle) !== 0) return;
    clearAokanaBitmap(destination);
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
  acceptsBitmap(bitmap: AokanaBitmap): 0 | 1 {
    this.check();
    const display = this.environment.displayBitmap();
    return bitmap.width === display.width &&
      bitmap.height === display.height &&
      bitmap.format === display.format
      ? 1
      : 0;
  }
  /** 057010 is the actual complete base virtual108, returning zero. */
  drawContent(_destination: AokanaBitmap, _rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    return 0;
  }
  acceptsSurface(surfaces: AokanaSurfaces, index: number): 0 | 1 {
    this.check();
    const bitmap = surfaces.snapshot(index);
    return bitmap === null ? 0 : this.acceptsBitmap(bitmap);
  }
}

/** CDspObjBackN, constructor0599f0 and content draw0598d0. */
export class AokanaNormalBackdrop extends AokanaBackdrop {
  surface = -1;
  private imageId: number | undefined;
  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
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
  override drawContent(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    const bitmap = this.surfaces.snapshot(this.surface);
    if (bitmap === null) return 0;
    const imageId = this.surfaces.imageId(this.surface);
    if (this.imageId === undefined)
      throw new Error('Aokana normal backdrop reads unwritten image ID');
    if (this.imageId !== imageId) return 0;
    cropAokanaBitmap(bitmap, rectangle);
    this.environment.compositor.composite(destination, bitmap, 0x80, 0, true);
    return 1;
  }
}
