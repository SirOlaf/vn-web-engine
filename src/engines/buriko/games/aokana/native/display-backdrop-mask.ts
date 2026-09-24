import {
  cropAokanaBitmap,
  fillAokanaBitmap,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {transitionAokanaBitmap} from './bitmap-transition.js';
import {AokanaBackdrop} from './display-backdrop.js';
import type {AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

/** CDspObjBackF, ctor058850 and complete masked content draw0581B0. */
export class AokanaMaskedBackdrop extends AokanaBackdrop {
  private first = -1;
  private second = -1;
  private mask = -1;
  private firstId: number | undefined;
  private secondId: number | undefined;
  private maskId: number | undefined;
  private firstPosition: {x: number; y: number} | undefined;
  private secondPosition: {x: number; y: number} | undefined;
  private maskParameter: number | undefined;
  private coefficientMode = 0;
  private coefficientSelector = 0;
  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
  ) {
    super(environment, 4);
    this.blendMode = 1;
  }
  override move(x: number, y: number): void {
    this.check();
    this.firstPosition = {x: x | 0, y: y | 0};
  }
  override position(): {x: number; y: number} {
    this.check();
    if (this.firstPosition === undefined)
      throw new Error('Aokana masked backdrop reads unwritten position');
    return {...this.firstPosition};
  }
  /** 0585F0 validates selector against the OLD mode, before committing either field. */
  setCoefficientMode(mode: number, selector: number): 0 | 1 {
    this.check();
    if (this.coefficientMode !== 0 && selector >>> 0 >= 4) return 0;
    this.coefficientMode = mode | 0;
    this.coefficientSelector = selector | 0;
    return 1;
  }
  override setProperty(selector: number, first: number, second: number): number {
    if (selector >>> 0 === 0x40000000)
      return this.setCoefficientMode(first, second) === 0 ? 0xffff0002 : 0;
    return super.setProperty(selector, first, second);
  }
  private coefficient(): number {
    if (this.coefficientMode === 0) return 0;
    switch (this.coefficientSelector) {
      case 1:
        return (256 - this.effectiveBlendValue()) >>> 0;
      case 2:
        return this.getValueD8(0);
      case 3:
        return (256 - this.getValueD8(0)) >>> 0;
      default:
        return this.effectiveBlendValue();
    }
  }
  /** 0586E0 snapshots identities before publishing either source's state. */
  setSurfaces(
    firstX: number,
    firstY: number,
    first: number,
    secondX: number,
    secondY: number,
    second: number,
  ): 0 | 0x80000001 | 0x80000002 {
    this.check();
    if (this.surfaces.snapshot(first) === null) return 0x80000001;
    const special = this.special(second);
    if (!special && this.surfaces.snapshot(second) === null) return 0x80000002;
    this.firstId = this.surfaces.imageId(first);
    if (!special) this.secondId = this.surfaces.imageId(second);
    this.firstPosition = {x: firstX | 0, y: firstY | 0};
    this.secondPosition = {x: secondX | 0, y: secondY | 0};
    this.first = first | 0;
    this.second = second | 0;
    return 0;
  }
  setMask(mask: number, parameter: number): 0 | 0x80000003 | 0x80000004 {
    this.check();
    if (mask >>> 0 === 0xffffffff) {
      this.mask = -1;
      return 0;
    }
    const bitmap = this.surfaces.snapshot(mask);
    if (bitmap === null) return 0x80000003;
    if (bitmap.format !== 3) return 0x80000004;
    this.mask = mask | 0;
    this.maskParameter = parameter >>> 0;
    this.maskId = this.surfaces.imageId(mask);
    return 0;
  }
  private special(index: number): boolean {
    return (index - 0x7000) >>> 0 < 2 || index >>> 0 === 0x7fff || index >>> 0 === 0xffffffff;
  }
  override drawContent(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    const first = this.surfaces.snapshot(this.first);
    if (first === null || this.firstId !== this.surfaces.imageId(this.first)) return 0;
    const blend = this.effectiveBlendValue();
    if (this.firstPosition === undefined || this.secondPosition === undefined)
      throw new Error('Aokana masked backdrop draws with unwritten positions');
    const firstX = -(this.firstPosition.x + rectangle.left) | 0,
      firstY = -(this.firstPosition.y + rectangle.top) | 0;
    let mode = 0x80,
      fill = false,
      background = 0;
    let second: AokanaBitmap | null = null;
    if (!this.special(this.second)) {
      second = this.surfaces.snapshot(this.second);
      if (second === null || this.secondId !== this.surfaces.imageId(this.second)) return 0;
      mode = 1;
    } else if ((this.second - 0x7000) >>> 0 < 2) {
      mode = this.second === 0x7000 ? 0xc0 : 0xc1;
      background = this.second === 0x7000 ? 0 : 0xffffff;
      const display = this.environment.displayBitmap();
      fill =
        this.firstPosition.x < 0 ||
        this.firstPosition.y < 0 ||
        (first.width - this.firstPosition.x) >>> 0 < display.width >>> 0 ||
        (first.height - this.firstPosition.y) >>> 0 < display.height >>> 0 ||
        this.mask !== -1;
    }
    let mask: AokanaBitmap | null = null;
    if (this.mask !== -1) {
      mask = this.surfaces.snapshot(this.mask);
      if (mask === null || this.maskId !== this.surfaces.imageId(this.mask)) return 0;
    }
    if (second !== null)
      this.environment.compositor.draw(
        destination,
        -(this.secondPosition.x + rectangle.left) | 0,
        -(this.secondPosition.y + rectangle.top) | 0,
        second,
        0x80,
        0,
      );
    else if (fill) fillAokanaBitmap(destination, background);
    if (mask !== null) {
      if (this.maskParameter === undefined)
        throw new Error('Aokana masked backdrop reads unwritten mask parameter');
      cropAokanaBitmap(mask, rectangle);
      transitionAokanaBitmap(
        destination,
        firstX,
        firstY,
        first,
        mask,
        this.maskParameter,
        blend,
        this.coefficient(),
        true,
      );
    } else {
      if (second === null && !fill && blend !== 0) mode = 0xc0;
      this.environment.compositor.draw(destination, firstX, firstY, first, mode, blend);
    }
    return 1;
  }
}
