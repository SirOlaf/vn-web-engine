import {BurikoMultilayerBackdrop} from './display-backdrop-multilayer.js';
import {
  BurikoBackdrop,
  BurikoNormalBackdrop,
  BurikoRippleBackdrop,
  type BurikoRippleBackdropStatus,
} from './display-backdrop.js';
import {BurikoBlendBackdrop} from './display-backdrop-blend.js';
import {BurikoPanBackdrop} from './display-backdrop-pan.js';
import {BurikoMaskedBackdrop} from './display-backdrop-mask.js';
import {BurikoDifferenceBackdrop} from './display-backdrop-difference.js';
import {BurikoVectorBackdrop} from './display-backdrop-vector.js';
import {BurikoBlurBackdrop} from './display-backdrop-blur.js';
import {BurikoMosaicBackdrop} from './display-backdrop-mosaic.js';
import {BurikoRotationBackdrop} from './display-backdrop-rotation.js';
import {BurikoStretchBackdrop} from './display-backdrop-stretch.js';
import {BurikoDisplayObject, BurikoDisplayObjectEnvironment} from './display-object.js';
import {BurikoDisplayRedraw} from './display-redraw.js';
import {BurikoNativeDisplayState} from './display-state.js';
import {BurikoSurfaces} from './surfaces.js';
import type {BurikoWindowDisplayState} from './display-window-state.js';
import {allocateBurikoBitmap, burikoBitmapPixelSize, type BurikoBitmapRectangle} from './bitmap.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoDisplayContext} from './display-object.js';
import {BurikoDisplayEffectorRegistry} from './display-effector-registry.js';
import type {BurikoDisplayDamageResult} from './display-renderer.js';
import {BurikoObjectManager} from './object-manager.js';
import {BurikoNativeLocks, createBurikoDisplayLocks} from './exclusion-locks.js';
import {BurikoDisplayTexture} from './display-texture.js';
import {clearBurikoBitmap, copyBurikoBitmapRows} from './bitmap-copy.js';
import {
  BurikoDisplaySprite,
  type BurikoSpriteAffineBlendConfiguration,
  type BurikoSpriteAffineConfiguration,
  type BurikoSpriteConfigurationStatus,
  type BurikoSpriteMeshConfiguration,
} from './display-sprite.js';

/** The ten native pools; their category selectors are independent of CDspObj +1c. */
export const BURIKO_DISPLAY_POOLS = Object.freeze({
  sprite: {category: 0, prefix: 0x80000000, capacity: 2048},
  filter: {category: 1, prefix: 0x90000000, capacity: 8},
  effector: {category: 2, prefix: 0x91000000, capacity: 8},
  map: {category: 3, prefix: 0xa0000000, capacity: 8},
  landscape: {category: 4, prefix: 0xa1000000, capacity: 4},
  window: {category: 5, prefix: 0xb0000000, capacity: 16},
  particle: {category: 6, prefix: 0xc0000000, capacity: 8},
  rain: {category: 7, prefix: 0xc1000000, capacity: 8},
  knob: {category: 0x10, prefix: 0xf0000000, capacity: 32},
  group: {category: 0x11, prefix: 0xf1000000, capacity: 8},
} as const);
export type BurikoDisplayFamily = keyof typeof BURIKO_DISPLAY_POOLS;
export type BurikoConfiguredDisplayFamily = 'window' | 'particle' | 'rain';
export type BurikoSimpleDisplayFamily = Exclude<
  BurikoDisplayFamily,
  BurikoConfiguredDisplayFamily | 'knob'
>;
export type BurikoDisplayCreateResult<Failure extends number> =
  {result: 0; handle: number} | {result: Failure};
type ConfigurationFailure<Family extends BurikoConfiguredDisplayFamily> = Family extends 'window'
  ? 9 | 10
  : Family extends 'rain'
    ? 1 | 3
    : 1 | 2;
interface Pool {
  slots: (BurikoDisplayObject | null)[];
  count: number;
  creationCount: number;
}

/**
 * The actual shared display manager at 1e8d50, constructed by 080430. Class owners
 * supply their real constructors/configuration methods to these native pool paths;
 * an absent class is never replaced by a base object or a successful factory.
 * Window/device presentation and scene-bank coverage are separate from this layer.
 */
export class BurikoDisplayManager extends BurikoObjectManager {
  private readonly pools: Record<BurikoDisplayFamily, Pool> = Object.fromEntries(
    Object.entries(BURIKO_DISPLAY_POOLS).map(([family, definition]) => [
      family,
      {slots: Array(definition.capacity).fill(null), count: 0, creationCount: 0},
    ]),
  ) as Record<BurikoDisplayFamily, Pool>;
  private backdropValue: BurikoBackdrop | null = null;
  get backdrop(): BurikoBackdrop {
    if (this.backdropValue === null) throw new Error('Buriko display has no installed backdrop');
    return this.backdropValue;
  }
  private disposed = false;
  private texture: BurikoDisplayTexture | null = null;
  private textureLocked = 0;
  backdropActivation = 1;
  backdropContentEnabled = 0;
  readonly referencePoint = {x: -1, y: -1};

