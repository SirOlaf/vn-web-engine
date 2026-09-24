import {nativeDisplayEasing} from '../bp/opcodes/native-math.js';
import {allocateAokanaBitmap, type AokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {transformAokanaBitmap, blendTransformedAokanaBitmap} from './bitmap-affine.js';
import {AokanaBackdrop} from './display-backdrop.js';
import {
  AokanaDisplayObject,
  type AokanaDisplayObjectEnvironment,
  type AokanaDisplayPoint,
} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

const ENABLED = 0,
  ACTIVE = 1,
  X = 2,
  Y = 3,
  MODE = 4,
  LEVEL = 5,
  SOURCE = 6,
  IMAGE = 7,
  PIVOT_X = 8,
  PIVOT_Y = 9,
  ANGLE = 10,
  SCALE_X = 11,
  SCALE_Y = 12,
  PIVOT_EASING = 13,
  ANGLE_EASING = 14,
  SCALE_EASING = 15,
  DELTA_X = 16,
  DELTA_Y = 17,
  DELTA_ANGLE = 18,
  DELTA_SCALE_X = 19,
  DELTA_SCALE_Y = 20,
  SAMPLING = 21;
const INVALID_LAYER = 0x80000001;
function interpolate(base: number, delta: number, weight: number): number {
  return (base + Number(BigInt.asIntN(32, (BigInt(delta | 0) * BigInt(weight | 0)) >> 16n))) | 0;
}
function scale(base: number, delta: number, weight: number): number {
  const start = 65536 / (base | 0),
    end = 65536 / ((base + delta) | 0);
  const value = 65536 / ((end - start) * (weight * 0.0000152587890625) + start);
  return !Number.isFinite(value) || value < -2147483648 || value >= 2147483648
    ? -2147483648
    : Math.trunc(value) | 0;
}

/** CDspObjBackML,059530: eight zero-initialized native 22-DWORD records. */
export class AokanaMultilayerBackdrop extends AokanaBackdrop {
  private selected = 0;
  private readonly layers = Array.from({length: 8}, () => new Int32Array(22));
  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
  ) {
    super(environment, 12);
    this.positionUsesCoordinates = 0;
  }
  private layerRecord(index: number): Int32Array | null {
    this.check();
    return this.layers[index >>> 0] ?? null;
  }
  selectLayer(index: number): number {
    if (this.layerRecord(index) === null) return INVALID_LAYER;
    this.selected = index >>> 0;
    return 0;
  }
  setLayerActivation(index: number, value: number): number {
    const layer = this.layerRecord(index);
    if (layer === null) return INVALID_LAYER;
    layer[ACTIVE] = value;
    return 0;
  }
  layerActivation(index: number): number {
    const layer = this.layerRecord(index);
    if (layer === null) throw new Error('Aokana multilayer activation reads invalid layer');
    return layer[ACTIVE]!;
  }
  setLayerPosition(index: number, x: number, y: number): number {
    const layer = this.layerRecord(index);
    if (layer === null) return INVALID_LAYER;
    if (this.coordinateRounding !== 0) {
      x = (x + 0x8000) & 0xffff0000;
      y = (y + 0x8000) & 0xffff0000;
    }
    layer[X] = x;
    layer[Y] = y;
    return 0;
  }
  setLayerMode(index: number, value: number): number {
    return this.setLayerWords(index, MODE, value);
  }
  setLayerLevel(index: number, value: number): number {
    return this.setLayerWords(index, LEVEL, value);
  }
  private setLayerWords(index: number, offset: number, ...values: number[]): number {
    const layer = this.layerRecord(index);
    if (layer === null) return INVALID_LAYER;
    values.forEach((value, i) => {
      layer[offset + i] = value;
    });
    return 0;
  }
  setLayerSurface(index: number, surface: number, pivotX: number, pivotY: number): number {
    const layer = this.layerRecord(index);
    if (layer === null) return INVALID_LAYER;
    if ((surface | 0) === -1) {
      layer[ENABLED] = 0;
      return 0;
    }
    if (this.surfaces.snapshot(surface) === null) return 0x80000002;
    layer[ENABLED] = 1;
    layer[SOURCE] = surface;
    layer[IMAGE] = this.surfaces.imageId(surface);
    layer[PIVOT_X] = pivotX;
    layer[PIVOT_Y] = pivotY;
    layer[DELTA_X] = layer[DELTA_Y] = 0;
    return 0;
  }
  setLayerTransform(
    index: number,
    angle: number,
    scaleX: number,
    scaleY: number,
    sampling: number,
  ): number {
    const layer = this.layerRecord(index);
    if (layer === null) return INVALID_LAYER;
    if ((scaleX | 0) === 0 || (scaleY | 0) === 0) return 0x80000003;
    layer[ANGLE] = angle;
    layer[SCALE_X] = scaleX;
    layer[SCALE_Y] = scaleY;
    layer[DELTA_ANGLE] = layer[DELTA_SCALE_X] = layer[DELTA_SCALE_Y] = 0;
    layer[SAMPLING] = sampling;
    return 0;
  }
  setLayerEasing(index: number, angle: number, scaling: number): number {
    return this.setLayerWords(index, ANGLE_EASING, angle, scaling);
  }
  setLayerPivotDelta(index: number, x: number, y: number): number {
    return this.setLayerWords(index, DELTA_X, x, y);
  }
  setLayerTransformDelta(index: number, angle: number, x: number, y: number): number {
    const status = this.setLayerWords(index, DELTA_ANGLE, angle);
    if (status === 0) this.setLayerWords(index, DELTA_SCALE_X, x, y);
    return status;
  }
  override move(x: number, y: number): void {
    this.setCoordinates(x, y, this.coordinates().z);
  }
  override position(): AokanaDisplayPoint {
    const layer = this.layerRecord(this.selected)!;
    return {x: layer[X]!, y: layer[Y]!};
  }
  override setCoordinates(x: number, y: number, z: number): void {
    AokanaDisplayObject.prototype.setCoordinates.call(this, x, y, z);
    this.setLayerPosition(this.selected, x, y);
  }
  override setBlendValue(value: number): void {
    this.setLayerLevel(this.selected, value);
  }
  override getBlendValue(): number {
    return this.layerRecord(this.selected)![LEVEL]!;
  }
  override setProperty(selector: number, first: number, second: number): number {
    const layer = this.layerRecord(this.selected)!;
    switch (selector >>> 0) {
      case 0x41:
        this.setLayerTransform(
          this.selected,
          first,
          layer[SCALE_X]!,
          layer[SCALE_Y]!,
          layer[SAMPLING]!,
        );
        break;
      case 0x80:
        this.setLayerPivotDelta(this.selected, first, second);
        break;
      case 0x81:
        this.setLayerWords(this.selected, DELTA_ANGLE, first);
        break;
      case 0x82:
        this.setLayerWords(this.selected, DELTA_SCALE_X, first, second);
        break;
      case 0x8e:
        this.setLayerWords(this.selected, PIVOT_EASING, first);
        break;
      case 0x8f:
        this.setLayerEasing(this.selected, first, second);
        break;
      default:
        return super.setProperty(selector, first, second);
    }
    return 0;
  }
  override drawContent(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): 1 {
    this.check();
    const display = this.environment.displayBitmap(),
      compositor = this.environment.compositor;
    for (let index = 0; index < 8; index++) {
      const layer = this.layers[index]!.slice();
      let drawn = false;
      if (layer[ENABLED] !== 0 && layer[ACTIVE] !== 0) {
        const source = this.surfaces.snapshot(layer[SOURCE]!);
        if (
          source !== null &&
          layer[IMAGE]! >>> 0 === this.surfaces.imageId(layer[SOURCE]!) >>> 0
        ) {
          const progress = this.getValueD8(1),
            pivotWeight = nativeDisplayEasing(progress, layer[PIVOT_EASING]!),
            angleWeight = nativeDisplayEasing(progress, layer[ANGLE_EASING]!),
            scaleWeight = nativeDisplayEasing(progress, layer[SCALE_EASING]!);
          const transform = {
            x: (layer[X]! - (rectangle.left << 16)) | 0,
            y: (layer[Y]! - (rectangle.top << 16)) | 0,
            pivotX: interpolate(layer[PIVOT_X]!, layer[DELTA_X]!, pivotWeight),
            pivotY: interpolate(layer[PIVOT_Y]!, layer[DELTA_Y]!, pivotWeight),
            angle: interpolate(layer[ANGLE]!, layer[DELTA_ANGLE]!, angleWeight),
            scaleX: scale(layer[SCALE_X]!, layer[DELTA_SCALE_X]!, scaleWeight),
            scaleY: scale(layer[SCALE_Y]!, layer[DELTA_SCALE_Y]!, scaleWeight),
          };
          if (index === 0) {
            const x = (layer[X]! - transform.pivotX) | 0,
              y = (layer[Y]! - transform.pivotY) | 0;
            if (
              source.width >>> 0 >= display.width >>> 0 &&
              source.height >>> 0 >= display.height >>> 0 &&
              (x & 0xffff) === 0 &&
              (y & 0xffff) === 0 &&
              x <= 0 &&
              y <= 0 &&
              ((x >> 16) + source.width) >>> 0 >= display.width >>> 0 &&
              ((y >> 16) + source.height) >>> 0 >= display.height >>> 0 &&
              transform.angle === 0 &&
              transform.scaleX === 0x10000 &&
              transform.scaleY === 0x10000
            ) {
              clearAokanaBitmap(destination);
              compositor.draw(
                destination,
                ((x >> 16) - rectangle.left) | 0,
                ((y >> 16) - rectangle.top) | 0,
                source,
                5,
                layer[LEVEL]!,
              );
            } else
              transformAokanaBitmap(
                compositor,
                destination,
                source,
                transform,
                layer[LEVEL]!,
                layer[SAMPLING]!,
                true,
              );
          } else if ((layer[MODE]! & 0xffffffde) === 0 && layer[MODE] !== 0x21) {
            blendTransformedAokanaBitmap(
              compositor,
              destination,
              source,
              transform,
              layer[LEVEL]!,
              layer[SAMPLING]!,
              true,
            );
          } else {
            const temporary = allocateAokanaBitmap(
              (rectangle.right - rectangle.left + 1) | 0,
              (rectangle.bottom - rectangle.top + 1) | 0,
              source.format,
            );
            transformAokanaBitmap(
              compositor,
              temporary,
              source,
              transform,
              0,
              layer[SAMPLING]!,
              true,
            );
            compositor.composite(destination, temporary, layer[MODE]!, layer[LEVEL]!, true);
            temporary.storage?.release();
          }
          drawn = true;
        }
      }
      if (index === 0 && !drawn) clearAokanaBitmap(destination);
    }
    return 1;
  }
}
