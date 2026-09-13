import {
  allocateAokanaBitmap,
  cropAokanaBitmap,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {blendAokanaMaskedAlphaIntoRgb, copyAokanaMaskedAlpha} from './bitmap-mask.js';
import {AokanaDisplayObject, AokanaDisplayObjectEnvironment} from './display-object.js';
import {AokanaRain} from './rain.js';
import {AokanaSurfaces} from './surfaces.js';
import {AokanaCrtRandom} from './system-timing.js';
import {AokanaSystemTicks} from './system-ticks.js';

/** 1c9064 is a shared rain visibility gate, initially one. */
export class AokanaRainDisplayState {
  enabled = 1;
  frameInterval = 50; // 1c9b2c, raw image value.
  accumulatedMilliseconds = 0; // 274330.
}

/** CDspObjRainScrn, constructor 060c90 and its real virtual10/30 overrides. */
export class AokanaRainDisplayObject extends AokanaDisplayObject {
  private readonly parameters = Int32Array.of(
    -6000,
    -4000,
    -2000,
    6000,
    4000,
    2000,
    0,
    -1,
    0,
    0x3c00,
    0x15e00,
    -1,
    0,
    20,
    50,
    1,
  );
  private readonly transform = Int32Array.of(0, 0, 0, 0, 0, 0, 100);
  private rain: AokanaRain | null = null;
  private rainBitmap: AokanaBitmap = {
    storage: null,
    offset: 0,
    stride: 0,
    width: 0,
    height: 0,
    format: 0,
    bytesPerPixel: 0,
  };
  private maskHandle = 0xffffffff;
  private maskImageId: number | undefined;

  constructor(
    environment: AokanaDisplayObjectEnvironment,
    creationOrder: number,
    private readonly surfaces: AokanaSurfaces,
    private readonly state: AokanaRainDisplayState,
    private readonly random: AokanaCrtRandom,
    private readonly ticks: AokanaSystemTicks,
  ) {
    super(environment, 5, creationOrder, 1);
  }

  /** 060aa0 calls virtualE8 before freeing and replacing its separate owned bitmap. */
  configureRain(width: number, height: number): number {
    this.check();
    if (this.configureGeometry(width, height) === 0) return 0x80000001;
    this.rainBitmap.storage?.release();
    const nativeFormat = this.environment.compositor.defaultFormat;
    this.rainBitmap = allocateAokanaBitmap(width, height, nativeFormat === 1 ? 2 : nativeFormat);
    clearAokanaBitmap(this.rainBitmap);
    return 0;
  }

  override inputActive(): 0 | 1 {
    return super.inputActive() !== 0 && this.state.enabled !== 0 ? 1 : 0;
  }

  /** 060b30 recreates the complete rain simulation and discards the old list. */
  start(elapsed: number): void {
    this.check();
    this.rain?.dispose();
    this.rain = new AokanaRain(this.random, this.ticks);
    this.rain.exchangeParameters(this.parameters);
    this.rain.exchangeTransform(this.transform);
    this.rain.start(elapsed);
  }

  private applyParameters(): number {
    if (this.rain === null) return 0x80000002;
    this.rain.exchangeParameters(this.parameters);
    return 0;
  }
  private applyTransform(): number {
    if (this.rain === null) return 0x80000002;
    this.rain.exchangeTransform(this.transform);
    return 0;
  }
  setBounds(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number {
    this.check();
    this.parameters.set([x1, y1, z1, x2, y2, z2]);
    return this.applyParameters();
  }
  setSpeed(value: number): number {
    this.check();
    if ((value | 0) === 0) return 0x80000004;
    this.parameters[9] = value << 8;
    return this.applyParameters();
  }
  setDropLength(value: number): number {
    this.check();
    if ((value | 0) === 0) return 0x80000004;
    this.parameters[10] = value << 8;
    return this.applyParameters();
  }
  setColor(value: number): number {
    this.check();
    this.parameters[11] = value;
    return this.applyParameters();
  }
  setSpawnCount(value: number): number {
    this.check();
    this.parameters[13] = value;
    return this.applyParameters();
  }
  setTickInterval(value: number): number {
    this.check();
    if ((value | 0) === 0) return 0x80000004;
    this.parameters[14] = value;
    return this.applyParameters();
  }
  setCameraPosition(x: number, y: number, z: number): number {
    this.check();
    this.transform.set([x, y, z]);
    return this.applyTransform();
  }
  setCameraRotation(x: number, y: number, z: number): number {
    this.check();
    this.transform.set([x, y, z], 3);
    return this.applyTransform();
  }
  setProjectionDistance(value: number): number {
    this.check();
    if ((value | 0) === 0) return 0x80000004;
    this.transform[6] = value;
    return this.applyTransform();
  }

  /** 0603d0 retains a surface image ID so recycling that slot suppresses the later draw. */
  selectMask(handle: number): number {
    this.check();
    handle >>>= 0;
    if (handle === 0xffffffff) {
      this.maskHandle = handle;
      return 0;
    }
    const mask = this.surfaces.snapshot(handle);
    if (mask === null) return 0x80000005;
    if (mask.format !== 3 || mask.width !== this.bitmap.width || mask.height !== this.bitmap.height)
      return 0x80000006;
    this.maskHandle = handle;
    this.maskImageId = this.surfaces.imageId(handle);
    return 0;
  }

  /** 060480's five property writes preserve native virtual dispatch and ignored setLayer failure. */
  configureDisplay(x: number, y: number, mode: number, value: number, layer: number): number {
    this.move(x, y);
    this.blendMode = mode | 0;
    this.setBlendValue(value);
    this.setLayer(layer);
    return 0;
  }
  /** 060a60 advances simulation without rendering or damage notification. */
  updateRain(): number {
    this.check();
    if (this.rain === null) return 0x80000002;
    this.rain.update();
    return 0;
  }
  /** 0609c0 clears and rebuilds its owned pixels, then calls the real invalidate virtual. */
  refreshRain(): number {
    this.check();
    if (this.rainBitmap.storage === null) return 0x80000003;
    if (this.rain === null) return 0x80000002;
    clearAokanaBitmap(this.rainBitmap);
    this.rain.draw(this.rainBitmap);
    this.invalidate();
    return 0;
  }

  override draw(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle, _key: number): void {
    this.check();
    if (this.rainBitmap.storage === null) return;
    const source = {...this.rainBitmap};
    cropAokanaBitmap(source, rectangle); // Native ignores unsuccessful clipping here.
    if (this.maskHandle === 0xffffffff) {
      const value = this.effectiveBlendValue();
      this.environment.compositor.composite(destination, source, this.blendMode, value, true);
      return;
    }
    const mask = this.surfaces.snapshot(this.maskHandle);
    if (mask === null) return;
    if (this.maskImageId === undefined)
      throw new Error('Aokana rain reads its unwritten mask image ID');
    if (this.surfaces.imageId(this.maskHandle) !== this.maskImageId) return;
    cropAokanaBitmap(mask, rectangle);
    const mode = this.blendMode;
    if (mode === 0 || mode === 1 || mode === 0x20) {
      blendAokanaMaskedAlphaIntoRgb(
        destination,
        source,
        mask,
        mode === 0 ? 0 : this.effectiveBlendValue(),
      );
      return;
    }
    const temporary = allocateAokanaBitmap(source.width, source.height, source.format);
    copyAokanaMaskedAlpha(temporary, source, mask);
    const value = this.effectiveBlendValue();
    this.environment.compositor.composite(destination, temporary, mode, value, true);
    temporary.storage?.release();
  }

  override dispose(): void {
    this.check();
    this.rain?.dispose();
    this.rain = null;
    this.rainBitmap.storage?.release();
    super.dispose();
  }
}
