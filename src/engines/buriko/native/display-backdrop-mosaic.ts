import {fillBurikoBitmap, type BurikoBitmap, type BurikoBitmapRectangle} from './bitmap.js';
import {mosaicBurikoBitmap} from './bitmap-mosaic.js';
import {BurikoBackdrop} from './display-backdrop.js';
import type {BurikoDisplayObjectEnvironment} from './display-object.js';
import type {BurikoSurfaces} from './surfaces.js';

/** CDspObjBackMSC:059870 constructor and059590 complete two-source draw. */
export class BurikoMosaicBackdrop extends BurikoBackdrop {
  private first = -1;
  private second = -1;
  private firstId: number | undefined;
  private secondId: number | undefined;
  private selector = 0;
  private secondEnabled = 0;
  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
  ) {
    super(environment, 11);
  }
  setSurfaces(first: number, second: number): number {
    this.check();
    if (this.acceptsSurface(this.surfaces, first) === 0) return 0x80000001;
    const special = (second - 0x7000) >>> 0 < 2;
    if (!special && this.acceptsSurface(this.surfaces, second) === 0) return 0x80000002;
    this.firstId = this.surfaces.imageId(first);
    if (!special) this.secondId = this.surfaces.imageId(second);
    this.first = first | 0;
    this.second = second | 0;
    return 0;
  }
  setSelector(selector: number): number {
    this.check();
    if (selector >>> 0 >= 2) return 0x80000003;
    this.selector = selector >>> 0;
    return 0;
  }
  setSecondEnabled(enabled: number): number {
    this.check();
    if (enabled >>> 0 >= 2) return 0x80000004;
    this.secondEnabled = enabled >>> 0;
    return 0;
  }
  override drawContent(destination: BurikoBitmap, _rectangle: BurikoBitmapRectangle): 0 | 1 {
    this.check();
    const first = this.surfaces.snapshot(this.first);
    if (first === null || this.firstId !== this.surfaces.imageId(this.first)) return 0;
    const level = this.effectiveBlendValue();
    if (this.secondEnabled === 1) {
      if ((this.second - 0x7000) >>> 0 < 2)
        fillBurikoBitmap(destination, this.second === 0x7000 ? 0 : 0xffffff);
      else {
        const second = this.surfaces.snapshot(this.second);
        if (second !== null && this.secondId === this.surfaces.imageId(this.second))
          mosaicBurikoBitmap(
            this.environment.compositor,
            destination,
            second,
            (256 - level) | 0,
            this.selector,
            0,
          );
      }
    }
    mosaicBurikoBitmap(
      this.environment.compositor,
      destination,
      first,
      level,
      this.selector,
      this.secondEnabled === 1 ? level : 0,
    );
    return 1;
  }
}
