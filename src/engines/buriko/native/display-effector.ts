import {nativeDisplayEasing} from '../bp/opcodes/native-math.js';
import {
  allocateBurikoBitmap,
  cropBurikoBitmap,
  type BurikoBitmap,
  type BurikoBitmapRectangle,
} from './bitmap.js';
import {transformBurikoBitmap} from './bitmap-affine.js';
import {
  applyBurikoEffectorBlur,
  applyBurikoEffectorVectorMap,
  clearBurikoEffectorBuffer,
} from './bitmap-display-filters.js';
import {displaceBurikoBitmap} from './bitmap-displacement.js';
import type {BurikoDisplayEffectorRegistry} from './display-effector-registry.js';
import {BurikoDisplayObject, type BurikoDisplayObjectEnvironment} from './display-object.js';
import type {BurikoSurfaces} from './surfaces.js';

export type BurikoDisplayEffectorStatus =
  | 0
  | 0x80000001
  | 0x80000002
  | 0x80000003
  | 0x80000004
  | 0x80000005
  | 0x80000006
  | 0x80000007
  | 0x80000008
  | 0x80000009;

function emptyBitmap(): BurikoBitmap {
  return {
    storage: null,
    offset: 0,
    stride: 0,
    width: 0,
    height: 0,
    format: 0,
    bytesPerPixel: 0,
  };
}

/** CDspObjEffector, the size-210 full-display postprocessor constructed by 05B9A0. */
export class BurikoDisplayEffector extends BurikoDisplayObject {
  effectorMode = -1;
  primaryMap = -1;
  secondaryMap = -1;
  vectorSampling = 0;
  blurSelector = 0;
  displacementMap = -1;
  coefficientCount = 0;
  coefficientSlot = -1;
  coefficientOffset = 0;
  sharedValue = 0;

  private primaryMapImageId = -1;
  private secondaryMapImageId = -1;
  private displacementMapImageId = -1;
  private coefficients: Uint32Array | null = null;
  private retained = emptyBitmap();

