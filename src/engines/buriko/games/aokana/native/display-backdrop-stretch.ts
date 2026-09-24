import type {AokanaBitmap, AokanaBitmapRectangle} from './bitmap.js';
import {stretchCenteredAokanaBitmap} from './bitmap-centered-stretch.js';
import {AokanaBackdrop} from './display-backdrop.js';
import type {AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

const cvtt32 = (value: number): number => {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -0x80000000 || integer > 0x7fffffff
    ? -0x80000000
    : integer | 0;
};
const cvtt64Low32 = (value: number): number => {
  if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63) return 0;
  return Number(BigInt.asIntN(32, BigInt(Math.trunc(value))));
};

/** CDspObjBackSTR:05AB60; literal05A800 Q16 interpolation and centered stretch. */
export class AokanaStretchBackdrop extends AokanaBackdrop {
  private source = -1;
  private imageId: number | undefined;
  private origin: {x: number; y: number} | undefined;
  private extent: {width: number; height: number} | undefined;
  private target: {x: number; y: number; width: number; height: number} | undefined;
  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
  ) {
    super(environment, 9);
  }
  setSurface(index: number): number {
    this.check();
    if (this.surfaces.snapshot(index) === null) return 0x80000001;
    this.source = index | 0;
    this.imageId = this.surfaces.imageId(index);
    return 0;
  }
  setExtent(width: number, height: number): number {
    this.check();
    if (width >>> 0 <= 1 || height >>> 0 <= 1) return 0x80000002;
    this.extent = {width: width >>> 0, height: height >>> 0};
    return 0;
  }
  override move(x: number, y: number): void {
    this.check();
    this.origin = {x: x | 0, y: y | 0};
  }
  override position(): {x: number; y: number} {
    this.check();
    if (this.origin === undefined)
      throw new Error('Aokana stretch backdrop reads unwritten Q16 position');
    return {...this.origin};
  }
  setTarget(x: number, y: number, width: number, height: number): number {
    this.check();
    if (width >>> 0 <= 1 || height >>> 0 <= 1) return 0x80000002;
    this.target = {x: x | 0, y: y | 0, width: width >>> 0, height: height >>> 0};
    return 0;
  }
  override setProperty(selector: number, first: number, second: number): number {
    if (selector >>> 0 !== 0x102) return super.setProperty(selector, first, second);
    return this.setTarget((first << 16) >> 16, first >> 16, second & 65535, second >>> 16) === 0
      ? 0
      : 0xffff0002;
  }
  override drawContent(destination: AokanaBitmap, _rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    const source = this.surfaces.snapshot(this.source);
    if (source === null || this.imageId !== this.surfaces.imageId(this.source)) return 0;
    if (this.origin === undefined || this.extent === undefined || this.target === undefined)
      throw new Error('Aokana stretch backdrop draws before base and target window configuration');
    const blend = this.getBlendValue() >>> 0;
    const width =
      ((this.target.width - this.extent.width) | 0) * blend * 0.00390625 + this.extent.width;
    const height =
      ((this.target.height - this.extent.height) | 0) * blend * 0.00390625 + this.extent.height;
    const x = cvtt32(
      (((this.target.x << 16) - this.origin.x) | 0) * blend * 0.00390625 + this.origin.x,
    );
    const y = cvtt32(
      (((this.target.y << 16) - this.origin.y) | 0) * blend * 0.00390625 + this.origin.y,
    );
    stretchCenteredAokanaBitmap(
      this.environment.compositor,
      destination,
      source,
      x,
      y,
      cvtt64Low32(width * 65536),
      cvtt64Low32(height * 65536),
      cvtt64Low32((Math.imul(destination.width, 0x10004) >>> 0) / width),
      cvtt64Low32((Math.imul(destination.height, 0x10004) >>> 0) / height),
    );
    return 1;
  }
}
