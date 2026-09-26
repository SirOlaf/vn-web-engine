import {
  cropBurikoBitmap,
  intersectBurikoBitmapRectangle,
  translateBurikoBitmapRectangle,
  type BurikoBitmap,
  type BurikoBitmapRectangle,
} from './bitmap.js';
import {BurikoBackdrop} from './display-backdrop.js';
import type {BurikoDisplayObjectEnvironment} from './display-object.js';
import type {BurikoSurfaces} from './surfaces.js';

/** CDspObjBackS:05A7A0, four-surface pan configuration05A680 and draw05A370. */
export class BurikoPanBackdrop extends BurikoBackdrop {
  private indices = [-1, -1, -1, -1];
  private imageIds: number[] | undefined;
  private pan: {x: number; y: number} | undefined;
  private quadrants: BurikoBitmapRectangle[] = [];
  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
  ) {
    super(environment, 3);
    this.resizeToDisplay();
  }
  /** 05A570 rebuilds the four rectangles even when the base reports no resize. */
  override resizeToDisplay(): 0 | 1 {
    const result = super.resizeToDisplay();
    const display = this.environment.displayBitmap(),
      width = display.width,
      height = display.height;
    this.quadrants = [
      {left: 0, top: 0, right: (width - 1) | 0, bottom: (height - 1) | 0},
      {left: width, top: 0, right: (width * 2 - 1) | 0, bottom: (height - 1) | 0},
      {left: 0, top: height, right: (width - 1) | 0, bottom: (height * 2 - 1) | 0},
      {left: width, top: height, right: (width * 2 - 1) | 0, bottom: (height * 2 - 1) | 0},
    ];
    return result;
  }
  /** 05A620 permits the inclusive far edge of each source image. */
  setPan(x: number, y: number): 0 | 1 {
    this.check();
    x |= 0;
    y |= 0;
    const display = this.environment.displayBitmap();
    if (x < 0 || y < 0 || x > display.width || y > display.height) return 0;
    this.pan = {x, y};
    return 1;
  }
  override move(x: number, y: number): void {
    this.setPan(x, y);
  }
  setSurfaces(first: number, second: number, third: number, fourth: number): 0 | 1 {
    this.check();
    const indices = [first, second, third, fourth].map((value) => value | 0);
    for (const index of indices) if (this.acceptsSurface(this.surfaces, index) === 0) return 0;
    this.indices = indices;
    this.imageIds = indices.map((index) => this.surfaces.imageId(index));
    return 1;
  }
  override drawContent(destination: BurikoBitmap, rectangle: BurikoBitmapRectangle): 0 | 1 {
    this.check();
    const sources: BurikoBitmap[] = [];
    for (let index = 0; index < 4; index++) {
      const source = this.surfaces.snapshot(this.indices[index]!);
      if (source === null) return 0;
      if (this.imageIds === undefined)
        throw new Error('Buriko pan backdrop reads unwritten image IDs');
      if (this.imageIds[index] !== this.surfaces.imageId(this.indices[index]!)) return 0;
      sources.push(source);
    }
    if (this.pan === undefined) throw new Error('Buriko pan backdrop reads unwritten position');
    for (let index = 0; index < 4; index++) {
      const quadrant = this.quadrants[index]!,
        area = {...rectangle};
      translateBurikoBitmapRectangle(area, this.pan.x - quadrant.left, this.pan.y - quadrant.top);
      if (!intersectBurikoBitmapRectangle(area, this.quadrants[0]!)) continue;
      const output = {...destination},
        source = sources[index]!;
      cropBurikoBitmap(source, area);
      translateBurikoBitmapRectangle(
        area,
        quadrant.left - this.pan.x - rectangle.left,
        quadrant.top - this.pan.y - rectangle.top,
      );
      cropBurikoBitmap(output, area);
      this.environment.compositor.composite(output, source, 0x80, 0, true);
    }
    return 1;
  }
}
