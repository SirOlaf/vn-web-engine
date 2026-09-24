import {cropAokanaBitmap, type AokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {AokanaBackdrop} from './display-backdrop.js';
import type {AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

/** CDspObjBackB:0574F0 constructor,0573F0 pair configuration,057280 content draw. */
export class AokanaBlendBackdrop extends AokanaBackdrop {
  private first = -1;
  private second = -1;
  private firstImageId: number | undefined;
  private secondImageId: number | undefined;
  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
  ) {
    super(environment, 2);
    this.blendMode = 1;
  }
  setSurfaces(first: number, second: number): 0 | 1 {
    this.check();
    if (this.acceptsSurface(this.surfaces, first) === 0) return 0;
    const special = (second - 0x7000) >>> 0 < 2;
    if (!special && this.acceptsSurface(this.surfaces, second) === 0) return 0;
    this.first = first | 0;
    this.second = second | 0;
    this.firstImageId = this.surfaces.imageId(first);
    if (!special) this.secondImageId = this.surfaces.imageId(second);
    return 1;
  }
  override drawContent(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    const first = this.surfaces.snapshot(this.first);
    if (first === null) return 0;
    if (this.firstImageId === undefined)
      throw new Error('Aokana blended backdrop reads unwritten first image ID');
    if (this.firstImageId !== this.surfaces.imageId(this.first)) return 0;
    const blend = this.effectiveBlendValue();
    let mode: number;
    if ((this.second - 0x7000) >>> 0 < 2) mode = this.second === 0x7000 ? 0xc0 : 0xc1;
    else {
      const second = this.surfaces.snapshot(this.second);
      if (second === null) return 0;
      if (this.secondImageId === undefined)
        throw new Error('Aokana blended backdrop reads unwritten second image ID');
      if (this.secondImageId !== this.surfaces.imageId(this.second)) return 0;
      cropAokanaBitmap(second, rectangle);
      this.environment.compositor.composite(destination, second, 0x80, 0, true);
      mode = 0xf0;
    }
    cropAokanaBitmap(first, rectangle);
    this.environment.compositor.composite(destination, first, mode, blend, true);
    return 1;
  }
}
