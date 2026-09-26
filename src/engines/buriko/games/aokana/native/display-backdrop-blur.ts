import {cropAokanaBitmap, type AokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {applyAokanaEffectorBlur} from './bitmap-display-filters.js';
import {AokanaBackdrop} from './display-backdrop.js';
import type {AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

/** CDspObjBackGRD:058A40/058980/058960/0588C0 with the actual04AAD0 blur owner. */
export class AokanaBlurBackdrop extends AokanaBackdrop {
  private source = -1;
  private imageId: number | undefined;
  private selector: number | undefined;
  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
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
  override drawContent(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    const source = this.surfaces.snapshot(this.source);
    if (source === null || this.imageId !== this.surfaces.imageId(this.source)) return 0;
    cropAokanaBitmap(source, rectangle);
    const effect = this.effectiveBlendValue();
    if (this.selector === undefined)
      throw new Error('Aokana blur backdrop reads unwritten selector');
    applyAokanaEffectorBlur(
      this.environment.compositor,
      destination,
      source,
      this.selector,
      effect,
    );
    return 1;
  }
}
