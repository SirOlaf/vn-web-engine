import {
  burikoBitmapRectangle,
  translateBurikoBitmapRectangle,
  intersectBurikoBitmapRectangle,
  cropBurikoBitmap,
} from './bitmap.js';
import {mixBurikoBitmaps} from './bitmap-mix.js';
import {transitionBurikoBitmap} from './bitmap-transition.js';
import {applyBurikoEffectorBlur, applyBurikoEffectorVectorMap} from './bitmap-display-filters.js';
import type {BurikoSurfaces} from './surfaces.js';

/** 0366C0/036570/0364D0 retain snapshots over the real shared surface backing. */
export class BurikoSurfaceEffects {
  constructor(readonly surfaces: BurikoSurfaces) {}
  transition(
    destination: number,
    x: number,
    y: number,
    source: number,
    mask: number,
    parameter: number,
    level: number,
  ): number {
    const output = this.surfaces.snapshot(destination);
    if (output === null) return 1;
    const input = this.surfaces.snapshot(source);
    if (input === null) return 2;
    const matte = this.surfaces.snapshot(mask);
    x |= 0;
    y |= 0;
    if (matte === null) {
      const area = burikoBitmapRectangle(output),
        other = burikoBitmapRectangle(input);
      translateBurikoBitmapRectangle(other, x, y);
      if (!intersectBurikoBitmapRectangle(area, other)) return 7;
      cropBurikoBitmap(output, area);
      translateBurikoBitmapRectangle(area, -x | 0, -y | 0);
      cropBurikoBitmap(input, area);
      mixBurikoBitmaps(output, output, input, level, this.surfaces.compositor.processing, 1);
      return 0;
    }
    const status = transitionBurikoBitmap(
      output,
      x,
      y,
      input,
      matte,
      parameter,
      level,
      0,
      false,
      this.surfaces.compositor.compatibility,
    );
    switch (status) {
      case 0:
        return 0;
      case 1:
        return 4;
      case 3:
        return 8;
      case 4:
        return 7;
      case 7:
        return 5;
      case 8:
        return 6;
      default:
        return 9;
    }
  }
  vector(
    destination: number,
    source: number,
    primary: number,
    secondary: number,
    level: number,
    bilinear: number,
  ): number {
    const output = this.surfaces.snapshot(destination);
    if (output === null) return 1;
    const input = this.surfaces.snapshot(source);
    if (input === null) return 2;
    const map = this.surfaces.snapshot(primary);
    if (map === null) return 4;
    const other = (secondary | 0) === -1 ? null : this.surfaces.snapshot(secondary);
    if ((secondary | 0) !== -1 && other === null) return 6;
    const status = applyBurikoEffectorVectorMap(
      this.surfaces.compositor,
      output,
      input,
      map,
      other,
      level,
      bilinear,
    );
    switch (status) {
      case 1:
        return 3;
      case 3:
        return 8;
      case 0xc:
        return 5;
      case 0xd:
        return 7;
      default:
        return 0;
    }
  }
  blur(destination: number, source: number, selector: number, strength: number): number {
    const output = this.surfaces.snapshot(destination);
    if (output === null) return 1;
    const input = this.surfaces.snapshot(source);
    if (input === null) return 2;
    const status = applyBurikoEffectorBlur(
      this.surfaces.compositor,
      output,
      input,
      selector,
      strength,
    );
    switch (status) {
      case 0:
        return 0;
      case 3:
        return 5;
      case 0xe:
        return 4;
      case 0xf:
        return 3;
      default:
        throw new Error('Buriko surface blur consumes an unwritten facade result');
    }
  }
}
