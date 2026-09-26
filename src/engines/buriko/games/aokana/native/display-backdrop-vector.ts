import {cropAokanaBitmap, type AokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {applyAokanaEffectorVectorMap} from './bitmap-display-filters.js';
import {AokanaBackdrop} from './display-backdrop.js';
import type {AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

/** CDspObjBackDST:058160,057FF0,057E20 over the shared04ABB0 vector-map owner. */
export class AokanaVectorBackdrop extends AokanaBackdrop {
  private source = -1;
  private primary = -1;
  private secondary = -1;
  private sourceId: number | undefined;
  private primaryId: number | undefined;
  private secondaryId: number | undefined;
  private sampling: number | undefined;
  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
  ) {
    super(environment, 6);
  }
  /** 057F90 uses the global display descriptor, not cached object geometry. */
  private acceptsMap(bitmap: AokanaBitmap): boolean {
    if (bitmap.format !== 4) return false;
    const display = this.environment.displayBitmap();
    return bitmap.width === display.width && bitmap.height === display.height;
  }
  setSurfaces(source: number, primary: number, secondary: number): number {
    this.check();
    const image = this.surfaces.snapshot(source);
    if (image === null) return 0x80000001;
    if (this.acceptsBitmap(image) === 0) return 0x80000002;
    const first = this.surfaces.snapshot(primary);
    if (first === null) return 0x80000003;
    if (!this.acceptsMap(first)) return 0x80000004;
    if (secondary >>> 0 !== 0xffffffff) {
      const second = this.surfaces.snapshot(secondary);
      if (second === null) return 0x80000005;
      if (!this.acceptsMap(second)) return 0x80000006;
    }
    this.source = source | 0;
    this.primary = primary | 0;
    this.secondary = secondary | 0;
    this.sourceId = this.surfaces.imageId(source);
    this.primaryId = this.surfaces.imageId(primary);
    this.secondaryId = this.surfaces.imageId(secondary);
    return 0;
  }
  setSampling(sampling: number): void {
    this.check();
    this.sampling = sampling | 0;
  }
  override drawContent(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    const source = this.surfaces.snapshot(this.source);
    if (source === null || this.sourceId !== this.surfaces.imageId(this.source)) return 0;
    const primary = this.surfaces.snapshot(this.primary);
    if (primary === null || this.primaryId !== this.surfaces.imageId(this.primary)) return 0;
    let secondary: AokanaBitmap | null = null;
    if (this.secondary !== -1) {
      secondary = this.surfaces.snapshot(this.secondary);
      if (secondary === null || this.secondaryId !== this.surfaces.imageId(this.secondary))
        return 0;
    }
    cropAokanaBitmap(source, rectangle);
    cropAokanaBitmap(primary, rectangle);
    if (secondary !== null) cropAokanaBitmap(secondary, rectangle);
    const effect = this.effectiveBlendValue();
    if (this.sampling === undefined)
      throw new Error('Aokana vector backdrop reads unwritten sampling option');
    applyAokanaEffectorVectorMap(
      this.environment.compositor,
      destination,
      source,
      primary,
      secondary,
      effect,
      this.sampling,
    );
    return 1;
  }
}
