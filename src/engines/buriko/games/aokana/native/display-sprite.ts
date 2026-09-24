import {perspectiveScale} from './perspective-point.js';
import {
  displayPropertyOutput,
  type AokanaDisplayPropertyDestination,
} from './display-property-output.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
  cropAokanaBitmap,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {applyAokanaAlphaMask, applyAokanaBitmapMask} from './bitmap-alpha-mask.js';
import {
  blendTransformedAokanaBitmap,
  transformAokanaBitmap,
  type AokanaBitmapAffineTransform,
} from './bitmap-affine.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {displaceAokanaBitmap} from './bitmap-displacement.js';
import {
  buildAokanaMeshScanlines,
  buildAokanaMeshVertices,
  drawAokanaBitmapMesh,
  type AokanaMeshGeometry,
  type AokanaMeshScanline,
} from './bitmap-mesh.js';
import {blendMixedAokanaBitmapsIntoRgb, mixAokanaBitmaps} from './bitmap-mix.js';
import {reduceAokanaBitmapHalf} from './bitmap-reduce.js';
import {blendRevealedAokanaBitmap, revealAokanaBitmap} from './bitmap-reveal.js';
import {waveAokanaBitmap} from './bitmap-wave.js';
import {nativeAffineSineCosine, nativeDisplayEasing} from '../bp/opcodes/native-math.js';
import {
  AokanaDisplayObject,
  type AokanaDisplayObjectEnvironment,
  type AokanaDisplayPoint,
} from './display-object.js';
import {aokanaRectangleContained} from './display-damage.js';
import {AokanaSpriteEffects} from './sprite-effects.js';
import {aokanaSpriteBounds} from './sprite-bounds.js';
import type {AokanaSurfaces} from './surfaces.js';

export type AokanaSpriteMode = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type AokanaSpriteConfigurationStatus =
  | 0
  | 0x80000001
  | 0x80000002
  | 0x80000003
  | 0x80000004
  | 0x80000005
  | 0x80000006
  | 0x80000007
  | 0x80000008
  | 0x80000009
  | 0x8000000a;
export type AokanaSpriteMaskAssociationStatus =
  0 | 0x8000000a | 0x8000000b | 0x8000000c | 0x8000000d | 0x8000000e;

export interface AokanaSpriteAffineConfiguration {
  readonly sourceSurface: number;
  /** Native +2D8/+2DC: source pivot in integer pixels at configuration time. */
  readonly pivotX: number;
  readonly pivotY: number;
  readonly angle: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly sampling: number;
}

export interface AokanaSpriteAffineBlendConfiguration {
  readonly sourceSurface: number;
  readonly secondarySurface?: number;
  readonly mixValue?: number;
  readonly blendSelector?: number;
  /** Native +2D8/+2DC: source pivot in integer pixels at configuration time. */
  readonly pivotX: number;
  readonly pivotY: number;
  readonly angle: number;
  readonly perspective: number;
  readonly pivotPolicy: number;
  readonly sampling: number;
}

export interface AokanaSpriteMeshConfiguration {
  readonly sourceSurface: number;
  readonly secondarySurface?: number;
  readonly mixValue?: number;
  readonly blendSelector?: number;
  readonly sourcePivotX: number;
  readonly sourcePivotY: number;
  readonly pitch: number;
  readonly heading: number;
  readonly bank: number;
  readonly rotationOrder: number;
  readonly perspective: number;
  readonly pivotPolicy: number;
  readonly sampling: number;
}

interface StableBitmap {
  bitmap: AokanaBitmap;
  imageId: number;
}

interface SelectedBitmap {
  bitmap: AokanaBitmap;
  level: number;
}

interface AlignedMask {
  bitmap: AokanaBitmap;
  owned: boolean;
  dynamic: boolean;
}

interface EvaluatedAffineTransform {
  pivotX: number;
  pivotY: number;
  angle: number;
  scaleX: number;
  scaleY: number;
}

interface EvaluatedMeshTransform extends EvaluatedAffineTransform {
  pitch: number;
  heading: number;
}

const rectangleWidth = (rectangle: AokanaBitmapRectangle): number =>
  (rectangle.right - rectangle.left + 1) | 0;
const rectangleHeight = (rectangle: AokanaBitmapRectangle): number =>
  (rectangle.bottom - rectangle.top + 1) | 0;

function releaseOwned(bitmap: AokanaBitmap | null): null {
  bitmap?.storage?.release();
  return null;
}

function crop(bitmap: AokanaBitmap, rectangle: AokanaBitmapRectangle): AokanaBitmap | null {
  const selected = {...bitmap};
  return cropAokanaBitmap(selected, rectangle) ? selected : null;
}

function unsignedShift(value: number, shift: number): number {
  return shift >= 32 ? 0 : value >>> shift;
}

function truncateInt32(value: number): number {
  if (!Number.isFinite(value) || value < -0x80000000 || value >= 0x80000000) return -0x80000000;
  return Math.trunc(value) | 0;
}

function multiplyShiftSignedUnsigned(left: number, right: number, shift: bigint): number {
  return Number((BigInt(left | 0) * BigInt(right >>> 0)) >> shift) | 0;
}

function multiplyShiftSigned(left: number, right: number, shift: bigint): number {
  return Number((BigInt(left | 0) * BigInt(right | 0)) >> shift) | 0;
}

function multiplyShiftUnsigned(left: number, right: number, shift: bigint): number {
  return Number((BigInt(left >>> 0) * BigInt(right >>> 0)) >> shift) | 0;
}

/** CDspObjSprite, constructor 066910 and the seven-case draw virtual 065550. */
export class AokanaDisplaySprite extends AokanaDisplayObject {
  mode: AokanaSpriteMode = 0;
  sourceSurface = -1;
  secondarySurface = -1;
  staticMaskSurface = -1;
  displacementMapSurface = -1;
  revealProgress = 0;
  sampling = 0;
  mixValue = 0;
  blendSelector = -1;
  wavePeriod = 0;
  wavePhase = 0;
  waveAmplitude = 0;
  readonly effects: AokanaSpriteEffects;