  private basePivotX = 0;
  private basePivotY = 0;
  private baseAngle = 0;
  private baseScaleX = 0;
  private baseScaleY = 0;
  private transformTransparency = 0;
  private deltaPivotX = 0;
  private deltaPivotY = 0;
  private deltaAngle = 0;
  private deltaScaleX = 0;
  private deltaScaleY = 0;
  private evaluatedPivotX = 0;
  private evaluatedPivotY = 0;
  private evaluatedAngle = 0;
  private evaluatedScaleX = 0;
  private evaluatedScaleY = 0;
  private easing = 0;

  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
    private readonly registry: BurikoDisplayEffectorRegistry,
    creationOrder: number,
  ) {
    super(environment, 6, creationOrder, 1);
    registry.add(this);
    this.resizeToDisplay();
    this.configureBlur(0, 0, 0);
  }

  private clearCoefficients(): void {
    this.coefficients = null;
  }

  private releaseRetained(): void {
    this.retained.storage?.release();
    this.retained = emptyBitmap();
  }

  /** 05AE40 replaces the private full-display descriptor only after geometry changes. */
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
    this.configureGeometry(display.width, display.height);
    this.releaseRetained();
    this.retained = allocateBurikoBitmap(
      display.width,
      display.height,
      this.environment.compositor.defaultFormat,
    );
    return 1;
  }

  /** 05B490 installs one or two screen-covering format-four vector maps. */
  configureVectorMaps(
    primaryMap: number,
    secondaryMap: number,
    blendValue: number,
    sampling: number,
    layer: number,
  ): BurikoDisplayEffectorStatus {
    this.check();
    primaryMap |= 0;
    secondaryMap |= 0;
    const primary = this.surfaces.snapshot(primaryMap);
    if (primary === null) return 0x80000001;
    const secondary = secondaryMap === -1 ? null : this.surfaces.snapshot(secondaryMap);
    if (secondaryMap !== -1 && secondary === null) return 0x80000002;
    const display = this.environment.displayContext?.bitmap;
    if (
      display === undefined ||
      primary.format !== 4 ||
      primary.width >>> 0 < display.width >>> 0 ||
      primary.height >>> 0 < display.height >>> 0
    )
      return 0x80000003;
    if (
      secondary !== null &&
      (secondary.format !== 4 ||
        secondary.width >>> 0 < display.width >>> 0 ||
        secondary.height >>> 0 < display.height >>> 0)
    )
      return 0x80000004;
    this.clearCoefficients();
    this.effectorMode = 0;
    this.primaryMap = primaryMap;
    this.primaryMapImageId = this.surfaces.imageId(primaryMap);
    this.secondaryMap = secondaryMap;
    this.secondaryMapImageId = secondaryMap === -1 ? -1 : this.surfaces.imageId(secondaryMap);
    this.vectorSampling = sampling | 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return 0;
  }

  /** 05B410 selects one of the six exact zero/clamped blur paths. */
  configureBlur(selector: number, blendValue: number, layer: number): BurikoDisplayEffectorStatus {
    this.check();
    selector >>>= 0;
    if (selector >= 6) return 0x80000005;
    this.clearCoefficients();
    this.effectorMode = 1;
    this.blurSelector = selector;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return 0;
  }

  /** 05B270 retains the actual coefficient-table owner and its count-times-four expansion. */
  configureDisplacement(
    mapSurface: number,
    coefficientCount: number,
    coefficientSlot: number,
    blendValue: number,
    layer: number,
  ): BurikoDisplayEffectorStatus {
    this.check();
    mapSurface |= 0;
    coefficientCount >>>= 0;
    const map = this.surfaces.snapshot(mapSurface);
    if (map === null) return 0x80000001;
    const display = this.environment.displayContext?.bitmap;
    if (
      display === undefined ||
      map.format !== 6 ||
      map.width !== display.width ||
      map.height !== display.height
    )
      return 0x80000003;
    if (coefficientCount === 0) return 0x80000006;
    const coefficients = new Uint32Array(Math.imul(coefficientCount, 4) >>> 0);
    const query = this.surfaces.coefficientTables.query(coefficientSlot, 0, coefficientCount);
    if (query.status !== 0) return 0x80000007;
    if (query.available === 0) return 0x80000008;
    this.clearCoefficients();
    this.effectorMode = 2;
    this.displacementMap = mapSurface;
    this.displacementMapImageId = this.surfaces.imageId(mapSurface);
    this.coefficientCount = coefficientCount;
    this.coefficients = coefficients;
    this.coefficientSlot = coefficientSlot | 0;
    this.coefficientOffset = 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return 0;
  }

  /** 05B180 installs transform bases while deliberately bypassing the derived-field overrides. */
  configureTransform(
    pivotX: number,
    pivotY: number,
    angle: number,
    scaleX: number,
    scaleY: number,
    transparency: number,
    blendValue: number,
    layer: number,
  ): BurikoDisplayEffectorStatus {
    this.check();
    if ((scaleX | 0) === 0 || (scaleY | 0) === 0) return 0x80000009;
    this.clearCoefficients();
    this.effectorMode = 3;
    this.basePivotX = pivotX | 0;
    this.basePivotY = pivotY | 0;
    this.baseAngle = angle | 0;
    this.baseScaleX = scaleX | 0;
    this.baseScaleY = scaleY | 0;
    this.transformTransparency = transparency | 0;
    this.deltaPivotX = 0;
    this.deltaPivotY = 0;
    this.deltaAngle = 0;
    this.deltaScaleX = 0;
    this.deltaScaleY = 0;
    this.easing = 0;
    BurikoDisplayObject.prototype.setBlendValue.call(this, blendValue);
    BurikoDisplayObject.prototype.setValueD8.call(this, 0, 0);
    this.setLayer(layer);
    return 0;
  }

  /** 05B110 preserves one cleared screen buffer for mode-four feedback. */
  configureFeedback(blendValue: number, layer: number): void {
    this.check();
    this.clearCoefficients();
    this.effectorMode = 4;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    clearBurikoEffectorBuffer(this.retained);
  }

  /** 05AE10 writes the same property value into all three mode-specific consumers. */
  setSharedValue(value: number): void {
    this.check();
    this.sharedValue = value | 0;
    this.vectorSampling = value | 0;
    this.transformTransparency = value | 0;
  }

  private expandCoefficients(value: number): void {
    const coefficients = this.coefficients;
    if (this.effectorMode !== 2 || coefficients === null) return;
    this.surfaces.coefficientTables.expand(
      coefficients,
      this.coefficientSlot,
      this.coefficientOffset,
      value,
      this.coefficientCount,
    );
  }

  /** 05AD50 validates a new displacement-table window before applying its amplitude. */
  updateCoefficients(offset: number, amplitude: number): 0 | 0x80000007 | 0x80000008 {
    this.check();
    if (this.effectorMode !== 2) return 0;
    const query = this.surfaces.coefficientTables.query(
      this.coefficientSlot,
      offset,
      this.coefficientCount,
    );
    if (query.status !== 0) return 0x80000007;
    if (query.available === 0) return 0x80000008;
    this.coefficientOffset = offset | 0;
    if (amplitude >>> 0 > 0x100) amplitude = this.getBlendValue();
    this.setBlendValue(amplitude);
    return 0;
  }

  private recomputeTransform(): void {
    const blend = this.getBlendValue() >>> 0;
    const progress = this.getValueD8(1) >>> 0;
    const progressBig = BigInt(progress);
    this.evaluatedPivotX =
      (this.basePivotX + Number((BigInt(this.deltaPivotX | 0) * progressBig) >> 24n)) | 0;
    this.evaluatedPivotY =
      (this.basePivotY + Number((BigInt(this.deltaPivotY | 0) * progressBig) >> 24n)) | 0;
    const eased = nativeDisplayEasing(progress, this.easing);
    const angle =
      ((BigInt(eased | 0) * BigInt(this.deltaAngle | 0)) >> 16n) + BigInt(this.baseAngle | 0);
    this.evaluatedAngle = Number((angle * BigInt(blend)) >> 8n) | 0;
    const scale = (base: number, delta: number): number => {
      const value = BigInt(base >>> 0) - 0x10000n + ((BigInt(delta | 0) * progressBig) >> 24n);
      return (Number((value * BigInt(blend)) >> 8n) + 0x10000) | 0;
    };
    this.evaluatedScaleX = scale(this.baseScaleX, this.deltaScaleX);
    this.evaluatedScaleY = scale(this.baseScaleY, this.deltaScaleY);
  }

  override setBlendValue(value: number): void {
    super.setBlendValue(value);
    if (this.effectorMode === 2) this.expandCoefficients(value);
    else if (this.effectorMode === 3) this.recomputeTransform();
  }

  override setValueD8(mode: number, value: number): void {
    super.setValueD8(mode, value);
    if (this.effectorMode === 3) this.recomputeTransform();
  }

  override setProperty(selector: number, first: number, second: number): number {
    this.check();
    switch (selector >>> 0) {
      case 0x80:
        if (this.effectorMode === 3) {
          this.deltaPivotX = first | 0;
          this.deltaPivotY = second | 0;
        }
        return 0;
      case 0x81:
        if (this.effectorMode === 3) this.deltaAngle = first | 0;
        return 0;
      case 0x82:
        if (this.effectorMode === 3) {
          this.deltaScaleX = first | 0;
          this.deltaScaleY = second | 0;
        }
        return 0;
      case 0x8f:
        this.easing = first | 0;
        return 0;
      case 0xff:
        this.setSharedValue(first);
        return 0;
      case 0x100:
        return this.updateCoefficients(first, second) === 0 ? 0 : 0xffff0002;
      default:
        return super.setProperty(selector, first, second);
    }
  }

  /** 05B5F0 applies the selected full-display postprocess to the live renderer target. */
  override draw(destination: BurikoBitmap, rectangle: BurikoBitmapRectangle, _key: number): void {
    this.check();
    const blendValue = this.effectiveBlendValue();
    if (this.effectorMode !== 4) this.environment.compositor.copy(this.retained, destination);
    switch (this.effectorMode) {
      case 0: {
        const primary = this.surfaces.snapshot(this.primaryMap);
        if (primary === null || this.surfaces.imageId(this.primaryMap) !== this.primaryMapImageId)
          return;
        let secondary: BurikoBitmap | null = null;
        if (this.secondaryMap !== -1) {
          secondary = this.surfaces.snapshot(this.secondaryMap);
          if (
            secondary === null ||
            this.surfaces.imageId(this.secondaryMap) !== this.secondaryMapImageId
          )
            return;
        }
        applyBurikoEffectorVectorMap(
          this.environment.compositor,
          destination,
          this.retained,
          primary,
          secondary,
          blendValue,
          this.vectorSampling,
        );
        return;
      }
      case 1:
        applyBurikoEffectorBlur(
          this.environment.compositor,
          destination,
          this.retained,
          this.blurSelector,
          blendValue,
        );
        return;
      case 2: {
        const map = this.surfaces.snapshot(this.displacementMap);
        if (
          map === null ||
          this.surfaces.imageId(this.displacementMap) !== this.displacementMapImageId ||
          this.coefficients === null
        )
          return;
        displaceBurikoBitmap(
          this.environment.compositor,
          destination,
          this.retained,
          this.retained,
          map,
          this.coefficients,
          this.sharedValue,
        );
        return;
      }
      case 3:
        transformBurikoBitmap(
          this.environment.compositor,
          destination,
          this.retained,
          {
            x: Math.imul(destination.width & 0x1fffe, 0x8000) | 0,
            y: Math.imul(destination.height & 0x1fffe, 0x8000) | 0,
            pivotX: this.evaluatedPivotX,
            pivotY: this.evaluatedPivotY,
            angle: this.evaluatedAngle,
            scaleX: this.evaluatedScaleX,
            scaleY: this.evaluatedScaleY,
          },
          this.transformTransparency,
          0,
          true,
        );
        return;
      case 4: {
        const retained = {...this.retained};
        cropBurikoBitmap(retained, rectangle);
        this.environment.compositor.composite(
          destination,
          retained,
          1,
          (0x100 - blendValue) >>> 0,
          true,
        );
        this.environment.compositor.copy(retained, destination);
      }
    }
  }

  override dispose(): void {
    this.check();
    this.releaseRetained();
    this.clearCoefficients();
    this.registry.remove(this);
    super.dispose();
  }
}
