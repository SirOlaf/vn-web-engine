import {
  aokanaBitmapRectangle,
  translateAokanaBitmapRectangle,
  intersectAokanaBitmapRectangle,
  cropAokanaBitmap,
} from './bitmap.js';
import {mixAokanaBitmaps} from './bitmap-mix.js';
import {transitionAokanaBitmap} from './bitmap-transition.js';
import {applyAokanaEffectorBlur, applyAokanaEffectorVectorMap} from './bitmap-display-filters.js';
import type {AokanaSurfaces} from './surfaces.js';

/** 0366C0/036570/0364D0 retain snapshots over the real shared surface backing. */
export class AokanaSurfaceEffects {
  constructor(readonly surfaces: AokanaSurfaces) {}
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
      const area = aokanaBitmapRectangle(output),
        other = aokanaBitmapRectangle(input);
      translateAokanaBitmapRectangle(other, x, y);
      if (!intersectAokanaBitmapRectangle(area, other)) return 7;
      cropAokanaBitmap(output, area);
      translateAokanaBitmapRectangle(area, -x | 0, -y | 0);
      cropAokanaBitmap(input, area);
      mixAokanaBitmaps(output, output, input, level, this.surfaces.compositor.processing, 1);
      return 0;
    }
    const status = transitionAokanaBitmap(output, x, y, input, matte, parameter, level, 0, false);
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
    const status = applyAokanaEffectorVectorMap(
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
    const status = applyAokanaEffectorBlur(
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
        throw new Error('Aokana surface blur consumes an unwritten facade result');
    }
  }
}