  private sourceImageId = -1;
  private secondaryImageId = -1;
  private staticMaskImageId = -1;
  private displacementMapImageId = -1;
  private staticMaskEnabled = 0;
  private dynamicMask: AokanaDisplaySprite | null = null;
  private maskOwner: AokanaDisplaySprite | null = null;
  private maskOwnerToken = 0;
  private readonly sourceMipmaps: (AokanaBitmap | null)[] = Array(4).fill(null);
  private readonly secondaryMipmaps: (AokanaBitmap | null)[] = Array(4).fill(null);
  private mixedBitmap: AokanaBitmap | null = null;
  private mixedLevel = 0;
  private mixedValue = 0;
  private waveBitmap: AokanaBitmap | null = null;
  private waveLevel = 0;
  private revealMask: AokanaBitmap | null = null;
  private displacementCoefficients: Uint32Array | null = null;
  private displacementCoefficientCount = 0;
  private displacementCoefficientSlot = -1;
  private displacementCoefficientOffset = 0;
  private transformOffsetX = 0;
  private transformOffsetY = 0;
  private affinePhaseX = 0;
  private affinePhaseY = 0;
  private pivotX = 0;
  private pivotY = 0;
  private angle = 0;
  private meshPitch = 0;
  private meshHeading = 0;
  private meshBank = 0;
  private perspective = 0;
  private pivotPolicy = 0;
  private scaleX = 65536;
  private scaleY = 65536;
  private evaluatedPivotX = 0;
  private evaluatedPivotY = 0;
  private evaluatedAngle = 0;
  private evaluatedMeshPitch = 0;
  private evaluatedMeshHeading = 0;
  private baseScaleX = 65536;
  private baseScaleY = 65536;
  private scaleMultiplierX = 65536;
  private scaleMultiplierY = 65536;
  private independentScaleMultipliers = 0;
  private coordinateScaleX = 65536;
  private coordinateScaleY = 65536;
  private readonly animation = {
    pivot: [0, 0] as [number, number],
    affineAngle: 0,
    pitch: 0,
    heading: 0,
    bank: 0,
    scale: [0, 0] as [number, number],
    sharedScale: 0,
    easing: 0,
  };
  private meshConfiguration: AokanaSpriteMeshConfiguration | null = null;
  private meshRecords: readonly AokanaMeshScanline[] | null = null;
  private meshFirstRow = 0;
  private meshBounds: AokanaBitmapRectangle = {left: 0, top: 0, right: 0, bottom: 0};
  private disposedSprite = false;

  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
    creationOrder: number,
    value120 = 1,
    private readonly referencePoint: AokanaDisplayPoint | null = null,
  ) {
    super(environment, 2, creationOrder, value120);
    this.effects = new AokanaSpriteEffects(environment.compositor);
  }

  private stable(surface: number): StableBitmap | null {
    const bitmap = this.surfaces.snapshot(surface);
    if (bitmap === null) return null;
    return {bitmap, imageId: this.surfaces.imageId(surface)};
  }

  private current(surface: number, imageId: number): AokanaBitmap | null {
    const bitmap = this.surfaces.snapshot(surface);
    return bitmap !== null && this.surfaces.imageId(surface) === imageId ? bitmap : null;
  }

  private currentSource(): AokanaBitmap | null {
    return this.current(this.sourceSurface, this.sourceImageId);
  }

  private currentSecondary(): AokanaBitmap | null {
    return this.current(this.secondarySurface, this.secondaryImageId);
  }

  private clearMipmaps(): void {
    for (let index = 0; index < 4; index++) {
      this.sourceMipmaps[index] = releaseOwned(this.sourceMipmaps[index]!);
      this.secondaryMipmaps[index] = releaseOwned(this.secondaryMipmaps[index]!);
    }
  }

  private clearMixed(): void {
    this.mixedBitmap = releaseOwned(this.mixedBitmap);
    this.mixedLevel = 0;
  }

  private clearWave(): void {
    this.waveBitmap = releaseOwned(this.waveBitmap);
    this.waveLevel = 0;
  }

  private clearReveal(): void {
    this.revealMask = releaseOwned(this.revealMask);
  }

  private clearMesh(): void {
    this.meshRecords = null;
    this.meshFirstRow = 0;
    this.meshBounds = {left: 0, top: 0, right: 0, bottom: 0};
  }

  private clearDisplacement(): void {
    this.displacementCoefficients = null;
    this.displacementCoefficientCount = 0;
    this.displacementCoefficientSlot = -1;
    this.displacementCoefficientOffset = 0;
    this.displacementMapSurface = -1;
    this.displacementMapImageId = -1;
  }

  private clearModeCaches(): void {
    this.clearMipmaps();
    this.clearMixed();
    this.clearWave();
    this.clearReveal();
    this.clearMesh();
    this.clearDisplacement();
    this.meshConfiguration = null;
  }

  private installSource(sourceSurface: number, source: StableBitmap): void {
    this.sourceSurface = sourceSurface | 0;
    this.sourceImageId = source.imageId | 0;
  }

  private installSecondary(surface: number, source: StableBitmap | null): void {
    this.secondarySurface = source === null ? -1 : surface | 0;
    this.secondaryImageId = source === null ? -1 : source.imageId | 0;
  }

  private setNativeGeometry(width: number, height: number): void {
    this.configureGeometry(width | 0, height | 0);
  }

  private progressDelta(delta: number): number {
    return multiplyShiftSignedUnsigned(delta, this.getValueD8(1), 24n);
  }

  private easedDelta(delta: number): number {
    return multiplyShiftSigned(
      delta,
      nativeDisplayEasing(this.getValueD8(1), this.animation.easing),
      16n,
    );
  }

  private evaluateScales(
    baseScaleX: number,
    baseScaleY: number,
    multiplierX = this.scaleMultiplierX,
    multiplierY = this.scaleMultiplierY,
  ): [number, number] {
    const progress = this.getValueD8(1),
      linear = (delta: number): number => multiplyShiftSignedUnsigned(delta, progress, 24n);
    if (this.independentScaleMultipliers === 0) {
      const common = linear(this.animation.sharedScale);
      return [
        multiplyShiftSigned(
          (baseScaleX + linear(this.animation.scale[0])) | 0,
          (multiplierX + common) | 0,
          16n,
        ) >>> 0,
        multiplyShiftSigned(
          (baseScaleY + linear(this.animation.scale[1])) | 0,
          (multiplierY + common) | 0,
          16n,
        ) >>> 0,
      ];
    }
    return [
      multiplyShiftSigned(
        baseScaleX,
        (multiplierX + linear((this.animation.scale[0] + this.animation.sharedScale) | 0)) | 0,
        16n,
      ) >>> 0,
      multiplyShiftSigned(
        baseScaleY,
        (multiplierY + linear((this.animation.scale[1] + this.animation.sharedScale) | 0)) | 0,
        16n,
      ) >>> 0,
    ];
  }

  private evaluateAffineTransform(
    pivotX = this.pivotX,
    pivotY = this.pivotY,
    angle = this.angle,
    baseScaleX = this.baseScaleX,
    baseScaleY = this.baseScaleY,
    multiplierX = this.scaleMultiplierX,
    multiplierY = this.scaleMultiplierY,
  ): EvaluatedAffineTransform {
    const [scaleX, scaleY] = this.evaluateScales(baseScaleX, baseScaleY, multiplierX, multiplierY);
    return {
      pivotX: (pivotX + this.progressDelta(this.animation.pivot[0])) | 0,
      pivotY: (pivotY + this.progressDelta(this.animation.pivot[1])) | 0,
      angle: (angle + this.easedDelta(this.animation.affineAngle)) | 0,
      scaleX,
      scaleY,
    };
  }

  private evaluateMeshTransform(): EvaluatedMeshTransform {
    const [scaleX, scaleY] = this.evaluateScales(this.baseScaleX, this.baseScaleY),
      affine: EvaluatedAffineTransform = {
        pivotX: (this.pivotX + this.progressDelta(this.animation.pivot[0])) | 0,
        pivotY: (this.pivotY + this.progressDelta(this.animation.pivot[1])) | 0,
        angle: (this.meshBank + this.easedDelta(this.animation.bank)) | 0,
        scaleX,
        scaleY,
      };
    return {
      ...affine,
      pitch: (this.meshPitch + this.easedDelta(this.animation.pitch)) | 0,
      heading: (this.meshHeading + this.easedDelta(this.animation.heading)) | 0,
    };
  }

  private cacheEvaluated(transform: EvaluatedAffineTransform): void {
    this.evaluatedPivotX = transform.pivotX;
    this.evaluatedPivotY = transform.pivotY;
    this.evaluatedAngle = transform.angle;
    this.scaleX = transform.scaleX;
    this.scaleY = transform.scaleY;
  }

  private displayAnchor(): AokanaDisplayPoint {
    const bitmap = this.environment.displayContext?.bitmap,
      center = {x: (bitmap?.width ?? 0) >>> 1, y: (bitmap?.height ?? 0) >>> 1},
      reference = this.referencePoint;
    return this.value120 !== 0 &&
      reference !== null &&
      reference.x >= 0 &&
      reference.y >= 0 &&
      reference.x < (bitmap?.width ?? 0) &&
      reference.y < (bitmap?.height ?? 0)
      ? {...reference}
      : center;
  }

  private meshDestinationFrame(): {
    destinationPivotX: number;
    destinationPivotY: number;
    translationX: number;
    translationY: number;
    translationZ: number;
  } {
    const anchor = this.displayAnchor(),
      coordinates = this.effectiveCoordinates();
    return this.pivotPolicy !== 0
      ? {
          destinationPivotX: (anchor.x << 16) | 0,
          destinationPivotY: (anchor.y << 16) | 0,
          translationX: coordinates.x,
          translationY: coordinates.y,
          translationZ: coordinates.z,
        }
      : {
          destinationPivotX: ((anchor.x << 16) + coordinates.x) | 0,
          destinationPivotY: ((anchor.y << 16) + coordinates.y) | 0,
          translationX: 0,
          translationY: 0,
          translationZ: coordinates.z,
        };
  }

  private resetAffineAnimation(): void {
    this.blendSelector = -1;
    this.animation.pivot = [0, 0];
    this.animation.affineAngle = 0;
    this.animation.scale = [0, 0];
    this.animation.sharedScale = 0;
    this.animation.easing = 0;
  }

  private resetMeshAnimation(): void {
    this.resetAffineAnimation();
    this.animation.pitch = 0;
    this.animation.heading = 0;
    this.animation.bank = 0;
  }

  /** 0654D0 configures first, then publishes planar display state. */
  initializeSimple(
    x: number,
    y: number,
    sourceSurface: number,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): AokanaSpriteConfigurationStatus {
    const result = this.configureSimple(sourceSurface);
    if (result !== 0) return result;
    this.move(x, y);
    this.blendMode = blendMode | 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return 0;
  }

  /** 065430 deliberately uses the nonvirtual base blend-value setter. */
  initializeBlend(
    x: number,
    y: number,
    sourceSurface: number,
    secondarySurface: number,
    mixValue: number,
    blendValue: number,
    layer: number,
    blendSelector: number,
  ): AokanaSpriteConfigurationStatus {
    const result = this.configureBlend(sourceSurface, secondarySurface, mixValue, blendSelector);
    if (result !== 0) return result;
    this.move(x, y);
    this.blendMode = 1;
    AokanaDisplayObject.prototype.setBlendValue.call(this, blendValue);
    this.setLayer(layer);
    return 0;
  }

  /** 065370 resets affine animation before its display-state writes and configuration. */
  initializeAffine(
    x: number,
    y: number,
    configuration: AokanaSpriteAffineConfiguration,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): AokanaSpriteConfigurationStatus {
    this.resetAffineAnimation();
    this.move(x, y);
    this.blendMode = blendMode | 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return this.configureAffine(configuration);
  }

  /** 0652D0 installs reveal-owned state only after both source checks succeed. */
  initializeReveal(
    x: number,
    y: number,
    sourceSurface: number,
    maskSurface: number,
    revealProgress: number,
    transitionValue: number,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): AokanaSpriteConfigurationStatus {
    const result = this.configureReveal(sourceSurface, maskSurface);
    if (result !== 0) return result;
    this.move(x, y);
    this.revealProgress = revealProgress | 0;
    this.setValueD8(0, transitionValue);
    this.blendMode = blendMode | 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return 0;
  }

  /** 065230 configures coefficient ownership before planar display state. */
  initializeDisplacement(
    x: number,
    y: number,
    sourceSurface: number,
    mapSurface: number,
    coefficientCount: number,
    coefficientSlot: number,
    blendValue: number,
    transparency: number,
    layer: number,
  ): AokanaSpriteConfigurationStatus {
    const result = this.configureDisplacement(
      sourceSurface,
      mapSurface,
      coefficientCount,
      coefficientSlot,
      blendValue,
    );
    if (result !== 0) return result;
    this.move(x, y);
    this.blendMode = 1;
    this.setTransparency(transparency);
    this.setLayer(layer);
    return 0;
  }

  /** 065140 switches to coordinate positioning before configuring mode five. */
  initializeAffineBlend(
    x: number,
    y: number,
    z: number,
    configuration: AokanaSpriteAffineBlendConfiguration,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): AokanaSpriteConfigurationStatus {
    this.resetAffineAnimation();
    this.positionUsesCoordinates = 0;
    this.setCoordinates(x, y, z);
    this.blendMode = blendMode | 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return this.configureAffineBlend(configuration);
  }

  /** 065020 resets the complete mesh animation block before mode-six configuration. */
  initializeMesh(
    x: number,
    y: number,
    z: number,
    configuration: AokanaSpriteMeshConfiguration,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): AokanaSpriteConfigurationStatus {
    this.resetMeshAnimation();
    this.positionUsesCoordinates = 0;
    this.setCoordinates(x, y, z);
    this.blendMode = blendMode | 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return this.configureMesh(configuration);
  }

  /** 064DE0. */
  configureSimple(sourceSurface: number): AokanaSpriteConfigurationStatus {
    const source = this.stable(sourceSurface);
    if (source === null) return 0x80000001;
    this.clearModeCaches();
    this.mode = 0;
    this.installSource(sourceSurface, source);
    this.installSecondary(-1, null);
    this.blendSelector = -1;
    this.setNativeGeometry(source.bitmap.width, source.bitmap.height);
    return 0;
  }

  /** 064C80. Native callers call the second image a mask, but it is the mode-one source. */
  configureBlend(
    sourceSurface: number,
    secondarySurface: number,
    mixValue: number,
    blendSelector: number,
  ): AokanaSpriteConfigurationStatus {
    const source = this.stable(sourceSurface);
    if (source === null) return 0x80000001;
    const secondary = this.stable(secondarySurface);
    if (secondary === null) return 0x80000002;
    if (
      secondary.bitmap.width !== source.bitmap.width ||
      secondary.bitmap.height !== source.bitmap.height
    )
      return 0x80000003;
    this.clearModeCaches();
    this.mode = 1;
    this.installSource(sourceSurface, source);
    this.installSecondary(secondarySurface, secondary);
    this.mixValue = mixValue | 0;
    this.mixedValue = this.mixValue;
    this.blendSelector = blendSelector | 0;
    this.setNativeGeometry(source.bitmap.width, source.bitmap.height);
    return 0;
  }

  /** 0649F0's stable affine state after its animation/easing helper has evaluated. */
  configureAffine(configuration: AokanaSpriteAffineConfiguration): AokanaSpriteConfigurationStatus {
    const source = this.stable(configuration.sourceSurface);
    if (source === null) return 0x80000001;
    const evaluated = this.evaluateAffineTransform(
        (configuration.pivotX << 16) | 0,
        (configuration.pivotY << 16) | 0,
        configuration.angle | 0,
        configuration.scaleX | 0,
        configuration.scaleY | 0,
        0x10000,
        0x10000,
      ),
      bounds = this.affineBounds(source.bitmap, evaluated, 0);
    if (bounds.width < 2 || bounds.height < 2) return 0x80000004;
    this.clearModeCaches();
    this.mode = 2;
    this.installSource(configuration.sourceSurface, source);
    this.installSecondary(-1, null);
    this.blendSelector = -1;
    this.installAffine(configuration, bounds, evaluated);
    this.setNativeGeometry(bounds.width, bounds.height);
    return 0;
  }

  /** 064880. The reveal mask is copied and owned by the sprite. */
  configureReveal(sourceSurface: number, maskSurface: number): AokanaSpriteConfigurationStatus {
    const source = this.stable(sourceSurface);
    if (source === null) return 0x80000001;
    const mask = this.stable(maskSurface);
    if (mask === null) return 0x80000002;
    if (mask.bitmap.format !== 3) return 0x8000000a;
    this.clearModeCaches();
    const owned = allocateAokanaBitmap(source.bitmap.width, source.bitmap.height, 3);
    clearAokanaBitmap(owned);
    this.environment.compositor.copy(owned, mask.bitmap);
    this.mode = 3;
    this.installSource(sourceSurface, source);
    this.installSecondary(-1, null);
    this.blendSelector = -1;
    this.revealMask = owned;
    this.setNativeGeometry(source.bitmap.width, source.bitmap.height);
    return 0;
  }

  /** 064650, sharing the one eight-record owner on AokanaSurfaces. */
  configureDisplacement(
    sourceSurface: number,
    mapSurface: number,
    coefficientCount: number,
    coefficientSlot: number,
    blendValue: number,
  ): AokanaSpriteConfigurationStatus {
    const source = this.stable(sourceSurface);
    if (source === null) return 0x80000001;
    if (source.bitmap.width === 0 || source.bitmap.height === 0) return 0x8000000a;
    const map = this.stable(mapSurface);
    if (map === null) return 0x80000005;
    if (
      map.bitmap.format !== 6 ||
      map.bitmap.width !== source.bitmap.width ||
      map.bitmap.height !== source.bitmap.height
    )
      return 0x80000006;
    coefficientCount >>>= 0;
    if (coefficientCount === 0) return 0x80000007;
    const query = this.surfaces.coefficientTables.query(coefficientSlot, 0, coefficientCount);
    if (query.status !== 0) return 0x80000008;
    if (query.available === 0) return 0x80000009;
    const coefficients = new Uint32Array(Math.imul(coefficientCount, 4) >>> 0);
    this.clearModeCaches();
    this.mode = 4;
    this.installSource(sourceSurface, source);
    this.installSecondary(-1, null);
    this.displacementMapSurface = mapSurface | 0;
    this.displacementMapImageId = map.imageId | 0;
    this.displacementCoefficientCount = coefficientCount;
    this.displacementCoefficientSlot = coefficientSlot | 0;
    this.displacementCoefficientOffset = 0;
    this.displacementCoefficients = coefficients;
    this.blendSelector = -1;
    this.setBlendValue(blendValue);
    this.setNativeGeometry(source.bitmap.width, source.bitmap.height);
    return 0;
  }

  /** 064300's mode-five affine/mipmap source family. */
  configureAffineBlend(
    configuration: AokanaSpriteAffineBlendConfiguration,
  ): AokanaSpriteConfigurationStatus {
    const source = this.stable(configuration.sourceSurface);
    if (source === null) return 0x80000001;
    const secondarySurface = configuration.secondarySurface ?? -1,
      secondary = secondarySurface === -1 ? null : this.stable(secondarySurface);
    if (secondarySurface !== -1 && secondary === null) return 0x80000002;
    if (
      secondary !== null &&
      (secondary.bitmap.width !== source.bitmap.width ||
        secondary.bitmap.height !== source.bitmap.height ||
        secondary.bitmap.format !== source.bitmap.format)
    )
      return 0x80000003;
    const depthScale = perspectiveScale(
        this.effectiveCoordinates().z,
        this.coordinateOption === 0 ? configuration.perspective : 0,
      ),
      evaluated = this.evaluateAffineTransform(
        (configuration.pivotX << 16) | 0,
        (configuration.pivotY << 16) | 0,
        configuration.angle | 0,
        depthScale,
        depthScale,
        0x10000,
        0x10000,
      ),
      bounds = this.affineBounds(
        source.bitmap,
        evaluated,
        this.wavePeriod === 0 ? 0 : this.waveAmplitude,
        this.effectiveCoordinates(),
      );
    if (bounds.width < 2 || bounds.height < 2) return 0x80000004;
    this.clearModeCaches();
    this.mode = 5;
    this.installSource(configuration.sourceSurface, source);
    this.installSecondary(secondarySurface, secondary);
    this.mixValue = secondary === null ? 0 : (configuration.mixValue ?? 0) | 0;
    this.mixedValue = this.mixValue;
    this.blendSelector = secondary === null ? -1 : (configuration.blendSelector ?? -1) | 0;
    this.perspective = configuration.perspective >>> 0;
    this.pivotPolicy = configuration.pivotPolicy | 0;
    this.installAffine(
      {
        sourceSurface: configuration.sourceSurface,
        pivotX: configuration.pivotX,
        pivotY: configuration.pivotY,
        angle: configuration.angle,
        scaleX: depthScale,
        scaleY: depthScale,
        sampling: configuration.sampling,
      },
      bounds,
      evaluated,
    );
    this.regenerateMipmaps();
    this.updateAffineDrawOrigin();
    this.refreshMixed();
    this.refreshWave();
    this.setNativeGeometry(bounds.width, bounds.height);
    return 0;
  }

  /** 064090 stores only the base mesh transform; destination framing is display-derived. */
  configureMesh(configuration: AokanaSpriteMeshConfiguration): AokanaSpriteConfigurationStatus {
    const source = this.stable(configuration.sourceSurface);
    if (source === null) return 0x80000001;
    const secondarySurface = configuration.secondarySurface ?? -1,
      secondary = secondarySurface === -1 ? null : this.stable(secondarySurface);
    if (secondarySurface !== -1 && secondary === null) return 0x80000002;
    if (
      secondary !== null &&
      (secondary.bitmap.width !== source.bitmap.width ||
        secondary.bitmap.height !== source.bitmap.height ||
        secondary.bitmap.format !== source.bitmap.format)
    )
      return 0x80000003;
    this.clearModeCaches();
    this.mode = 6;
    this.installSource(configuration.sourceSurface, source);
    this.installSecondary(secondarySurface, secondary);
    this.mixValue = secondary === null ? 0 : (configuration.mixValue ?? 0) | 0;
    this.mixedValue = this.mixValue;
    this.blendSelector = secondary === null ? -1 : (configuration.blendSelector ?? -1) | 0;
    this.sampling = configuration.sampling | 0;
    this.baseScaleX = this.baseScaleY = 0x10000;
    this.scaleMultiplierX = this.scaleMultiplierY = 65536;
    this.pivotX = (configuration.sourcePivotX << 16) | 0;
    this.pivotY = (configuration.sourcePivotY << 16) | 0;
    this.meshPitch = configuration.pitch | 0;
    this.meshHeading = configuration.heading | 0;
    this.meshBank = configuration.bank | 0;
    this.angle = this.meshBank;
    this.perspective = configuration.perspective >>> 0;
    this.pivotPolicy = configuration.pivotPolicy | 0;
    this.meshConfiguration = {...configuration};
    this.regenerateMipmaps();
    this.refreshMixed();
    this.refreshWave();
    this.rebuildMesh();
    return 0;
  }

  private affineBounds(
    source: AokanaBitmap,
    transform: EvaluatedAffineTransform,
    extraWidth: number,
    phase: AokanaDisplayPoint = {x: 0, y: 0},
  ): ReturnType<typeof aokanaSpriteBounds> {
    return aokanaSpriteBounds({
      width: source.width,
      height: source.height,
      extraWidth,
      centerX: transform.pivotX,
      centerY: transform.pivotY,
      angle: transform.angle,
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      phaseX: phase.x,
      phaseY: phase.y,
    });
  }

  private installAffine(
    configuration: AokanaSpriteAffineConfiguration,
    bounds: ReturnType<typeof aokanaSpriteBounds>,
    evaluated: EvaluatedAffineTransform,
  ): void {
    this.pivotX = (configuration.pivotX << 16) | 0;
    this.pivotY = (configuration.pivotY << 16) | 0;
    this.angle = configuration.angle | 0;
    this.baseScaleX = configuration.scaleX >>> 0;
    this.baseScaleY = configuration.scaleY >>> 0;
    this.scaleMultiplierX = this.scaleMultiplierY = 65536;
    this.cacheEvaluated(evaluated);
    this.sampling = configuration.sampling | 0;
    this.transformOffsetX = bounds.offsetX | 0;
    this.transformOffsetY = bounds.offsetY | 0;
  }

  private mipmapLevel(): number {
    if (this.mode !== 5 && this.mode !== 6) return 0;
    const scale =
      this.mode === 5
        ? this.scaleX >>> 0
        : perspectiveScale(this.effectiveCoordinates().z, this.perspective) >>> 0;
    if (scale > 0x8000) return 0;
    let level = 0,
      threshold = 0x8000;
    do {
      level++;
      threshold >>>= 1;
    } while (scale <= threshold && threshold !== 0);
    return Math.min(level, 4);
  }

  private reduceChain(source: AokanaBitmap, destination: (AokanaBitmap | null)[]): void {
    let previous = source;
    for (let index = 0; index < destination.length; index++) {
      if (previous.storage === null || previous.width <= 1 || previous.height <= 1) break;
      const reduced = allocateAokanaBitmap(
        (previous.width + 1) >>> 1,
        (previous.height + 1) >>> 1,
        previous.format,
      );
      reduceAokanaBitmapHalf(reduced, previous);
      destination[index] = reduced;
      previous = reduced;
    }
  }

  /** 061380 rebuilds both four-entry chains from the two stable surfaces. */
  regenerateMipmaps(): void {
    this.clearMipmaps();
    const source = this.currentSource();
    if (source === null) return;
    this.reduceChain(source, this.sourceMipmaps);
    const secondary = this.currentSecondary();
    if (secondary !== null) this.reduceChain(secondary, this.secondaryMipmaps);
  }

  /** 061140 updates the four retained levels from one inclusive source rectangle. */
  private updateMipmapRegion(region: AokanaBitmapRectangle): void {
    let primary: AokanaBitmap | null = this.currentSource(),
      secondary: AokanaBitmap | null = this.currentSecondary(),
      current = {...region};
    const reduceRegion = (
      source: AokanaBitmap | null,
      destination: AokanaBitmap | null,
      sourceRectangle: AokanaBitmapRectangle,
      destinationRectangle: AokanaBitmapRectangle,
    ): void => {
      if (source === null || destination === null || source.storage === null) return;
      const selectedSource = crop(source, sourceRectangle);
      if (selectedSource === null || selectedSource.width < 2 || selectedSource.height < 2) return;
      const selectedDestination = crop(destination, destinationRectangle);
      if (selectedDestination !== null) reduceAokanaBitmapHalf(selectedDestination, selectedSource);
    };
    for (let level = 0; level < 4; level++) {
      let left = current.left | 0,
        top = current.top | 0,
        right = current.right | 0,
        bottom = current.bottom | 0;
      if (((right - left) | 0) < 1) {
        if (left < 1) right = (right + 1) | 0;
        else left = (left - 1) | 0;
      }
      if (((bottom - top) | 0) < 1) {
        if (top < 1) bottom = (bottom + 1) | 0;
        else top = (top - 1) | 0;
      }
      const aligned = {
          left: left & ~1,
          top: top & ~1,
          right: right | 1,
          bottom: bottom | 1,
        },
        next = {
          left: aligned.left >> 1,
          top: aligned.top >> 1,
          right: aligned.right >> 1,
          bottom: aligned.bottom >> 1,
        },
        primaryDestination = this.sourceMipmaps[level] ?? null,
        secondaryDestination = this.secondaryMipmaps[level] ?? null;
      reduceRegion(primary, primaryDestination, aligned, next);
      reduceRegion(secondary, secondaryDestination, aligned, next);
      primary = primaryDestination;
      secondary = secondaryDestination;
      current = next;
    }
  }

  /** 061650 computes mode-five damage from the changed source subrectangle. */
  private affineDamageBounds(region: AokanaBitmapRectangle): AokanaBitmapRectangle | null {
    if (this.currentSource() === null) return null;
    const coordinates = this.effectiveCoordinates(),
      depthScale = perspectiveScale(
        coordinates.z,
        this.coordinateOption === 0 ? this.perspective : 0,
      ),
      evaluated = this.evaluateAffineTransform(
        this.pivotX,
        this.pivotY,
        this.angle,
        depthScale,
        depthScale,
      ),
      bounds = aokanaSpriteBounds({
        width: rectangleWidth(region),
        height: rectangleHeight(region),
        extraWidth: this.wavePeriod === 0 ? 0 : this.waveAmplitude,
        centerX: (evaluated.pivotX - (region.left << 16)) | 0,
        centerY: (evaluated.pivotY - (region.top << 16)) | 0,
        angle: evaluated.angle,
        scaleX: evaluated.scaleX,
        scaleY: evaluated.scaleY,
        phaseX: coordinates.x,
        phaseY: coordinates.y,
      }),
      position = super.effectivePosition(),
      x = (position.x - bounds.offsetX) | 0,
      y = (position.y - bounds.offsetY) | 0;
    return {
      left: (x - (evaluated.scaleX >>> 16)) | 0,
      top: (y - (((evaluated.scaleX - 1) >>> 0) >>> 17)) | 0,
      right: (x + bounds.width - 1) | 0,
      bottom: (y + (evaluated.scaleY >>> 17) + bounds.height - 1) | 0,
    };
  }

  /** 061820 maps source pixels into display damage for modes zero, one, three and five. */
  private changedRegionDamageBounds(region: AokanaBitmapRectangle): AokanaBitmapRectangle | null {
    if (this.mode === 0 || this.mode === 1 || this.mode === 3) {
      const rectangle = this.inputRectangle(0);
      return {
        left: (rectangle.left + region.left) | 0,
        top: (rectangle.top + region.top) | 0,
        right: (rectangle.left + region.right) | 0,
        bottom: (rectangle.top + region.bottom) | 0,
      };
    }
    return this.mode === 5 ? this.affineDamageBounds(region) : null;
  }

  /** 063140 is reached only by the explicit Bank 90:53 source-region notification. */
  notifySourceRegionChanged(region: AokanaBitmapRectangle): 0 | 1 {
    const damage = this.changedRegionDamageBounds(region);
    if (damage === null) {
      if (this.mode === 5 || this.mode === 6) this.regenerateMipmaps();
      this.invalidate();
      return 1;
    }
    if (this.mode === 5) this.updateMipmapRegion(region);
    if (damage.left > damage.right || damage.top > damage.bottom) return 0;
    this.environment.damage.record(this.sortKey(), damage);
    return 1;
  }

  private selectSurface(source: AokanaBitmap, mipmaps: (AokanaBitmap | null)[]): SelectedBitmap {
    const requested = this.mipmapLevel();
    let bitmap = source,
      level = 0;
    for (; level < requested; level++) {
      const next = mipmaps[level];
      if (next === null || next === undefined) break;
      bitmap = next;
    }
    return {bitmap: {...bitmap}, level};
  }

  private selectedSource(): SelectedBitmap | null {
    const source = this.currentSource();
    return source === null ? null : this.selectSurface(source, this.sourceMipmaps);
  }

  private selectedSecondary(level: number): AokanaBitmap | null {
    const source = this.currentSecondary();
    if (source === null) return null;
    let bitmap = source;
    for (let index = 0; index < level; index++) {
      const next = this.secondaryMipmaps[index];
      if (next === null || next === undefined) break;
      bitmap = next;
    }
    return {...bitmap};
  }

  /** 062DA0 stores the actual mixed level and value used by modes five and six. */
  private refreshMixed(): void {
    this.clearMixed();
    if ((this.mode !== 5 && this.mode !== 6) || this.secondarySurface === -1) return;
    const first = this.selectedSource();
    if (first === null) return;
    const second = this.selectedSecondary(first.level);
    if (second === null) return;
    const destination = allocateAokanaBitmap(
      first.bitmap.width,
      first.bitmap.height,
      first.bitmap.format,
    );
    mixAokanaBitmaps(
      destination,
      first.bitmap,
      second,
      this.mixValue,
      this.environment.compositor.processing,
      1,
    );
    this.mixedBitmap = destination;
    this.mixedLevel = first.level;
    this.mixedValue = this.mixValue;
  }

  private preWaveSource(): SelectedBitmap | null {
    if (this.secondarySurface !== -1) {
      if (this.mixedBitmap === null || this.mixedValue !== this.mixValue) this.refreshMixed();
      return this.mixedBitmap === null
        ? null
        : {bitmap: {...this.mixedBitmap}, level: this.mixedLevel};
    }
    return this.selectedSource();
  }

  /** 062C10 uses the shared scalar-offset worker and an even wave expansion. */
  private refreshWave(): void {
    this.clearWave();
    if ((this.mode !== 5 && this.mode !== 6) || this.wavePeriod === 0 || this.waveAmplitude === 0)
      return;
    const selected = this.preWaveSource();
    if (selected === null) return;
    const source = selected.bitmap,
      expanded = Math.imul((this.waveAmplitude + 0x10000) | 0, source.width | 0) >>> 16,
      extra = ((expanded - source.width + 1) & ~1) | 0,
      destination = allocateAokanaBitmap((source.width + extra) | 0, source.height, source.format);
    waveAokanaBitmap(
      this.environment.compositor,
      destination,
      source,
      unsignedShift(this.wavePeriod, selected.level),
      unsignedShift(this.wavePhase, selected.level),
      this.waveAmplitude,
      true,
    );
    this.waveBitmap = destination;
    this.waveLevel = selected.level;
  }

  private selectedRenderedSource(): SelectedBitmap | null {
    if (this.wavePeriod !== 0 && this.waveAmplitude !== 0) {
      if (this.waveBitmap === null) this.refreshWave();
      return this.waveBitmap === null
        ? null
        : {bitmap: {...this.waveBitmap}, level: this.waveLevel};
    }
    return this.preWaveSource();
  }

  /** 061FC0 derives the mode-five display point from coordinates and display framing. */
  private updateAffineDrawOrigin(): void {
    if (this.mode !== 5) return;
    const anchor = this.displayAnchor(),
      coordinates = this.effectiveCoordinates();
    let x = ((anchor.x << 16) + coordinates.x) | 0,
      y = ((anchor.y << 16) + coordinates.y) | 0;
    if (this.pivotPolicy !== 0) {
      const perspectiveX = multiplyShiftUnsigned(this.coordinateScaleX, this.perspective, 16n),
        perspectiveY = multiplyShiftUnsigned(this.coordinateScaleY, this.perspective, 16n),
        scaleX = perspectiveScale(coordinates.z, perspectiveX),
        scaleY = perspectiveScale(coordinates.z, perspectiveY);
      x = ((anchor.x << 16) + multiplyShiftSigned(coordinates.x, scaleX, 16n)) | 0;
      y = ((anchor.y << 16) + multiplyShiftSigned(coordinates.y, scaleY, 16n)) | 0;
    }
    this.setPosition(x >> 16, y >> 16, 0, 0);
    if (
      this.coordinateRounding === 0 ||
      coordinates.z === 0 ||
      this.coordinateRoundingAtDepth === 1
    ) {
      this.affinePhaseX = x & 0xffff;
      this.affinePhaseY = y & 0xffff;
    } else {
      this.affinePhaseX = 0;
      this.affinePhaseY = 0;
    }
  }

  private rebuildAffineGeometry(): void {
    if (this.mode !== 2 && this.mode !== 5) return;
    const source = this.currentSource();
    if (source === null) return;
    const depthScale =
        this.mode === 5
          ? perspectiveScale(
              this.effectiveCoordinates().z,
              this.coordinateOption === 0 ? this.perspective : 0,
            )
          : null,
      evaluated = this.evaluateAffineTransform(
        this.pivotX,
        this.pivotY,
        this.angle,
        depthScale ?? this.baseScaleX,
        depthScale ?? this.baseScaleY,
      ),
      bounds = this.affineBounds(
        source,
        evaluated,
        this.mode === 5 && this.wavePeriod !== 0 ? this.waveAmplitude : 0,
        this.mode === 5 ? this.effectiveCoordinates() : undefined,
      );
    this.cacheEvaluated(evaluated);
    this.transformOffsetX = bounds.offsetX | 0;
    this.transformOffsetY = bounds.offsetY | 0;
    this.updateAffineDrawOrigin();
    this.setNativeGeometry(bounds.width, bounds.height);
  }

  /** 0618A0 owns the real four vertices and scanline records used by mode six. */
  private rebuildMesh(): void {
    this.clearMesh();
    if (this.mode !== 6 || this.meshConfiguration === null) return;
    const selected = this.selectedRenderedSource();
    if (selected === null) return;
    const configuration = this.meshConfiguration,
      level = selected.level,
      evaluated = this.evaluateMeshTransform(),
      frame = this.meshDestinationFrame(),
      selectedBase = this.sourceMipmaps[level - 1] ?? this.currentSource();
    let sourcePivotX = evaluated.pivotX >> level;
    if (this.waveBitmap !== null && selectedBase !== null)
      sourcePivotX =
        (sourcePivotX + (((selected.bitmap.width - selectedBase.width) << 15) & 0xffff0000)) | 0;
    this.cacheEvaluated(evaluated);
    this.evaluatedMeshPitch = evaluated.pitch;
    this.evaluatedMeshHeading = evaluated.heading;
    const geometry: AokanaMeshGeometry = {
      destinationPivotX: frame.destinationPivotX,
      destinationPivotY: frame.destinationPivotY,
      source: selected.bitmap,
      sourcePivotX,
      sourcePivotY: evaluated.pivotY >> level,
      scaleX: (evaluated.scaleX << level) >>> 0,
      scaleY: (evaluated.scaleY << level) >>> 0,
      translationX: frame.translationX,
      translationY: frame.translationY,
      translationZ: frame.translationZ,
      pitch: evaluated.pitch,
      heading: evaluated.heading,
      bank: evaluated.angle,
      rotationOrder: configuration.rotationOrder,
      perspective: this.perspective,
    };
    const clippingHeight = this.environment.displayContext?.bitmap.height ?? 0;
    // The native exceptional nonpositive record allocation remains static-only.
    if (clippingHeight <= 0) {
      this.setNativeGeometry(1, 1);
      return;
    }
    const mesh = buildAokanaMeshScanlines(buildAokanaMeshVertices(geometry), clippingHeight);
    if (mesh === null) {
      this.setNativeGeometry(1, 1);
      return;
    }
    this.meshRecords = mesh.records;
    this.meshFirstRow = mesh.firstRow;
    this.meshBounds = {...mesh.bounds};
    this.transformOffsetX = mesh.bounds.left;
    this.transformOffsetY = mesh.bounds.top;
    this.setNativeGeometry(
      (mesh.bounds.right - mesh.bounds.left + 1) | 0,
      (mesh.bounds.bottom - mesh.bounds.top + 1) | 0,
    );
    this.setPosition(mesh.bounds.left, mesh.bounds.top, 0, 1);
  }

  setWave(period: number, phase: number, amplitude: number): void {
    this.wavePeriod = period | 0;
    this.wavePhase = phase | 0;
    this.waveAmplitude = amplitude | 0;
    this.refreshWave();
    if (this.mode === 5) this.rebuildAffineGeometry();
    else if (this.mode === 6) this.rebuildMesh();
  }

  /** 063BA0 owns the distinct coordinate-scale constraint pair at +30C/+310. */
  setCoordinateScale(scaleX: number, scaleY: number): 0 | 0x80000004 {
    scaleX >>>= 0;
    scaleY >>>= 0;
    if (scaleX < 0x1000 || scaleX > 0x100000 || scaleY < 0x1000 || scaleY > 0x100000)
      return 0x80000004;
    this.coordinateScaleX = scaleX;
    this.coordinateScaleY = scaleY;
    return 0;
  }

  /** 063DD0 updates the independent Q16 transform multipliers and recomputes derived state. */
  setScaleMultipliers(scaleX: number, scaleY: number): void {
    scaleX |= 0;
    scaleY |= 0;
    this.scaleMultiplierX = scaleX === 0 ? 1 : scaleX;
    this.scaleMultiplierY = scaleY === 0 ? this.scaleMultiplierX : scaleY;
    this.independentScaleMultipliers = scaleY !== 0 ? 1 : 0;
    if (this.mode === 2) this.rebuildAffineGeometry();
    else if (this.mode === 5) {
      this.rebuildAffineGeometry();
      this.refreshMixed();
      this.refreshWave();
    } else if (this.mode === 6) this.rebuildMesh();
  }

  setAngle(angle: number): void {
    if (this.mode === 6) {
      this.meshBank = angle | 0;
      this.angle = this.meshBank;
      this.rebuildMesh();
    } else if (this.mode === 2 || this.mode === 5) {
      this.angle = angle | 0;
      this.rebuildAffineGeometry();
      if (this.mode === 5) this.refreshMixed();
    }
  }

  /** 063FA0 stores integer source coordinates as Q16 without forcing a rebuild. */
  setPivot(x: number, y: number): void {
    if (this.mode !== 2 && this.mode !== 5 && this.mode !== 6) return;
    this.pivotX = (x << 16) | 0;
    this.pivotY = (y << 16) | 0;
  }

  /** 063EA0 stores the mode-six pitch/heading bases without forcing a rebuild. */
  setMeshPitchHeading(pitch: number, heading: number): void {
    if (this.mode !== 6) return;
    this.meshPitch = pitch | 0;
    this.meshHeading = heading | 0;
  }

  /** 063BE0 stores perspective without forcing dependent geometry immediately. */
  setPerspective(value: number): void {
    this.perspective = value >>> 0;
  }

  /** 063FD0 clears a dynamic link before publishing a validated static surface. */
  setStaticMaskSurface(surface: number): AokanaSpriteMaskAssociationStatus | 0x80000001 {
    surface |= 0;
    if (surface === -1) {
      this.staticMaskEnabled = 0;
      this.staticMaskSurface = -1;
      return 0;
    }
    if (this.dynamicMask !== null) this.setDynamicMask(null);
    const mask = this.stable(surface);
    if (mask === null) return 0x80000001;
    if (mask.bitmap.format !== 2 && mask.bitmap.format !== 3) return 0x8000000a;
    this.staticMaskEnabled = 1;
    this.staticMaskSurface = surface;
    this.staticMaskImageId = mask.imageId;
    return 0;
  }

  /** 063050 publishes a reciprocal link only for the supplied creation-order token. */
  private updateMaskChild(mask: AokanaDisplaySprite | null, token: number): boolean {
    if (this.depthOrder >>> 0 !== token >>> 0) return false;
    this.dynamicMask = mask;
    this.staticMaskEnabled = mask === null ? 0 : 1;
    return true;
  }

  private acceptMaskOwner(
    owner: AokanaDisplaySprite | null,
    token: number,
  ): 0 | 0x8000000d | 0x8000000e {
    if (owner !== null) {
      if (this.maskOwner !== null) return 0x8000000d;
      owner.updateMaskChild(this, token);
      this.maskOwner = owner;
      this.maskOwnerToken = token >>> 0;
      return 0;
    }
    if (this.maskOwner === null) return 0x8000000e;
    this.maskOwner.updateMaskChild(null, token);
    this.maskOwner = null;
    return 0;
  }

  /** 063090/062FE0 maintain both native pointers and their creation-order token. */
  setDynamicMask(mask: AokanaDisplaySprite | null): AokanaSpriteMaskAssociationStatus {
    if (mask !== null) {
      this.setStaticMaskSurface(-1);
      if (this.staticMaskEnabled !== 0 || this.dynamicMask !== null) return 0x8000000b;
      return mask.acceptMaskOwner(this, this.depthOrder);
    }
    const previous = this.dynamicMask;
    if (this.staticMaskEnabled === 0 || previous === null) return 0x8000000c;
    return previous.acceptMaskOwner(null, this.depthOrder);
  }

  /** 064EA0 only changes source-bearing modes zero, two, five and six. */
  replaceSource(sourceSurface: number): AokanaSpriteConfigurationStatus {
    switch (this.mode) {
      case 0:
        return this.configureSimple(sourceSurface);
      case 2:
        return this.configureAffine({
          sourceSurface,
          pivotX: this.pivotX >> 16,
          pivotY: this.pivotY >> 16,
          angle: this.angle,
          scaleX: this.baseScaleX,
          scaleY: this.baseScaleY,
          sampling: this.sampling,
        });
      case 5:
        return this.configureAffineBlend({
          sourceSurface,
          pivotX: this.pivotX >> 16,
          pivotY: this.pivotY >> 16,
          angle: this.angle,
          perspective: this.perspective,
          pivotPolicy: this.pivotPolicy,
          sampling: this.sampling,
        });
      case 6:
        return this.configureMesh({
          sourceSurface,
          sourcePivotX: this.pivotX >> 16,
          sourcePivotY: this.pivotY >> 16,
          pitch: this.meshPitch,
          heading: this.meshHeading,
          bank: this.meshBank,
          rotationOrder: this.meshConfiguration?.rotationOrder ?? 0,
          perspective: this.perspective,
          pivotPolicy: this.pivotPolicy,
          sampling: this.sampling,
        });
      default:
        return 0;
    }
  }

  private expandDisplacement(value: number): void {
    if (
      this.mode !== 4 ||
      this.displacementCoefficients === null ||
      this.displacementCoefficientSlot < 0
    )
      return;
    const replacement = new Uint32Array(this.displacementCoefficients.length),
      result = this.surfaces.coefficientTables.expand(
        replacement,
        this.displacementCoefficientSlot,
        this.displacementCoefficientOffset,
        value,
        this.displacementCoefficientCount,
      );
    if (result === 0) this.displacementCoefficients = replacement;
  }

  override setBlendValue(value: number): void {
    value |= 0;
    if (this.blendSelector === 1) {
      this.mixValue = value;
      this.refreshMixed();
      this.refreshWave();
      return;
    }
    if (this.blendSelector === 2) {
      super.setBlendValue(value);
      this.mixValue = value;
      this.refreshMixed();
      this.refreshWave();
      return;
    }
    if (this.blendSelector === 0 || this.blendSelector === 3) {
      super.setBlendValue(value);
      return;
    }
    if (this.blendSelector !== -1) return;
    this.expandDisplacement(value);
    super.setBlendValue(value);
  }

  override getBlendValue(): number {
    if (this.blendSelector === 1) return this.mixValue;
    return super.getBlendValue();
  }

  override setValueD8(mode: number, value: number): void {
    super.setValueD8(mode, value);
    if (this.blendSelector === 3 && (this.mode === 1 || this.mode === 5 || this.mode === 6)) {
      this.mixValue = this.getValueD8(0);
    }
    if (this.mode === 2) this.rebuildAffineGeometry();
    else if (this.mode === 5) {
      this.rebuildAffineGeometry();
      this.refreshMixed();
      this.refreshWave();
    } else if (this.mode === 6) {
      this.refreshMixed();
      this.refreshWave();
      this.rebuildMesh();
    }
  }

  override setCoordinates(x: number, y: number, z: number): void {
    super.setCoordinates(x, y, z);
    if (this.mode === 5) {
      this.rebuildAffineGeometry();
      this.refreshMixed();
      this.refreshWave();
    } else if (this.mode === 6) {
      this.refreshMixed();
      this.refreshWave();
      this.rebuildMesh();
    }
  }

  override setCoordinateOffset(x: number, y: number, z: number): void {
    super.setCoordinateOffset(x, y, z);
    if (this.mode === 5) {
      this.rebuildAffineGeometry();
      this.refreshMixed();
      this.refreshWave();
    } else if (this.mode === 6) {
      this.refreshMixed();
      this.refreshWave();
      this.rebuildMesh();
    }
  }

  override effectivePosition(): AokanaDisplayPoint {
    if (this.mode === 6 && this.meshRecords !== null)
      return {
        x:
          (this.meshBounds.left + (this.usesGlobalOrigin !== 0 ? this.environment.origin.x : 0)) |
          0,
        y:
          (this.meshBounds.top + (this.usesGlobalOrigin !== 0 ? this.environment.origin.y : 0)) | 0,
      };
    const position = super.effectivePosition();
    if (this.mode === 2 || this.mode === 5) {
      position.x = (position.x - this.transformOffsetX) | 0;
      position.y = (position.y - this.transformOffsetY) | 0;
    }
    return position;
  }

  override usesCoordinateParenting(): number {
    return this.mode === 5 || this.mode === 6 ? 1 : 0;
  }

  override inputHitTest(x: number, y: number, checkBounds: number): number {
    if (this.mode === 2 || this.mode === 6) return 0;
    if (this.mode !== 5) return super.inputHitTest(x, y, checkBounds);
    const {cosine, sine} = nativeAffineSineCosine(-this.evaluatedAngle | 0),
      deltaX = (x - this.transformOffsetX) | 0,
      inverseDeltaY = (this.transformOffsetY - y) | 0,
      sourceX =
        (this.pivotX >> 16) -
        truncateInt32(((deltaX * cosine - inverseDeltaY * sine) * -65536) / (this.scaleX >>> 0)),
      sourceY =
        (this.pivotY >> 16) -
        truncateInt32(((deltaX * sine + inverseDeltaY * cosine) * 65536) / (this.scaleY >>> 0));
    return super.inputHitTest(sourceX | 0, sourceY | 0, 0);
  }

  private alignedMask(rectangle: AokanaBitmapRectangle): AlignedMask | null {
    if (this.staticMaskEnabled === 0) return null;
    let source: AokanaBitmap | null,
      position: AokanaDisplayPoint,
      spritePosition: AokanaDisplayPoint,
      dynamic = false;
    if (this.dynamicMask !== null) {
      source = this.surfaces.snapshot(this.dynamicMask.sourceSurface);
      if (source === null) return null;
      spritePosition = this.effectivePosition();
      position = this.dynamicMask.effectivePosition();
      dynamic = true;
    } else {
      source = this.current(this.staticMaskSurface, this.staticMaskImageId);
      position = this.environment.origin;
      if (source === null) return null;
      spritePosition = this.effectivePosition();
    }
    if (dynamic && this.dynamicMask !== null) {
      const globalRectangle = {
          left: (rectangle.left + spritePosition.x) | 0,
          top: (rectangle.top + spritePosition.y) | 0,
          right: (rectangle.right + spritePosition.x) | 0,
          bottom: (rectangle.bottom + spritePosition.y) | 0,
        },
        bounds = this.dynamicMask.inputRectangle(0);
      if (aokanaRectangleContained(globalRectangle, bounds)) {
        const borrowed = {...source};
        cropAokanaBitmap(borrowed, {
          left: (Math.max(globalRectangle.left, bounds.left) - position.x) | 0,
          top: (Math.max(globalRectangle.top, bounds.top) - position.y) | 0,
          right: (Math.min(globalRectangle.right, bounds.right) - position.x) | 0,
          bottom: (Math.min(globalRectangle.bottom, bounds.bottom) - position.y) | 0,
        });
        return {bitmap: borrowed, owned: false, dynamic: true};
      }
    }
    const aligned = allocateAokanaBitmap(
      rectangleWidth(rectangle),
      rectangleHeight(rectangle),
      source.format,
    );
    clearAokanaBitmap(aligned);
    this.environment.compositor.draw(
      aligned,
      (position.x - spritePosition.x - rectangle.left) | 0,
      (position.y - spritePosition.y - rectangle.top) | 0,
      source,
      0x80,
      0,
    );
    return {bitmap: aligned, owned: true, dynamic};
  }

  private applyExternalMask(bitmap: AokanaBitmap, rectangle: AokanaBitmapRectangle): void {
    const mask = this.alignedMask(rectangle);
    if (mask === null) return;
    if (mask.dynamic)
      applyAokanaAlphaMask(
        bitmap,
        bitmap,
        mask.bitmap,
        this.dynamicMask?.effectiveBlendValue() ?? 0,
      );
    else applyAokanaBitmapMask(bitmap, bitmap, mask.bitmap);
    if (mask.owned) releaseOwned(mask.bitmap);
  }

  private temporary(
    source: AokanaBitmap,
    rectangle: AokanaBitmapRectangle,
    forceAlpha: boolean,
  ): AokanaBitmap {
    const format = forceAlpha && source.format === 1 ? 2 : source.format,
      target = allocateAokanaBitmap(rectangleWidth(rectangle), rectangleHeight(rectangle), format);
    clearAokanaBitmap(target);
    return target;
  }

  private finishTemporary(
    destination: AokanaBitmap,
    temporary: AokanaBitmap,
    rectangle: AokanaBitmapRectangle,
    mask: boolean,
    opacity = this.effectiveBlendValue(),
  ): void {
    let output = temporary,
      converted: AokanaBitmap | null = null;
    if (mask && output.format !== 2) {
      converted = allocateAokanaBitmap(output.width, output.height, 2);
      this.environment.compositor.copy(converted, output);
      output = converted;
    }
    if (mask) this.applyExternalMask(output, rectangle);
    this.effects.apply(output);
    this.environment.compositor.composite(destination, output, this.blendMode, opacity, true);
    if (converted !== null) releaseOwned(converted);
    releaseOwned(temporary);
  }

  private affineTransform(
    rectangle: AokanaBitmapRectangle,
    selected: SelectedBitmap,
  ): AokanaBitmapAffineTransform {
    let pivotX = this.evaluatedPivotX >> selected.level;
    const pivotY = this.evaluatedPivotY >> selected.level;
    if (this.waveBitmap !== null) {
      const source = this.sourceMipmaps[selected.level - 1] ?? this.currentSource();
      if (source !== null) pivotX = (pivotX + ((selected.bitmap.width - source.width) << 15)) | 0;
    }
    return {
      x:
        (((this.transformOffsetX - rectangle.left) << 16) +
          (this.mode === 5 ? this.affinePhaseX : 0)) |
        0,
      y:
        (((this.transformOffsetY - rectangle.top) << 16) +
          (this.mode === 5 ? this.affinePhaseY : 0)) |
        0,
      pivotX,
      pivotY,
      angle: this.evaluatedAngle,
      scaleX: (this.scaleX << selected.level) >>> 0,
      scaleY: (this.scaleY << selected.level) >>> 0,
    };
  }

  private simpleMode(): AokanaSpriteMode {
    if (
      this.mode === 2 &&
      this.evaluatedAngle === 0 &&
      this.scaleX === 0x10000 &&
      this.scaleY === 0x10000
    )
      return 0;
    if (
      this.mode === 5 &&
      this.evaluatedAngle === 0 &&
      this.scaleX === 0x10000 &&
      this.scaleY === 0x10000 &&
      this.affinePhaseX === 0 &&
      this.affinePhaseY === 0 &&
      (this.wavePeriod === 0 || this.waveAmplitude === 0)
    )
      return this.secondarySurface !== -1 ? 1 : 0;
    if (this.mode === 3 && this.getValueD8(0) >= 0x100) return 0;
    return this.mode;
  }

  override draw(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle, _key: number): void {
    if (this.maskOwner !== null) return;
    switch (this.simpleMode()) {
      case 0:
        this.drawSimple(destination, rectangle);
        break;
      case 1:
        this.drawBlend(destination, rectangle);
        break;
      case 2:
        this.drawAffine(destination, rectangle, this.selectedSource());
        break;
      case 3:
        this.drawReveal(destination, rectangle);
        break;
      case 4:
        this.drawDisplacement(destination, rectangle);
        break;
      case 5:
        this.drawAffine(destination, rectangle, this.selectedRenderedSource());
        break;
      case 6:
        this.drawMesh(destination, rectangle);
        break;
    }
  }

  private drawSimple(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): void {
    const source = this.currentSource();
    if (source === null) return;
    const selected = crop(source, rectangle);
    if (selected === null) return;
    const masked = this.staticMaskEnabled !== 0;
    if (!masked && !this.effects.active) {
      this.environment.compositor.composite(
        destination,
        selected,
        this.blendMode,
        this.effectiveBlendValue(),
        true,
      );
      return;
    }
    const temporary = this.temporary(selected, rectangle, masked || this.effects.active);
    this.environment.compositor.copy(temporary, selected);
    this.finishTemporary(destination, temporary, rectangle, masked);
  }

  private drawBlend(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): void {
    const first = this.currentSource(),
      second = this.currentSecondary();
    if (first === null || second === null) return;
    const left = crop(first, rectangle),
      right = crop(second, rectangle);
    if (left === null || right === null) return;
    if (
      this.staticMaskEnabled === 0 &&
      !this.effects.active &&
      destination.format === 1 &&
      left.format === 2 &&
      right.format === 2 &&
      (this.blendMode === 0 || this.blendMode === 1 || this.blendMode === 0x20)
    ) {
      blendMixedAokanaBitmapsIntoRgb(
        destination,
        left,
        right,
        this.mixValue,
        this.blendMode === 0 ? 0 : this.effectiveBlendValue(),
      );
      return;
    }
    const temporary = this.temporary(left, rectangle, false);
    mixAokanaBitmaps(
      temporary,
      left,
      right,
      this.mixValue,
      this.environment.compositor.processing,
      1,
    );
    this.finishTemporary(destination, temporary, rectangle, this.staticMaskEnabled !== 0);
  }

  private directAffineEligible(destination: AokanaBitmap, source: AokanaBitmap): boolean {
    return (
      this.staticMaskEnabled === 0 &&
      !this.effects.active &&
      destination.format === 1 &&
      source.format === 2 &&
      (this.blendMode === 0 || this.blendMode === 1 || this.blendMode === 0x20)
    );
  }

  private drawAffine(
    destination: AokanaBitmap,
    rectangle: AokanaBitmapRectangle,
    selected: SelectedBitmap | null,
  ): void {
    if (selected === null) return;
    const transform = this.affineTransform(rectangle, selected);
    if (this.directAffineEligible(destination, selected.bitmap)) {
      blendTransformedAokanaBitmap(
        this.environment.compositor,
        destination,
        selected.bitmap,
        transform,
        this.effectiveBlendValue(),
        this.sampling,
        true,
      );
      return;
    }
    const temporary = this.temporary(selected.bitmap, rectangle, selected.bitmap.format === 1);
    transformAokanaBitmap(
      this.environment.compositor,
      temporary,
      selected.bitmap,
      transform,
      0,
      this.sampling,
      true,
    );
    this.finishTemporary(destination, temporary, rectangle, this.staticMaskEnabled !== 0);
  }

  private drawReveal(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): void {
    const source = this.currentSource(),
      revealMask = this.revealMask;
    if (source === null || revealMask === null) return;
    const selected = crop(source, rectangle),
      mask = crop(revealMask, rectangle);
    if (selected === null || mask === null) return;
    const exponent = this.getValueD8(0);
    if (
      !this.effects.active &&
      destination.format === 1 &&
      (this.blendMode === 0 || this.blendMode === 1 || this.blendMode === 0x20)
    ) {
      blendRevealedAokanaBitmap(
        this.environment.compositor,
        destination,
        selected,
        mask,
        exponent,
        this.revealProgress,
        this.effectiveBlendValue(),
      );
      return;
    }
    const temporary = allocateAokanaBitmap(
      rectangleWidth(rectangle),
      rectangleHeight(rectangle),
      2,
    );
    revealAokanaBitmap(
      this.environment.compositor,
      temporary,
      selected,
      mask,
      exponent,
      this.revealProgress,
    );
    this.finishTemporary(destination, temporary, rectangle, false);
  }

  private drawDisplacement(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): void {
    const source = this.currentSource(),
      map = this.current(this.displacementMapSurface, this.displacementMapImageId),
      coefficients = this.displacementCoefficients;
    if (source === null || map === null || coefficients === null) return;
    const selected = crop(source, rectangle),
      selectedMap = crop(map, rectangle);
    if (selected === null || selectedMap === null) return;
    const temporary = this.temporary(selected, rectangle, false);
    displaceAokanaBitmap(
      this.environment.compositor,
      temporary,
      selected,
      source,
      selectedMap,
      coefficients,
      1,
    );
    const opacity = (0x100 - (Math.imul(0x100 - this.transparency, this.opacityScale) >> 8)) >>> 0;
    this.environment.compositor.composite(destination, temporary, this.blendMode, opacity, true);
    releaseOwned(temporary);
  }

  private drawMesh(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): void {
    const selected = this.selectedRenderedSource(),
      records = this.meshRecords;
    if (selected === null || records === null) return;
    const firstRow = (this.meshFirstRow - this.meshBounds.top - rectangle.top) | 0,
      xOffset = (-this.meshBounds.left - rectangle.left) | 0,
      direct =
        this.staticMaskEnabled === 0 &&
        !this.effects.active &&
        destination.format === 1 &&
        (selected.bitmap.format === 1 || selected.bitmap.format === 2) &&
        (this.blendMode === 0 || this.blendMode === 1 || this.blendMode === 0x20);
    if (direct) {
      drawAokanaBitmapMesh(
        this.environment.compositor,
        destination,
        selected.bitmap,
        records,
        firstRow,
        xOffset,
        1,
        this.effectiveBlendValue(),
        true,
      );
      return;
    }
    const temporary = this.temporary(selected.bitmap, rectangle, false);
    drawAokanaBitmapMesh(
      this.environment.compositor,
      temporary,
      selected.bitmap,
      records,
      firstRow,
      xOffset,
      0,
      0,
      true,
    );
    this.finishTemporary(destination, temporary, rectangle, this.staticMaskEnabled !== 0);
  }

  private updateDisplacement(offset: number, amplitude: number): 0 | 0x80000008 | 0x80000009 {
    if (this.mode !== 4) return 0;
    const query = this.surfaces.coefficientTables.query(
      this.displacementCoefficientSlot,
      offset,
      this.displacementCoefficientCount,
    );
    if (query.status !== 0) return 0x80000008;
    if (query.available === 0) return 0x80000009;
    this.displacementCoefficientOffset = offset | 0;
    this.setBlendValue(amplitude >>> 0 > 0x100 ? this.getBlendValue() : amplitude);
    return 0;
  }

  override setProperty(selector: number, first: number, second: number): number {
    selector >>>= 0;
    first >>>= 0;
    switch (selector) {
      case 0x10:
        return this.replaceSource(first) === 0 ? 0 : 0xffff0002;
      case 0x11:
        return this.effects.set(first & 0xff, (first >>> 8) & 0xff, second, first >>> 16) === 0
          ? 0
          : 0xffff0002;
      case 0x28:
        return this.setCoordinateScale(first, second) === 0 ? 0 : 0xffff0002;
      case 0x40:
        if (this.mode === 2 || this.mode === 5 || this.mode === 6)
          this.setPivot(first | 0, second | 0);
        return 0;
      case 0x41:
        if (this.mode === 2 || this.mode === 5 || this.mode === 6) this.setAngle(first | 0);
        return 0;
      case 0x42:
        if (this.mode === 2 || this.mode === 5 || this.mode === 6) {
          this.setScaleMultipliers(first, second);
        }
        return 0;
      case 0x43:
        if (this.mode === 6) this.setMeshPitchHeading(first | 0, second | 0);
        return 0;
      case 0x60:
        this.setWave(first >>> 16, first & 0xffff, second);
        return 0;
      case 0x80:
        if (this.mode === 2 || this.mode === 5 || this.mode === 6)
          this.animation.pivot = [first | 0, second | 0];
        return 0;
      case 0x81:
        if (this.mode === 2 || this.mode === 5) {
          this.animation.affineAngle = first | 0;
          this.animation.sharedScale = second | 0;
        } else if (this.mode === 6) {
          this.animation.bank = first | 0;
          this.animation.sharedScale = second | 0;
        }
        return 0;
      case 0x82:
        if (this.mode === 2 || this.mode === 5 || this.mode === 6)
          this.animation.scale = [first | 0, second | 0];
        return 0;
      case 0x83:
        if (this.mode === 6) {
          this.animation.pitch = first | 0;
          this.animation.heading = second | 0;
        }
        return 0;
      case 0x8f:
        this.animation.easing = first | 0;
        return 0;
      case 0x100:
        return this.updateDisplacement(first, second) === 0 ? 0 : 0xffff0002;
      default:
        return super.setProperty(selector, first, second);
    }
  }

  override getProperty(selector: number, output: AokanaDisplayPropertyDestination): number {
    const access = displayPropertyOutput(output),
      write = (index: number, value: number): void => access.write32(index, value >>> 0);
    switch (selector >>> 0) {
      case 0x10:
        write(0, this.sourceSurface);
        return 0;
      case 0x41:
        if (this.mode !== 2 && this.mode !== 5 && this.mode !== 6) return 0xffff0001;
        write(0, this.mode === 6 ? this.meshBank : this.angle);
        return 0;
      case 0x10000000: {
        if (this.mode !== 5 && this.mode !== 6) return 0xffff0001;
        const transform =
          this.mode === 6 ? this.evaluateMeshTransform() : this.evaluateAffineTransform();
        write(0, transform.pivotX);
        write(1, transform.pivotY);
        write(2, transform.angle);
        write(3, transform.scaleX);
        write(4, transform.scaleY);
        return 0;
      }
      case 0x10000100: {
        const source = this.surfaces.snapshot(this.sourceSurface);
        if (source !== null) {
          write(0, source.width);
          write(1, source.height);
        }
        if (this.mode === 2 || this.mode === 5 || this.mode === 6) {
          write(2, this.bitmap.width);
          write(3, this.bitmap.height);
        } else {
          write(2, access.read32(0));
          write(3, access.read32(1));
        }
        return 0;
      }
      default:
        return super.getProperty(selector, output);
    }
  }

  /** 066880 clears both association directions before every owned sprite allocation. */
  override dispose(): void {
    if (this.disposedSprite) throw new Error('Aokana accesses a deleted CDspObjSprite');
    this.setDynamicMask(null);
    this.acceptMaskOwner(null, this.maskOwnerToken);
    this.clearModeCaches();
    this.disposedSprite = true;
    super.dispose();
  }
}
