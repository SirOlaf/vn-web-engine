import {cropBurikoBitmap, type BurikoBitmap, type BurikoBitmapRectangle} from './bitmap.js';
import {applyBurikoEffectorBlur} from './bitmap-display-filters.js';
import {BurikoBackdrop} from './display-backdrop.js';
import type {BurikoDisplayObjectEnvironment} from './display-object.js';
import type {BurikoSurfaces} from './surfaces.js';

/** CDspObjBackGRD:058A40/058980/058960/0588C0 with the actual04AAD0 blur owner. */
export class BurikoBlurBackdrop extends BurikoBackdrop {
  private source = -1;
  private imageId: number | undefined;
  private selector: number | undefined;
  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
  ) {
    super(environment, 7);
  }
  setSurface(index: number): number {
    this.check();
    const source = this.surfaces.snapshot(index);
    if (source === null) return 0x80000001;
    if (this.acceptsBitmap(source) === 0) return 0x80000002;
    this.source = index | 0;
    this.imageId = this.surfaces.imageId(index);
    return 0;
  }
  setSelector(selector: number): number {
    this.check();
    if (selector >>> 0 >= 2) return 0x80000003;
    this.selector = selector >>> 0;
    return 0;
  }
  override drawContent(destination: BurikoBitmap, rectangle: BurikoBitmapRectangle): 0 | 1 {
    this.check();
    const source = this.surfaces.snapshot(this.source);
    if (source === null || this.imageId !== this.surfaces.imageId(this.source)) return 0;
    cropBurikoBitmap(source, rectangle);
    const effect = this.effectiveBlendValue();
    if (this.selector === undefined)
      throw new Error('Buriko blur backdrop reads unwritten selector');
    applyBurikoEffectorBlur(
      this.environment.compositor,
      destination,
      source,
      this.selector,
      effect,
    );
    return 1;
  }
}
