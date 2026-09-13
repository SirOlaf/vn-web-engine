import {AokanaBackdrop, AokanaNormalBackdrop} from './display-backdrop.js';
import {AokanaDisplayObject, AokanaDisplayObjectEnvironment} from './display-object.js';
import {AokanaDisplayRedraw} from './display-redraw.js';
import {AokanaNativeDisplayState} from './display-state.js';
import {AokanaSurfaces} from './surfaces.js';
import {aokanaBitmapPixelSize, type AokanaBitmapRectangle} from './bitmap.js';
import type {AokanaDisplayContext} from './display-object.js';
import {AokanaDisplayEffectorRegistry} from './display-effector-registry.js';
import type {AokanaDisplayDamageResult} from './display-renderer.js';
import {AokanaObjectManager} from './object-manager.js';
import {AokanaNativeLocks, createAokanaDisplayLocks} from './exclusion-locks.js';
import {AokanaDisplayTexture} from './display-texture.js';

/** The ten native pools; their category selectors are independent of CDspObj +1c. */
export const AOKANA_DISPLAY_POOLS = Object.freeze({
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
export type AokanaDisplayFamily = keyof typeof AOKANA_DISPLAY_POOLS;
export type AokanaConfiguredDisplayFamily = 'window' | 'particle' | 'rain';
export type AokanaSimpleDisplayFamily = Exclude<
  AokanaDisplayFamily,
  AokanaConfiguredDisplayFamily | 'knob'
>;
export type AokanaDisplayCreateResult<Failure extends number> =
  {result: 0; handle: number} | {result: Failure};
type ConfigurationFailure<Family extends AokanaConfiguredDisplayFamily> = Family extends 'window'
  ? 9 | 10
  : Family extends 'rain'
    ? 1 | 3
    : 1 | 2;
interface Pool {
  slots: (AokanaDisplayObject | null)[];
  count: number;
  creationCount: number;
}

/**
 * The actual shared display manager at 1e8d50, constructed by 080430. Class owners
 * supply their real constructors/configuration methods to these native pool paths;
 * an absent class is never replaced by a base object or a successful factory.
 * Window/device presentation and scene-bank coverage are separate from this layer.
 */
export class AokanaDisplayManager extends AokanaObjectManager {
  private readonly pools: Record<AokanaDisplayFamily, Pool> = Object.fromEntries(
    Object.entries(AOKANA_DISPLAY_POOLS).map(([family, definition]) => [
      family,
      {slots: Array(definition.capacity).fill(null), count: 0, creationCount: 0},
    ]),
  ) as Record<AokanaDisplayFamily, Pool>;
  readonly backdrop: AokanaBackdrop;
  private disposed = false;
  private texture: AokanaDisplayTexture | null = null;
  private textureLocked = 0;
  backdropActivation = 1;
  backdropContentEnabled = 0;
  readonly referencePoint = {x: -1, y: -1};

  constructor(
    readonly environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
    readonly displayState: AokanaNativeDisplayState,
    readonly redraw = new AokanaDisplayRedraw(),
    readonly locks: AokanaNativeLocks = createAokanaDisplayLocks(surfaces.allocator),
  ) {
    super(environment.compositor, surfaces.allocator, environment.damage,
      () => environment.displayContext, new AokanaDisplayEffectorRegistry());
    redraw.bindLocks(locks);
    this.backdrop = new AokanaNormalBackdrop(environment, surfaces);
    this.setBackdropRenderType(this.backdrop.backdropType);
    this.lists.insert(this.backdrop);
    this.setBackdropActivation(1, 0);
  }
  private check(): void {
    if (this.disposed) throw new Error('Aokana accesses a deleted display manager');
  }
  get visibleRectangle(): AokanaBitmapRectangle {
    this.check();
    if (this.environment.displayContext === null)
      throw new Error('Aokana display descriptor has not been configured');
    return this.environment.displayContext.bounds;
  }
  /** The device controller installs the one shared descriptor/rectangle storage. */
  bindDisplayContext(context: AokanaDisplayContext): void {
    this.check();
    this.environment.displayContext = context;
    this.environment.damage.clip = context.bounds;
  }
  /** 07ff70 only replaces +68; it does not acquire a reference or alter +70. */
  setDisplayTexture(texture: AokanaDisplayTexture | null): void {
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
  private displayContext(): AokanaDisplayContext {
    const context = this.environment.displayContext;
    if (context === null) throw new Error('Aokana display descriptor has not been configured');
    return context;
  }
  /** 07fde0 leaves its caller's count untouched when the display cannot be locked. */
  drawDamage(output: AokanaDisplayDamageResult): 0 | 1 {
    this.check();
    if (this.objectRenderer === null)
      throw new Error('Aokana object renderer has not been attached');
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
      throw new Error('Aokana object renderer has not been attached');
    if (this.lockDisplay() === 0) return 0;
    this.objectRenderer.drawFull();
    this.unlockDisplay();
    return 1;
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
    bitmap.bytesPerPixel = aokanaBitmapPixelSize(format);
    bounds.left = bounds.top = 0;
    bounds.right = (width - 1) | 0;
    bounds.bottom = (height - 1) | 0;
    this.backdrop.resizeToDisplay();
    for (const family of ['filter', 'effector', 'window'] as const)
      for (let slot = 0; slot < AOKANA_DISPLAY_POOLS[family].capacity; slot++) {
        const object = this.pools[family].slots[slot];
        if (object === null || object === undefined) continue;
        if (family === 'window') {
          if (
            !('refreshDisplayGeometry' in object) ||
            typeof object.refreshDisplayGeometry !== 'function'
          )
            throw new Error('Aokana concrete window display geometry hook is absent');
          object.refreshDisplayGeometry();
        } else {
          if (!('resizeToDisplay' in object) || typeof object.resizeToDisplay !== 'function')
            throw new Error(`Aokana concrete ${family} display resize hook is absent`);
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
    for (const family of Object.keys(AOKANA_DISPLAY_POOLS) as AokanaDisplayFamily[])
      if (AOKANA_DISPLAY_POOLS[family].category === category >>> 0)
        return this.pools[family].count >>> 0;
    return 0xffffffff;
  }
  creationCount(family: AokanaDisplayFamily): number {
    this.check();
    return this.pools[family].creationCount >>> 0;
  }
  /** A copied view for native family traversals; only this manager mutates pool slots. */
  poolObjects(family: AokanaDisplayFamily): readonly (AokanaDisplayObject | null)[] {
    this.check();
    return this.pools[family].slots.slice();
  }
  find(family: AokanaDisplayFamily, handle: number): AokanaDisplayObject | null {
    this.check();
    const definition = AOKANA_DISPLAY_POOLS[family];
    handle >>>= 0;
    const index = handle & 0xffffff;
    return (handle & 0xff000000) >>> 0 === definition.prefix && index < definition.capacity
      ? this.pools[family].slots[index]!
      : null;
  }
  /** 087090 reserves zero for the root backdrop and tries the native families in order. */
  resolve(handle: number): AokanaDisplayObject | null {
    this.check();
    if (handle >>> 0 === 0) return this.backdrop;
    for (const family of Object.keys(AOKANA_DISPLAY_POOLS) as AokanaDisplayFamily[]) {
      const object = this.find(family, handle);
      if (object !== null) return object;
    }
    return null;
  }
  private firstEmpty(family: AokanaDisplayFamily): number {
    const index = this.pools[family].slots.indexOf(null);
    if (index < 0) throw new RangeError('Aokana display slot search exceeds its native pool');
    return index;
  }
  private construct<T extends AokanaDisplayObject>(
    family: AokanaDisplayFamily,
    construct: (creationOrder: number) => T,
  ): T {
    const pool = this.pools[family];
    const order = pool.creationCount;
    pool.creationCount = (order + 1) >>> 0;
    return construct(order);
  }
  /** 085e50/084fd0/084c00/0844f0/083f00/080b40 return the handle or zero. */
  createSimple<T extends AokanaDisplayObject>(
    family: AokanaSimpleDisplayFamily,
    construct: (creationOrder: number) => T,
  ): number {
    this.check();
    if (family === 'sprite') this.enterSpriteLock();
    const pool = this.pools[family],
      definition = AOKANA_DISPLAY_POOLS[family];
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
        throw new Error('Aokana display handle assignment has no current slot object');
      stored.handle = handle;
    }
    if (family === 'sprite') this.leaveSpriteLock();
    return handle;
  }
  /**
   * 083350/0824e0/081a40 configure before publishing the slot. Rain alone uses
   * zero as success. Slot and count precede list insertion and handle assignment.
   */
  createConfigured<Family extends AokanaConfiguredDisplayFamily, T extends AokanaDisplayObject>(
    family: Family,
    construct: (creationOrder: number) => T,
    configure: (object: T) => number,
  ): AokanaDisplayCreateResult<ConfigurationFailure<Family>> {
    this.check();
    const pool = this.pools[family],
      definition = AOKANA_DISPLAY_POOLS[family];
    const failure = (result: number): AokanaDisplayCreateResult<ConfigurationFailure<Family>> =>
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
  createKnob<T extends AokanaDisplayObject>(
    targetHandle: number,
    construct: (creationOrder: number, target: AokanaDisplayObject) => T,
  ): AokanaDisplayCreateResult<1 | 2 | 3> {
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
  /** Pool-specific native removal; group and knob never enter the draw lists. */
  destroy(family: AokanaDisplayFamily, handle: number): boolean {
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
  clearPool(family: AokanaDisplayFamily): void {
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
  /** 07fb30 uses the nonvirtual 056620 setter between the two virtual visibility reads. */
  setSecondaryVisibility(handle: number, value: number): boolean {
    const object = this.resolve(handle);
    if (object === null) return false;
    const before = object.inputActive() !== 0;
    AokanaDisplayObject.prototype.setSecondaryVisibility.call(object, value);
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
  /** 085fb0 changes the backdrop switches and requests full damage unconditionally. */
  setBackdropActivation(activation: number, contentEnabled: number): void {
    this.check();
    this.backdropActivation = activation | 0;
    this.backdropContentEnabled = contentEnabled | 0;
    this.backdrop.setActivation(activation);
    this.backdrop.setContentEnabled(contentEnabled);
    this.environment.damage.force();
  }
  /** 080170; this reference point is separate from global origin and presentation shake. */
  setReferencePoint(x: number, y: number): void {
    this.check();
    this.referencePoint.x = x | 0;
    this.referencePoint.y = y | 0;
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