  constructor(
    readonly environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
    readonly displayState: BurikoNativeDisplayState,
    readonly redraw = new BurikoDisplayRedraw(),
    readonly locks: BurikoNativeLocks = createBurikoDisplayLocks(surfaces.allocator),
  ) {
    super(
      environment.compositor,
      surfaces.allocator,
      environment.damage,
      () => environment.displayContext,
      new BurikoDisplayEffectorRegistry(),
    );
    redraw.bindLocks(locks);
    this.backdropValue = new BurikoNormalBackdrop(environment, surfaces);
    this.setBackdropRenderType(this.backdrop.backdropType);
    this.lists.insert(this.backdrop);
    this.setBackdropActivation(1, 0);
  }
  private check(): void {
    if (this.disposed) throw new Error('Buriko accesses a deleted display manager');
  }
  get visibleRectangle(): BurikoBitmapRectangle {
    this.check();
    if (this.environment.displayContext === null)
      throw new Error('Buriko display descriptor has not been configured');
    return this.environment.displayContext.bounds;
  }
  /** The device controller installs the one shared descriptor/rectangle storage. */
  bindDisplayContext(context: BurikoDisplayContext): void {
    this.check();
    this.environment.displayContext = context;
    this.environment.damage.clip = context.bounds;
  }
  /** 07ff70 only replaces +68; it does not acquire a reference or alter +70. */
  setDisplayTexture(texture: BurikoDisplayTexture | null): void {
    this.check();
    this.texture = texture;
  }
  /** 07ff00 publishes the shared pointer/stride only after a successful texture lock. */
  lockDisplay(): 0 | 1 {
    this.check();
    if (this.texture === null || this.textureLocked !== 0) return 0;
    const locked = this.texture.lock();
    if (locked === null) return 0;
    const bitmap = this.displayContext().bitmap;
    bitmap.storage = locked.storage;
    bitmap.offset = locked.offset;
    bitmap.stride = locked.pitch;
    this.textureLocked = 1;
    return 1;
  }
  /** 07fea0 ignores the UnlockRect result, then clears the shared pointer/stride. */
  unlockDisplay(): 0 | 1 {
    this.check();
    if (this.texture === null || this.textureLocked === 0) return 0;
    this.texture.unlock();
    const bitmap = this.displayContext().bitmap;
    bitmap.storage = null;
    bitmap.offset = 0;
    bitmap.stride = 0;
    this.textureLocked = 0;
    return 1;
  }
  private displayContext(): BurikoDisplayContext {
    const context = this.environment.displayContext;
    if (context === null) throw new Error('Buriko display descriptor has not been configured');
    return context;
  }
  /** 07FC50 delegates to the actual renderer's locked ordinary-list snapshot. */
  collectOrdinaryObjects(): BurikoDisplayObject[] {
    this.check();
    if (this.objectRenderer === null)
      throw new Error('Buriko object renderer has not been attached');
    return this.objectRenderer.collectOrdinary();
  }
  /** 07fde0 leaves its caller's count untouched when the display cannot be locked. */
  drawDamage(output: BurikoDisplayDamageResult): 0 | 1 {
    this.check();
    if (this.objectRenderer === null)
      throw new Error('Buriko object renderer has not been attached');
    if (this.lockDisplay() === 0) return 0;
    const result = this.objectRenderer.drawDamage();
    output.rectangles = result.rectangles;
    output.count = result.count;
    this.unlockDisplay();
    return 1;
  }
  /** 07fe50 keeps the descriptor mapped throughout the full draw and notifications. */
  drawFull(): 0 | 1 {
    this.check();
    if (this.objectRenderer === null)
      throw new Error('Buriko object renderer has not been attached');
    if (this.lockDisplay() === 0) return 0;
    this.objectRenderer.drawFull();
    this.unlockDisplay();
    return 1;
  }
  /** 080080 allocates at display geometry, then copies the mapped texture or clears on lock failure. */
  captureDisplayBitmap(surface: number): 0 | 1 {
    this.check();
    const source = this.displayContext().bitmap,
      result = this.surfaces.allocate(surface, source.width, source.height, source.format);
    if (result === 0) return 0;
    const destination = this.surfaces.snapshot(surface);
    if (destination === null)
      throw new Error('Buriko display capture has no allocated surface descriptor');
    if (this.lockDisplay() === 0) clearBurikoBitmap(destination);
    else {
      copyBurikoBitmapRows(destination, this.displayContext().bitmap);
      this.unlockDisplay();
    }
    return result;
  }
  /** 07ffe0 allocates at display geometry and draws through the actual shared object renderer. */
  renderDisplayBitmap(surface: number, maximumLayer: number): 0 | 1 {
    this.check();
    const descriptor = this.displayContext().bitmap,
      result = this.surfaces.allocate(
        surface,
        descriptor.width,
        descriptor.height,
        descriptor.format,
      );
    if (result === 0) return 0;
    const destination = this.surfaces.snapshot(surface);
    if (destination === null)
      throw new Error('Buriko display render has no allocated surface descriptor');
    if (this.objectRenderer === null)
      throw new Error('Buriko object renderer has not been attached');
    this.objectRenderer.drawToBitmap(destination, maximumLayer);
    return result;
  }
  /** 07FF80 draws to an existing RGB surface through the actual translated renderer. */
  renderTranslatedDisplayBitmap(
    surface: number,
    x: number,
    y: number,
    maximumLayer: number,
  ): 0 | 1 | 2 {
    this.check();
    const destination = this.surfaces.snapshot(surface);
    if (destination === null) return 2;
    if (destination.format !== 1) return 1;
    if (this.objectRenderer === null)
      throw new Error('Buriko object renderer has not been attached');
    this.objectRenderer.drawTranslated(destination, x, y, maximumLayer);
    return 0;
  }
  /** 0801b0; the three family-specific hooks belong to their actual concrete classes. */
  configureDescriptor(width: number, height: number, format: number, pixelBudget: number): 1 {
    this.check();
    this.environment.compositor.defaultFormat = format >>> 0;
    this.setRenderPixelBudget(pixelBudget);
    if (this.environment.displayContext === null)
      this.bindDisplayContext({
        bitmap: {
          storage: null,
          offset: 0,
          stride: 0,
          width: 0,
          height: 0,
          format: 0,
          bytesPerPixel: 0,
        },
        bounds: {left: 0, top: 0, right: -1, bottom: -1},
      });
    const {bitmap, bounds} = this.displayContext();
    bitmap.width = width | 0;
    bitmap.stride = 0;
    bitmap.storage = null;
    bitmap.offset = 0;
    bitmap.height = height | 0;
    bitmap.format = format >>> 0;
    bitmap.bytesPerPixel = burikoBitmapPixelSize(format);
    bounds.left = bounds.top = 0;
    bounds.right = (width - 1) | 0;
    bounds.bottom = (height - 1) | 0;
    this.backdrop.resizeToDisplay();
    for (const family of ['filter', 'effector', 'window'] as const)
      for (let slot = 0; slot < BURIKO_DISPLAY_POOLS[family].capacity; slot++) {
        const object = this.pools[family].slots[slot];
        if (object === null || object === undefined) continue;
        if (family === 'window') {
          if (
            !('refreshDisplayGeometry' in object) ||
            typeof object.refreshDisplayGeometry !== 'function'
          )
            throw new Error('Buriko concrete window display geometry hook is absent');
          object.refreshDisplayGeometry();
        } else {
          if (!('resizeToDisplay' in object) || typeof object.resizeToDisplay !== 'function')
            throw new Error(`Buriko concrete ${family} display resize hook is absent`);
          object.resizeToDisplay();
        }
      }
    this.setDisplayTexture(null);
    this.environment.damage.force();
    return 1;
  }
  /** Native lock zero, shared by sprite operations in the cooperative actor profile. */
  enterSpriteLock(): void {
    this.check();
    this.locks.enterEngine(0);
  }
  leaveSpriteLock(): void {
    this.check();
    this.locks.leaveEngine(0);
  }
  /** 07fc80 returns an all-ones DWORD for every unrecognized category. */
  categoryCount(category: number): number {
    this.check();
    for (const family of Object.keys(BURIKO_DISPLAY_POOLS) as BurikoDisplayFamily[])
      if (BURIKO_DISPLAY_POOLS[family].category === category >>> 0)
        return this.pools[family].count >>> 0;
    return 0xffffffff;
  }
  creationCount(family: BurikoDisplayFamily): number {
    this.check();
    return this.pools[family].creationCount >>> 0;
  }
  /** A copied view for native family traversals; only this manager mutates pool slots. */
  poolObjects(family: BurikoDisplayFamily): readonly (BurikoDisplayObject | null)[] {
    this.check();
    return this.pools[family].slots.slice();
  }
  find(family: BurikoDisplayFamily, handle: number): BurikoDisplayObject | null {
    this.check();
    const definition = BURIKO_DISPLAY_POOLS[family];
    handle >>>= 0;
    const index = handle & 0xffffff;
    return (handle & 0xff000000) >>> 0 === definition.prefix && index < definition.capacity
      ? this.pools[family].slots[index]!
      : null;
  }
  /** 087090 reserves zero for the root backdrop and tries the native families in order. */
  resolve(handle: number): BurikoDisplayObject | null {
    this.check();
    if (handle >>> 0 === 0) return this.backdrop;
    for (const family of Object.keys(BURIKO_DISPLAY_POOLS) as BurikoDisplayFamily[]) {
      const object = this.find(family, handle);
      if (object !== null) return object;
    }
    return null;
  }
  private firstEmpty(family: BurikoDisplayFamily): number {
    const index = this.pools[family].slots.indexOf(null);
    if (index < 0) throw new RangeError('Buriko display slot search exceeds its native pool');
    return index;
  }
  private construct<T extends BurikoDisplayObject>(
    family: BurikoDisplayFamily,
    construct: (creationOrder: number) => T,
  ): T {
    const pool = this.pools[family];
    const order = pool.creationCount;
    pool.creationCount = (order + 1) >>> 0;
    return construct(order);
  }
  /** 085e50/084fd0/084c00/0844f0/083f00/080b40 return the handle or zero. */
  createSimple<T extends BurikoDisplayObject>(
    family: BurikoSimpleDisplayFamily,
    construct: (creationOrder: number) => T,
  ): number {
    this.check();
    if (family === 'sprite') this.enterSpriteLock();
    const pool = this.pools[family],
      definition = BURIKO_DISPLAY_POOLS[family];
    let handle = 0;
    if ((pool.count | 0) < definition.capacity) {
      const index = this.firstEmpty(family),
        object = this.construct(family, construct);
      pool.slots[index] = object;
      if (family !== 'group') this.lists.insert(object);
      pool.count = (pool.count + 1) | 0;
      handle = (definition.prefix + index) >>> 0;
      const stored = pool.slots[index];
      if (stored === null || stored === undefined)
        throw new Error('Buriko display handle assignment has no current slot object');
      stored.handle = handle;
    }
    if (family === 'sprite') this.leaveSpriteLock();
    return handle;
  }
  /** 085E50 constructs the concrete size-4D8 sprite before slot/list publication. */
  createSprite(): number {
    return this.createSimple(
      'sprite',
      (creationOrder) =>
        new BurikoDisplaySprite(
          this.environment,
          this.surfaces,
          creationOrder,
          1,
          this.referencePoint,
        ),
    );
  }
  /** 085180 resolves only Sprite and invalidates only on a visibility transition. */
  setSpriteActivation(handle: number, value: number): boolean {
    const object = this.find('sprite', handle);
    if (object === null) return false;
    const before = object.inputActive() !== 0;
    object.setActivation(value);
    if (before !== (object.inputActive() !== 0)) object.invalidate();
    return true;
  }
  /** 0852F0 commits actual static mask state and invalidates successful visible changes. */
  setSpriteStaticMask(handle: number, surface: number): number {
    const object = this.find('sprite', handle);
    if (object === null) return -1;
    if (!(object instanceof BurikoDisplaySprite))
      throw new Error('Buriko Sprite pool has a non-Sprite object');
    const status = object.setStaticMaskSurface(surface);
    if (status === 0) {
      if (object.inputActive() !== 0) object.invalidate();
      return 0;
    }
    return status === 0x80000001 ? 1 : status === 0x8000000a ? 2 : handle | 0;
  }
  /** 085220 attaches a concrete Sprite mask and maps the reciprocal-link status. */
  setSpriteDynamicMask(handle: number, maskHandle: number): number {
    const sprite = this.findSprite(handle);
    if (sprite === null) return 0xffffffff;
    const mask = this.findSprite(maskHandle);
    if (sprite === mask || (mask === null && maskHandle >>> 0 !== 0)) return 0xb;
    const status = sprite.setDynamicMask(mask);
    if (status === 0) {
      if (sprite.inputActive() !== 0) sprite.invalidate();
      return 0;
    }
    if (status === 0x8000000b || status === 0x8000000c) return 0xd;
    if (status === 0x8000000d) return 0xe;
    if (status === 0x8000000e) return 0xf;
    return handle >>> 0;
  }
  /** 085110 converts the script extent to inclusive edges before calling sprite 063140. */
  notifySpriteSourceRegionChanged(
    handle: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): 0 | 10 | 0xffffffff {
    const object = this.find('sprite', handle);
    if (object === null) return 0xffffffff;
    if (!(object instanceof BurikoDisplaySprite))
      throw new Error('Buriko sprite pool contains a different native display class');
    x |= 0;
    y |= 0;
    width |= 0;
    height |= 0;
    return object.notifySourceRegionChanged({
      left: x,
      top: y,
      right: (x + width - 1) | 0,
      bottom: (y + height - 1) | 0,
    }) !== 0
      ? 0
      : 10;
  }
  private findSprite(handle: number): BurikoDisplaySprite | null {
    const object = this.find('sprite', handle);
    if (object === null) return null;
    if (!(object instanceof BurikoDisplaySprite))
      throw new Error('Buriko sprite pool contains a different native display class');
    return object;
  }
  private initializeSprite(
    handle: number,
    initialize: (sprite: BurikoDisplaySprite) => BurikoSpriteConfigurationStatus,
    mapFailure: (result: Exclude<BurikoSpriteConfigurationStatus, 0>) => number,
  ): number {
    const sprite = this.findSprite(handle);
    if (sprite === null) return 0xffffffff;
    if (sprite.inputActive() !== 0) sprite.invalidate();
    const result = initialize(sprite);
    if (result !== 0) return mapFailure(result);
    if (sprite.inputActive() !== 0) sprite.invalidate();
    this.lists.resort(sprite);
    return 0;
  }
  /** 085C60 maps only the simple source failure before its success-time resort. */
  initializeSimpleSprite(
    handle: number,
    x: number,
    y: number,
    sourceSurface: number,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): 0 | 1 | 0xffffffff {
    return this.initializeSprite(
      handle,
      (sprite) => sprite.initializeSimple(x, y, sourceSurface, blendMode, blendValue, layer),
      (result) => {
        if (result === 0x80000001) return 1;
        throw new Error('Buriko simple sprite returned an unknown native configuration status');
      },
    ) as 0 | 1 | 0xffffffff;
  }
  /** 085380 reuses the pre-change visibility for both invalidations and never resorts. */
  replaceSpriteSource(handle: number, sourceSurface: number): 0 | 1 | 0xffffffff {
    const sprite = this.findSprite(handle);
    if (sprite === null) return 0xffffffff;
    const active = sprite.inputActive() !== 0;
    if (active) sprite.invalidate();
    const result = sprite.replaceSource(sourceSurface);
    if (result !== 0) {
      if (result === 0x80000001) return 1;
      throw new Error('Buriko sprite source replacement returned an unknown native status');
    }
    if (active) sprite.invalidate();
    return 0;
  }
  /** 085B40 retains native's status-nine mismatch mapping. */
  initializeBlendSprite(
    handle: number,
    x: number,
    y: number,
    sourceSurface: number,
    secondarySurface: number,
    mixValue: number,
    blendValue: number,
    layer: number,
    blendSelector: number,
  ): 0 | 1 | 9 | 0xffffffff {
    return this.initializeSprite(
      handle,
      (sprite) =>
        sprite.initializeBlend(
          x,
          y,
          sourceSurface,
          secondarySurface,
          mixValue,
          blendValue,
          layer,
          blendSelector,
        ),
      (result) => {
        if (result === 0x80000001 || result === 0x80000002) return 1;
        if (result === 0x80000003) return 9;
        throw new Error('Buriko blend sprite returned an unknown native configuration status');
      },
    ) as 0 | 1 | 9 | 0xffffffff;
  }
  /** 085A00 maps an unusably small affine result to eight. */
  initializeAffineSprite(
    handle: number,
    x: number,
    y: number,
    configuration: BurikoSpriteAffineConfiguration,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): 0 | 1 | 8 | 0xffffffff {
    return this.initializeSprite(
      handle,
      (sprite) => sprite.initializeAffine(x, y, configuration, blendMode, blendValue, layer),
      (result) => {
        if (result === 0x80000001) return 1;
        if (result === 0x80000004) return 8;
        throw new Error('Buriko affine sprite returned an unknown native configuration status');
      },
    ) as 0 | 1 | 8 | 0xffffffff;
  }
  /** 0858E0 maps either missing reveal input to one and a non-mask input to two. */
  initializeRevealSprite(
    handle: number,
    x: number,
    y: number,
    sourceSurface: number,
    maskSurface: number,
    revealProgress: number,
    transitionValue: number,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): 0 | 1 | 2 | 0xffffffff {
    return this.initializeSprite(
      handle,
      (sprite) =>
        sprite.initializeReveal(
          x,
          y,
          sourceSurface,
          maskSurface,
          revealProgress,
          transitionValue,
          blendMode,
          blendValue,
          layer,
        ),
      (result) => {
        if (result === 0x80000001 || result === 0x80000002) return 1;
        if (result === 0x8000000a) return 2;
        throw new Error('Buriko reveal sprite returned an unknown native configuration status');
      },
    ) as 0 | 1 | 2 | 0xffffffff;
  }
  /** 085780 preserves all seven displacement diagnostics. */
  initializeDisplacementSprite(
    handle: number,
    x: number,
    y: number,
    sourceSurface: number,
    mapSurface: number,
    coefficientCount: number,
    coefficientSlot: number,
    blendValue: number,
    transparency: number,
    layer: number,
  ): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 0xffffffff {
    return this.initializeSprite(
      handle,
      (sprite) =>
        sprite.initializeDisplacement(
          x,
          y,
          sourceSurface,
          mapSurface,
          coefficientCount,
          coefficientSlot,
          blendValue,
          transparency,
          layer,
        ),
      (result) => {
        switch (result) {
          case 0x80000001:
            return 1;
          case 0x8000000a:
            return 2;
          case 0x80000005:
            return 3;
          case 0x80000006:
            return 4;
          case 0x80000007:
            return 5;
          case 0x80000008:
            return 6;
          case 0x80000009:
            return 7;
          default:
            throw new Error('Buriko displacement sprite returned an unknown native status');
        }
      },
    ) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 0xffffffff;
  }
  private initializeTransformedSprite(
    handle: number,
    initialize: (sprite: BurikoDisplaySprite) => BurikoSpriteConfigurationStatus,
  ): 0 | 1 | 8 | 9 | 0xffffffff {
    return this.initializeSprite(handle, initialize, (result) => {
      if (result === 0x80000001 || result === 0x80000002) return 1;
      if (result === 0x80000003) return 9;
      if (result === 0x80000004) return 8;
      throw new Error('Buriko transformed sprite returned an unknown native configuration status');
    }) as 0 | 1 | 8 | 9 | 0xffffffff;
  }
  /** 0855F0 initializes coordinate-positioned affine blend mode five. */
  initializeAffineBlendSprite(
    handle: number,
    x: number,
    y: number,
    z: number,
    configuration: BurikoSpriteAffineBlendConfiguration,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): 0 | 1 | 8 | 9 | 0xffffffff {
    return this.initializeTransformedSprite(handle, (sprite) =>
      sprite.initializeAffineBlend(x, y, z, configuration, blendMode, blendValue, layer),
    );
  }
  /** 085440 initializes coordinate-positioned perspective mesh mode six. */
  initializeMeshSprite(
    handle: number,
    x: number,
    y: number,
    z: number,
    configuration: BurikoSpriteMeshConfiguration,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): 0 | 1 | 8 | 9 | 0xffffffff {
    return this.initializeTransformedSprite(handle, (sprite) =>
      sprite.initializeMesh(x, y, z, configuration, blendMode, blendValue, layer),
    );
  }
  /**
   * 083350/0824e0/081a40 configure before publishing the slot. Rain alone uses
   * zero as success. Slot and count precede list insertion and handle assignment.
   */
  createConfigured<Family extends BurikoConfiguredDisplayFamily, T extends BurikoDisplayObject>(
    family: Family,
    construct: (creationOrder: number) => T,
    configure: (object: T) => number,
  ): BurikoDisplayCreateResult<ConfigurationFailure<Family>> {
    this.check();
    const pool = this.pools[family],
      definition = BURIKO_DISPLAY_POOLS[family];
    const failure = (result: number): BurikoDisplayCreateResult<ConfigurationFailure<Family>> =>
      ({result}) as {result: ConfigurationFailure<Family>};
    if ((pool.count | 0) >= definition.capacity) return failure(family === 'window' ? 9 : 1);
    const index = this.firstEmpty(family),
      object = this.construct(family, construct);
    const result = configure(object) | 0;
    if (family === 'rain' ? result !== 0 : result === 0) {
      object.dispose();
      return failure(family === 'window' ? 10 : family === 'rain' ? 3 : 2);
    }
    pool.slots[index] = object;
    pool.count = (pool.count + 1) | 0;
    this.lists.insert(object);
    const handle = (definition.prefix + index) >>> 0;
    object.handle = handle;
    return {result: 0, handle};
  }
  /** 081060 resolves the parent only after capacity, and checks its nonvirtual category. */
  createKnob<T extends BurikoDisplayObject>(
    targetHandle: number,
    construct: (creationOrder: number, target: BurikoDisplayObject) => T,
  ): BurikoDisplayCreateResult<1 | 2 | 3> {
    this.check();
    const pool = this.pools.knob;
    if ((pool.count | 0) >= 32) return {result: 1};
    const target = this.resolve(targetHandle);
    if (target === null) return {result: 2};
    if (target.category >>> 0 >= 8) return {result: 3};
    const index = this.firstEmpty('knob');
    const object = this.construct('knob', (order) => construct(order, target));
    pool.slots[index] = object;
    pool.count = (pool.count + 1) | 0;
    const handle = (0xf0000000 + index) >>> 0;
    object.handle = handle;
    return {result: 0, handle};
  }
  /** 07ED70: category dispatch deliberately omits the guarded Sprite deletion facade. */
  destroyObject(handle: number): 0 | -1 {
    const object = this.resolve(handle);
    if (object === null) return -1;
    switch (object.category >>> 0) {
      case 1:
        if (!this.destroy('landscape', handle)) this.destroy('map', handle);
        break;
      case 2:
        this.destroy('sprite', handle);
        break;
      case 3:
        this.destroy('window', handle);
        break;
      case 4:
        this.destroy('particle', handle);
        break;
      case 5:
        this.destroy('rain', handle);
        break;
      case 6:
        this.destroy('effector', handle);
        break;
      case 7:
        this.destroy('filter', handle);
        break;
      case 9:
        this.destroy('group', handle);
        break;
      case 10:
        this.destroy('knob', handle);
        break;
      default:
        return -1;
    }
    return 0;
  }
  /** Pool-specific native removal; group and knob never enter the draw lists. */
  destroy(family: BurikoDisplayFamily, handle: number): boolean {
    this.check();
    if (family === 'sprite') this.enterSpriteLock();
    const object = this.find(family, handle);
    if (object !== null) {
      if (family !== 'knob' && family !== 'group') {
        if (object.inputActive() !== 0) {
          if (family === 'effector') this.environment.damage.force();
          else object.invalidate();
        }
        this.lists.remove(object);
      }
      // Native rereads the slot after virtual invalidation/list removal.
      const pool = this.pools[family],
        index = handle & 0xffffff;
      pool.slots[index]?.dispose();
      pool.slots[index] = null;
      pool.count = (pool.count - 1) | 0;
    }
    if (family === 'sprite') this.leaveSpriteLock();
    return object !== null;
  }
  /** The native bulk leaves assume lists were already cleared and reset both DWORDs. */
  clearPool(family: BurikoDisplayFamily): void {
    this.check();
    const pool = this.pools[family];
    for (let index = 0; index < pool.slots.length; index++) {
      const object = pool.slots[index];
      if (object !== null) {
        object!.dispose();
        pool.slots[index] = null;
      }
    }
    pool.count = pool.creationCount = 0;
  }
  /** 07fbc0 compares visibility zero-ness before and after virtual activation. */
  setActivation(handle: number, value: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const before = object.inputActive() !== 0;
    object.setActivation(value);
    if (before !== (object.inputActive() !== 0)) object.invalidate();
    return true;
  }
  /** 07FAA0/0565B0 mutates suppression, whose zero value permits visibility. */
  setObjectSuppression(handle: number, value: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const visible = object.inputActive() !== 0;
    BurikoDisplayObject.prototype.setSuppression.call(object, value);
    if (visible !== (object.inputActive() !== 0)) object.invalidate();
    return true;
  }
  private mutateObjectCoordinates(
    handle: number,
    apply: (object: BurikoDisplayObject) => void,
  ): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const visible = object.inputActive() !== 0;
    if (visible) object.invalidate();
    const key = object.sortKey();
    apply(object);
    if (key !== object.sortKey()) this.lists.resort(object);
    if (visible) object.invalidate();
    return true;
  }
  /** 07F8D0 dispatches virtual78, including Sprite affine/mesh rebuilds. */
  setObjectCoordinates(handle: number, x: number, y: number, z: number): boolean {
    return this.mutateObjectCoordinates(handle, (object) => object.setCoordinates(x, y, z));
  }
  /** 07F4B0 calls nonvirtual055AF0, which itself invokes virtual88. */
  setObjectSecondaryCoordinateOffset(handle: number, x: number, y: number, z: number): boolean {
    return this.mutateObjectCoordinates(handle, (object) =>
      BurikoDisplayObject.prototype.setSecondaryCoordinateOffset.call(object, x, y, z),
    );
  }
  /** 07F570 dispatches virtual88. */
  setObjectCoordinateOffset(handle: number, x: number, y: number, z: number): boolean {
    return this.mutateObjectCoordinates(handle, (object) => object.setCoordinateOffset(x, y, z));
  }
  /** 07EF60 invalidates the child before mutation and after successful attachment. */
  addObjectChild(
    parentHandle: number,
    childHandle: number,
    x: number,
    y: number,
  ): 0 | -1 | 6 | 7 | 8 {
    const parent = this.resolve(parentHandle);
    if (parent === null) return -1;
    const child = this.resolve(childHandle);
    if (child === null) return 6;
    if (parent === child) return 7;
    if (child.inputActive() !== 0) child.invalidate();
    if (parent.addChild(child, x, y) === 0) return 8;
    if (child.inputActive() !== 0) child.invalidate();
    return 0;
  }
  /** 07EF00 removes exactly the first matching actual child link without invalidating. */
  removeObjectChild(parentHandle: number, childHandle: number): 0 | -1 | 6 | 9 {
    const parent = this.resolve(parentHandle);
    if (parent === null) return -1;
    const child = this.resolve(childHandle);
    if (child === null) return 6;
    return parent.removeChild(child) !== 0 ? 0 : 9;
  }
  /** 07fb30 uses the nonvirtual 056620 setter between the two virtual visibility reads. */
  setSecondaryVisibility(handle: number, value: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const before = object.inputActive() !== 0;
    BurikoDisplayObject.prototype.setSecondaryVisibility.call(object, value);
    if (before !== (object.inputActive() !== 0)) object.invalidate();
    return true;
  }
  /** 07f990 reuses its initial visibility result for both invalidations around virtual58. */
  move(handle: number, x: number, y: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const visible = object.inputActive() !== 0;
    if (visible) object.invalidate();
    object.move(x, y);
    if (visible) object.invalidate();
    return true;
  }
  /** 07FA20 calls virtual90, then invalidates if either visibility read is nonzero. */
  setObjectBlendValue(handle: number, value: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const before = object.inputActive() !== 0;
    object.setBlendValue(value);
    const after = object.inputActive() !== 0;
    if (before || after) object.invalidate();
    return true;
  }
  /** 07F850 uses the nonvirtual transparency setter. */
  setObjectTransparency(handle: number, value: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const before = object.inputActive() !== 0;
    BurikoDisplayObject.prototype.setTransparency.call(object, value);
    const after = object.inputActive() !== 0;
    if (before || after) object.invalidate();
    return true;
  }
  /** 07F750 captures visibility once around virtualA0 with mode zero. */
  setObjectValueD8(handle: number, value: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const visible = object.inputActive() !== 0;
    if (visible) object.invalidate();
    object.setValueD8(0, value);
    if (visible) object.invalidate();
    return true;
  }
  /** 07F630 calls nonvirtual055E00; 07F6C0 calls virtual70. */
  setObjectOffset(handle: number, x: number, y: number, secondary: boolean): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const visible = object.inputActive() !== 0;
    if (visible) object.invalidate();
    if (secondary) BurikoDisplayObject.prototype.setSecondaryOffset.call(object, x, y);
    else object.setOffset(x, y);
    if (visible) object.invalidate();
    return true;
  }
  /** 07F7D0 calls nonvirtual055990 between fresh visibility reads. */
  setObjectOpacityScale(handle: number, value: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const before = object.inputActive() !== 0;
    BurikoDisplayObject.prototype.setOpacityScale.call(object, value);
    const after = object.inputActive() !== 0;
    if (before || after) object.invalidate();
    return true;
  }
  /** 07F290 resorts only when the composite virtual38 key changes. */
  setObjectLayer(handle: number, value: number): 0 | -1 {
    const object = this.resolve(handle);
    if (object === null) return -1;
    if (object.inputActive() !== 0) object.invalidate();
    const key = object.sortKey();
    object.setLayer(value);
    if (key !== object.sortKey()) this.lists.resort(object);
    if (object.inputActive() !== 0) object.invalidate();
    return 0;
  }
  /** 07F3C0 keeps the first invalidation even on a property error. */
  setObjectProperty(handle: number, selector: number, first: number, second: number): number {
    const object = this.resolve(handle);
    if (object === null) return -1;
    if (object.inputActive() !== 0) object.invalidate();
    const key = object.sortKey(),
      status = object.setProperty(selector, first, second) >>> 0;
    if (status !== 0) return status === 0xffff0001 ? 5 : 0xffff;
    if (key !== object.sortKey()) this.lists.resort(object);
    if (object.inputActive() !== 0) object.invalidate();
    return 0;
  }
  /** 07F190: category check precedes null/zero-mask/source selection. */
  setObjectHitMask(handle: number, surface: number): 0 | 1 | 2 | -1 {
    const object = this.resolve(handle);
    if (object === null) return -1;
    if (object.category >>> 0 >= 8) return 1;
    if (surface >>> 0 === 0xffffffff) {
      BurikoDisplayObject.prototype.setHitMask.call(object, null);
      return 0;
    }
    if (surface >>> 0 === 0xfffffffe) {
      const rectangle = object.localRectangle(),
        temporary = allocateBurikoBitmap((rectangle.right + 1) | 0, (rectangle.bottom + 1) | 0, 3);
      clearBurikoBitmap(temporary);
      BurikoDisplayObject.prototype.setHitMask.call(object, temporary);
      temporary.storage?.release();
      return 0;
    }
    const source = this.surfaces.snapshot(surface);
    if (source === null) return 2;
    BurikoDisplayObject.prototype.setHitMask.call(object, source);
    return 0;
  }
  /** 0B5DD0/07F130: effective position precedes pointer read and the second lookup. */
  hitObjectAtPointer(handle: number, input: BurikoNativeInput): number | null {
    const object = this.resolve(handle);
    if (object === null) return null;
    const position = object.effectivePosition(),
      [x, y] = input.pointerPosition(),
      target = this.resolve(handle);
    return target === null
      ? null
      : target.inputHitTest((x - position.x) | 0, (y - position.y) | 0, 1);
  }
  /** 085fb0 changes the backdrop switches and requests full damage unconditionally. */
  setBackdropActivation(activation: number, contentEnabled: number): void {
    this.check();
    this.backdropActivation = activation | 0;
    this.backdropContentEnabled = contentEnabled | 0;
    this.backdrop.setActivation(activation);
    this.backdrop.setContentEnabled(contentEnabled);
    this.environment.damage.force();
  }
  private selectBackdrop(type: 1): BurikoNormalBackdrop;
  private selectBackdrop(type: 2): BurikoBlendBackdrop;
  private selectBackdrop(type: 3): BurikoPanBackdrop;
  private selectBackdrop(type: 4): BurikoMaskedBackdrop;
  private selectBackdrop(type: 5): BurikoDifferenceBackdrop;
  private selectBackdrop(type: 6): BurikoVectorBackdrop;
  private selectBackdrop(type: 7): BurikoBlurBackdrop;
  private selectBackdrop(type: 8): BurikoRippleBackdrop;
  private selectBackdrop(type: 9): BurikoStretchBackdrop;
  private selectBackdrop(type: 10): BurikoRotationBackdrop;
  private selectBackdrop(type: 11): BurikoMosaicBackdrop;
  private selectBackdrop(type: 12): BurikoMultilayerBackdrop;
  /** 086000 lifecycle for the concrete implemented types; no placeholder type fallback. */
  private selectBackdrop(type: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12): BurikoBackdrop {
    this.check();
    if (this.backdrop.backdropType !== type) {
      const previous = this.backdrop;
      this.lists.remove(previous);
      previous.dispose();
      this.backdropValue = null;
      const replacement =
        type === 1
          ? new BurikoNormalBackdrop(this.environment, this.surfaces)
          : type === 2
            ? new BurikoBlendBackdrop(this.environment, this.surfaces)
            : type === 3
              ? new BurikoPanBackdrop(this.environment, this.surfaces)
              : type === 4
                ? new BurikoMaskedBackdrop(this.environment, this.surfaces)
                : type === 5
                  ? new BurikoDifferenceBackdrop(this.environment, this.surfaces)
                  : type === 6
                    ? new BurikoVectorBackdrop(this.environment, this.surfaces)
                    : type === 7
                      ? new BurikoBlurBackdrop(this.environment, this.surfaces)
                      : type === 8
                        ? new BurikoRippleBackdrop(this.environment, this.surfaces)
                        : type === 9
                          ? new BurikoStretchBackdrop(this.environment, this.surfaces)
                          : type === 10
                            ? new BurikoRotationBackdrop(this.environment, this.surfaces)
                            : type === 11
                              ? new BurikoMosaicBackdrop(this.environment, this.surfaces)
                              : new BurikoMultilayerBackdrop(this.environment, this.surfaces);
      this.backdropValue = replacement;
      this.lists.insert(replacement);
      replacement.setActivation(this.backdropActivation);
      replacement.setContentEnabled(this.backdropContentEnabled);
    }
    const selected = this.backdrop;
    this.setBackdropRenderType(selected.backdropType);
    this.environment.damage.force();
    return selected;
  }
  /** 086800: layer zero source and transform precede activation, selection and virtual move. */
  configureMultilayerBackdrop(
    x: number,
    y: number,
    surface: number,
    pivotX: number,
    pivotY: number,
    angle: number,
    scaleX: number,
    scaleY: number,
    sampling: number,
  ): number {
    const backdrop = this.selectBackdrop(12);
    let status = backdrop.setLayerSurface(0, surface, pivotX, pivotY);
    if (status !== 0) return status === 0x80000002 ? 3 : x | 0;
    status = backdrop.setLayerTransform(0, angle, scaleX, scaleY, sampling);
    if (status !== 0) return status === 0x80000003 ? 4 : x | 0;
    backdrop.setLayerActivation(0, 1);
    backdrop.selectLayer(0);
    backdrop.move(x, y);
    return 0;
  }
  private mutateBackdropLayer(
    index: number,
    operation: (backdrop: BurikoMultilayerBackdrop) => number,
    damage: 'none' | 'always' | 'active',
  ): number {
    this.check();
    const backdrop = this.backdrop;
    if (backdrop.backdropType !== 12) return 1;
    if (!(backdrop instanceof BurikoMultilayerBackdrop))
      throw new Error('Buriko type12 backdrop has another concrete owner');
    const status = operation(backdrop);
    if (status !== 0) {
      if (status === 0x80000001) return 2;
      if (status === 0x80000002) return 3;
      if (status === 0x80000003) return 4;
      return index | 0;
    }
    if (damage === 'always' || (damage === 'active' && backdrop.layerActivation(index) !== 0))
      this.environment.damage.force();
    return 0;
  }
  selectBackdropLayer(index: number): number {
    return this.mutateBackdropLayer(index, (b) => b.selectLayer(index), 'none');
  }
  setBackdropLayerActivation(index: number, value: number): number {
    return this.mutateBackdropLayer(index, (b) => b.setLayerActivation(index, value), 'always');
  }
  setBackdropLayerPosition(index: number, x: number, y: number): number {
    return this.mutateBackdropLayer(index, (b) => b.setLayerPosition(index, x, y), 'active');
  }
  setBackdropLayerMode(index: number, value: number): number {
    return this.mutateBackdropLayer(index, (b) => b.setLayerMode(index, value), 'active');
  }
  setBackdropLayerLevel(index: number, value: number): number {
    return this.mutateBackdropLayer(index, (b) => b.setLayerLevel(index, value), 'active');
  }
  setBackdropLayerSurface(index: number, surface: number, x: number, y: number): number {
    return this.mutateBackdropLayer(
      index,
      (b) => b.setLayerSurface(index, surface, x, y),
      'active',
    );
  }
  setBackdropLayerTransform(
    index: number,
    angle: number,
    x: number,
    y: number,
    sampling: number,
  ): number {
    return this.mutateBackdropLayer(
      index,
      (b) => b.setLayerTransform(index, angle, x, y, sampling),
      'active',
    );
  }
  setBackdropLayerEasing(index: number, angle: number, scale: number): number {
    return this.mutateBackdropLayer(index, (b) => b.setLayerEasing(index, angle, scale), 'none');
  }
  setBackdropLayerPivotDelta(index: number, x: number, y: number): number {
    return this.mutateBackdropLayer(index, (b) => b.setLayerPivotDelta(index, x, y), 'none');
  }
  setBackdropLayerTransformDelta(index: number, angle: number, x: number, y: number): number {
    return this.mutateBackdropLayer(
      index,
      (b) => b.setLayerTransformDelta(index, angle, x, y),
      'none',
    );
  }
  private selectRippleBackdrop(): BurikoRippleBackdrop {
    return this.selectBackdrop(8);
  }
  /** 087030 selects first, then validates/stores the actual normal surface. */
  configureNormalBackdrop(surface: number): 0 | 1 {
    return this.selectBackdrop(1).setSurface(surface);
  }
  /** 086FC0 mutates virtual blend before validating the source pair. */
  configureBlendBackdrop(first: number, second: number, blend: number): 0 | 1 {
    const backdrop = this.selectBackdrop(2);
    backdrop.setBlendValue(blend);
    return backdrop.setSurfaces(first, second);
  }
  /** 086F30 commits valid coordinates before attempting all four source surfaces. */
  configurePanBackdrop(
    first: number,
    second: number,
    third: number,
    fourth: number,
    x: number,
    y: number,
  ): 0 | 1 | 2 {
    const backdrop = this.selectBackdrop(3);
    if (backdrop.setPan(x, y) === 0) return 1;
    return backdrop.setSurfaces(first, second, third, fourth) === 0 ? 2 : 0;
  }
  /** 086E30 commits sources, then mask, and sets blend only after both succeed. */
  configureMaskedBackdrop(
    firstX: number,
    firstY: number,
    first: number,
    secondX: number,
    secondY: number,
    second: number,
    mask: number,
    parameter: number,
    blend: number,
  ): 0 | 1 | 2 | 3 | 4 | 5 | -1 {
    const backdrop = this.selectBackdrop(4);
    const sources = backdrop.setSurfaces(firstX, firstY, first, secondX, secondY, second);
    if (sources !== 0) return sources === 0x80000001 ? 1 : sources === 0x80000002 ? 2 : -1;
    const status: number = backdrop.setMask(mask, parameter);
    if (status !== 0)
      return status === 0x80000003 ? 3 : status === 0x80000004 ? 4 : status === 0x80000005 ? 5 : -1;
    backdrop.setBlendValue(blend);
    return 0;
  }
  /** 086D90 sets the raw source selector before clearing/rebuilding difference tables. */
  configureDifferenceBackdrop(
    count: number,
    surfaces: readonly number[],
    selection: number,
  ): number {
    const backdrop = this.selectBackdrop(5);
    backdrop.setBlendValue(selection);
    const status: number = backdrop.setSurfaces(count, surfaces);
    return status === 0 ? 0 : status === 0x80000001 ? 1 : status === 0x80000002 ? 2 : count | 0;
  }
  /** 086CB0 sets blend and sampling only after all source/map validation succeeds. */
  configureVectorBackdrop(
    source: number,
    primary: number,
    secondary: number,
    effect: number,
    sampling: number,
  ): number {
    const backdrop = this.selectBackdrop(6);
    const status = backdrop.setSurfaces(source, primary, secondary);
    if (status === 0) {
      backdrop.setBlendValue(effect);
      backdrop.setSampling(sampling);
      return 0;
    }
    return status >= 0x80000001 && status <= 0x80000006 ? status - 0x80000000 : source | 0;
  }
  /** 086C00 commits source then selector, with blend written only after both succeed. */
  configureBlurBackdrop(source: number, selector: number, effect: number): number {
    const backdrop = this.selectBackdrop(7);
    const image = backdrop.setSurface(source);
    if (image !== 0) return image === 0x80000001 ? 1 : image === 0x80000002 ? 2 : source | 0;
    const status = backdrop.setSelector(selector);
    if (status !== 0) return status === 0x80000003 ? 3 : source | 0;
    backdrop.setBlendValue(effect);
    return 0;
  }
  /** 0868F0 configures pair, selector and second-source enable before publishing level. */
  configureMosaicBackdrop(
    first: number,
    second: number,
    selector: number,
    level: number,
    enabled: number,
  ): number {
    const backdrop = this.selectBackdrop(11);
    let status = backdrop.setSurfaces(first, second);
    if (status === 0) status = backdrop.setSelector(selector);
    if (status === 0) status = backdrop.setSecondEnabled(enabled);
    if (status === 0) {
      backdrop.setBlendValue(level);
      return 0;
    }
    return status >= 0x80000001 && status <= 0x80000004 ? status - 0x80000000 : first | 0;
  }
  /** 0869C0 commits source before base scale/angle and resets both deltas. */
  configureRotationBackdrop(source: number, scale: number, angle: number): number {
    const backdrop = this.selectBackdrop(10);
    const image = backdrop.setSurface(source);
    if (image !== 0) return image === 0x80000001 ? 1 : source | 0;
    const status = backdrop.setBase(scale, angle);
    return status === 0 ? 0 : status === 0x80000002 ? 2 : source | 0;
  }
  /** 086A60 commits source and window size before publishing Q16 sampling position. */
  configureStretchBackdrop(
    source: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): number {
    const backdrop = this.selectBackdrop(9);
    const image = backdrop.setSurface(source);
    if (image !== 0) return image === 0x80000001 ? 1 : source | 0;
    const status = backdrop.setExtent(width, height);
    if (status !== 0) return status === 0x80000002 ? 2 : source | 0;
    backdrop.move(x << 16, y << 16);
    return 0;
  }
  /** 07F090 dispatches the real D8 virtual (055130 for all verified native families). */
  runObjectDefaultOperation(handle: number): 0 | 3 | 4 | -1 {
    const object = this.resolve(handle);
    if (object === null) return -1;
    const status = object.defaultOperation() >>> 0;
    return status === 0 ? 0 : status === 0x80000001 ? 3 : status === 0x80000002 ? 4 : -1;
  }
  /** 086B10 installs the source before map/table configuration and keeps either on failure. */
  configureRippleBackdrop(
    sourceSurface: number,
    mapSurface: number,
    gradientCount: number,
    coefficientSlot: number,
    blend: number,
  ): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 {
    const backdrop = this.selectRippleBackdrop(),
      source = backdrop.setSourceSurface(sourceSurface);
    if (source !== 0) return source === 0x80000001 ? 1 : 2;
    const configured: BurikoRippleBackdropStatus = backdrop.configureMap(
      mapSurface,
      gradientCount,
      coefficientSlot,
      blend,
    );
    switch (configured) {
      case 0:
        return 0;
      case 0x80000003:
        return 3;
      case 0x80000004:
        return 4;
      case 0x80000005:
        return 5;
      case 0x80000006:
        return 6;
      case 0x80000007:
        return 7;
      default:
        throw new Error('Buriko ripple backdrop returned an unknown native configuration status');
    }
  }
  /** 080170; this reference point is separate from global origin and presentation shake. */
  setReferencePoint(x: number, y: number): void {
    this.check();
    this.referencePoint.x = x | 0;
    this.referencePoint.y = y | 0;
    this.environment.damage.force();
  }
  /** 07fdc0 reaches the native empty 056d00 hook before forcing full damage. */
  invalidateScene(): void {
    this.check();
    this.environment.damage.force();
  }
  /** 080140/056ce0 updates independent global 1d1d20. */
  setOrigin(x: number, y: number): void {
    this.check();
    this.environment.origin.x = x | 0;
    this.environment.origin.y = y | 0;
    this.environment.damage.force();
  }
  /** 07fd90/06ee70 changes the minimum layer key, then requests full damage. */
  setMinimumLayer(layer: number): void {
    this.check();
    this.minimumKey = (layer << 16) >>> 0;
    this.environment.damage.force();
  }
  /** 0802B0 keeps this manager and its backdrop alive across an ECB90 program reset.
   * Rain is deliberately absent from the native pool-clear call sequence. */
  resetForProgram(windows: BurikoWindowDisplayState): void {
    this.check();
    if (windows.manager !== this)
      throw new Error('Buriko display restart requires its shared Window state');
    this.clearDamage();
    this.clearObjectLists();
    this.lists.insert(this.backdrop);
    this.setBackdropActivation(1, 0);
    for (const family of [
      'sprite',
      'filter',
      'effector',
      'map',
      'landscape',
      'window',
      'particle',
      'knob',
      'group',
    ] as const)
      this.clearPool(family);
    windows.set(0, 0);
    this.invalidateScene();
    this.setReferencePoint(-1, -1);
    this.setOrigin(0, 0);
    this.setMinimumLayer(0);
  }
  /** 0803a0 clears the CObjectManager before deleting backdrop, groups, knobs, then draw pools. */
  override dispose(): void {
    this.check();
    super.dispose();
    this.backdrop.dispose();
    for (const family of [
      'group',
      'knob',
      'sprite',
      'filter',
      'effector',
      'map',
      'landscape',
      'window',
      'particle',
      'rain',
    ] as const)
      this.clearPool(family);
    this.disposed = true;
  }
}
