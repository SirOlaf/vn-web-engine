import {cropAokanaBitmap, type AokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {applyAokanaBitmapColorEffect} from './bitmap-color-effects.js';
import {applyAokanaFilterMaskColor} from './bitmap-display-filters.js';
import {AokanaDisplayObject, type AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

export type AokanaDisplayFilterStatus = 0 | 0x80000001 | 0x80000002 | 0x80000003;

/** CDspObjFilter, the size-188 full-display color/mask filter constructed by 05BDB0. */
export class AokanaDisplayFilter extends AokanaDisplayObject {
  filterMode = 0;
  operation = 0;
  color = 0;
  maskSurface = -1;
  maskShift = 0;
  private maskImageId = -1;

  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
    creationOrder: number,
  ) {
    super(environment, 7, creationOrder, 1);
    this.blendMode = 0xc0;
    this.configureColor(0, 0, 0, 0);
    this.resizeToDisplay();
  }

  /** 05BBB0 publishes all scalar color-filter fields before selecting mode zero. */
  configureColor(operation: number, color: number, blendValue: number, layer: number): void {
    this.check();
    this.operation = operation | 0;
    this.color = color | 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    this.filterMode = 0;
  }

  /** 05BAE0 selects mode one only after an exact screen-sized format-three mask succeeds. */
  configureMask(maskSurface: number, shift: number): AokanaDisplayFilterStatus {
    this.check();
    maskSurface |= 0;
    if (maskSurface === -1) {
      this.filterMode = 0;
      return 0;
    }
    const mask = this.surfaces.snapshot(maskSurface);
    if (mask === null) return 0x80000001;
    if (mask.format !== 3) return 0x80000002;
    const display = this.environment.displayContext?.bitmap;
    if (display === undefined || mask.width !== display.width || mask.height !== display.height)
      return 0x80000003;
    this.maskSurface = maskSurface;
    this.maskShift = shift | 0;
    this.maskImageId = this.surfaces.imageId(maskSurface);
    this.filterMode = 1;
    return 0;
  }

  /** 05BA70 disables a stale mask before adopting the current display descriptor. */
  resizeToDisplay(): 0 | 1 {
    this.check();
    const display = this.environment.displayContext?.bitmap;
    if (display === undefined) return 0;
    if (
      this.bitmap.width === display.width &&
      this.bitmap.height === display.height &&
      this.bitmap.format === display.format
    )
      return 0;
    this.filterMode = 0;
    this.configureGeometry(display.width, display.height);
    return 1;
  }

  /** 05BC00 mutates the renderer destination itself; no private filter bitmap is owned. */
  override draw(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle, _key: number): void {
    this.check();
    const blendValue = this.effectiveBlendValue();
    if (this.filterMode === 0) {
      switch (this.operation) {
        case 0:
          applyAokanaBitmapColorEffect(
            this.environment.compositor,
            destination,
            destination,
            3,
            this.color,
            blendValue,
          );
          break;
        case 1:
          applyAokanaBitmapColorEffect(
            this.environment.compositor,
            destination,
            destination,
            this.color === 0 ? 5 : 4,
            this.color === 0 ? 0xffffff : this.color,
            this.color === 0 ? 0x100 : blendValue,
          );
          break;
        case 2:
          applyAokanaBitmapColorEffect(
            this.environment.compositor,
            destination,
            destination,
            2,
            this.color,
            blendValue,
          );
          break;
        case 3:
          applyAokanaBitmapColorEffect(
            this.environment.compositor,
            destination,
            destination,
            1,
            this.color,
            blendValue,
          );
          break;
      }
      return;
    }
    if (this.filterMode !== 1) return;
    const mask = this.surfaces.snapshot(this.maskSurface);
    if (mask === null || this.surfaces.imageId(this.maskSurface) !== this.maskImageId) return;
    cropAokanaBitmap(mask, rectangle);
    applyAokanaFilterMaskColor(destination, this.color, mask, this.maskShift, blendValue);
  }
}
