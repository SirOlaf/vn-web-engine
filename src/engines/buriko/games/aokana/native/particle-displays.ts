import type {AokanaBitmap} from './bitmap.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDisplayManager} from './display-manager.js';
import {AokanaParticleDisplayObject, type AokanaParticleDwordReader} from './display-particle.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import type {AokanaParticleVariants} from './particle-images.js';
import type {AokanaCrtRandom} from './system-timing.js';

/** 274328 is a real separate linked refresh schedule, not a replacement display pool. */
export interface AokanaParticleRefreshNode {
  handle: number;
  interval: number;
  nextTick: number;
  next: AokanaParticleRefreshNode | null;
}

/** C0 particle services resolve every display through the shared manager's actual eight slots. */
export class AokanaParticleDisplays {
  scheduleHead: AokanaParticleRefreshNode | null = null;
  imageTimingMode = 0; // 2742d4 is initially zero.
  constructor(
    readonly manager: AokanaDisplayManager,
    readonly variants: AokanaParticleVariants,
    readonly random: AokanaCrtRandom,
    readonly clock: AokanaNativeClock,
    readonly processing: AokanaDistributedProcessing,
  ) {}
  find(handle: number): AokanaParticleDisplayObject | null {
    return this.manager.find('particle', handle) as AokanaParticleDisplayObject | null;
  }
  create(width: number, height: number): {result: 0; handle: number} | {result: 1 | 2} {
    return this.manager.createConfigured(
      'particle',
      (order) =>
        new AokanaParticleDisplayObject(
          this.manager.environment,
          order,
          this.variants,
          this.random,
          this.clock,
          this.processing,
        ),
      (object) => object.configureParticle(width, height),
    );
  }
  remove(handle: number): boolean {
    return this.manager.destroy('particle', handle);
  }
  apply(handle: number, action: (object: AokanaParticleDisplayObject) => void): boolean {
    const object = this.find(handle);
    if (object === null) return false;
    action(object);
    return true;
  }
  setActivation(handle: number, value: number): boolean {
    return this.apply(handle, (object) => {
      const previous = object.inputActive();
      object.setActivation(value);
      if (object.inputActive() !== previous) object.invalidate();
    });
  }
  configureDisplay(
    handle: number,
    x: number,
    y: number,
    mode: number,
    value: number,
    layer: number,
  ): boolean {
    return this.apply(handle, (object) => {
      if (object.inputActive()) object.invalidate();
      object.configureDisplay(x, y, mode, value, layer);
      if (object.inputActive()) object.invalidate();
      this.manager.lists.resort(object);
    });
  }
  configureLayers(
    handle: number,
    count: number,
    depths: AokanaParticleDwordReader,
    offsets: AokanaParticleDwordReader,
  ): number {
    const object = this.find(handle);
    if (object === null) return 0xffffffff;
    const result = object.configureLayers(count, depths, offsets);
    if (result === 0) {
      if (object.inputActive()) object.invalidate();
      this.manager.lists.resort(object);
      return 0;
    }
    return result === 0x80000001 ? 7 : result === 0x80000004 ? 8 : handle >>> 0;
  }
  refresh(handle: number): boolean {
    return this.apply(handle, (object) => object.refreshParticle());
  }
  warmUp(handle: number, iterations: number): boolean {
    return this.apply(handle, (object) => object.controller.warmUp(iterations));
  }
  /** 0f2380 appends a new schedule node, but interval changes retain its timestamp. */
  setRefreshInterval(handle: number, interval: number): boolean {
    handle >>>= 0;
    interval >>>= 0;
    if (this.find(handle) === null) return false;
    let previous: AokanaParticleRefreshNode | null = null;
    let node = this.scheduleHead;
    while (node !== null && node.handle !== handle) {
      previous = node;
      node = node.next;
    }
    if (interval === 0) {
      if (node !== null) {
        if (previous === null) this.scheduleHead = node.next;
        else previous.next = node.next;
      }
    } else {
      if (node === null) {
        node = {
          handle,
          interval,
          nextTick: Number(BigInt.asUintN(32, this.clock.read())),
          next: null,
        };
        if (previous === null) this.scheduleHead = node;
        else previous.next = node;
      }
      node.interval = interval;
    }
    return true;
  }
  configureCamera(handle: number, values: readonly number[]): number {
    const object = this.find(handle);
    return object === null ? 0xffffffff : object.configureCamera(values) ? 0 : 3;
  }
  setInterval(handle: number, interval: number): number {
    const object = this.find(handle);
    return object === null ? 0xffffffff : object.controller.setInterval(interval) ? 0 : 4;
  }
  setTarget(handle: number, kind: 0 | 1, variant: number, count: number, interval: number): number {
    const object = this.find(handle);
    if (object === null) return 0xffffffff;
    const result = object.controller.setTarget(kind, variant, count, interval);
    return result === 0 ? 0 : result === 0x80000002 ? 10 : result === 0x80000003 ? 6 : handle >>> 0;
  }
  configureMovement(handle: number, variant: number, values: readonly number[]): number {
    const object = this.find(handle);
    if (object === null) return 0xffffffff;
    const result = object.controller.configureMovement(variant, values);
    return result === 0 ? 0 : result === 0x80000002 ? 10 : handle >>> 0;
  }
  setImageTimingMode(mode: number): boolean {
    mode >>>= 0;
    if (mode >= 3) return false;
    this.imageTimingMode = mode;
    return true;
  }
  private imageRates(duration: number, spread: number, frames: number): [number, number] {
    duration >>>= 0;
    spread >>>= 0;
    const numerator = (frames << 16) >>> 0;
    const base = duration === 0 ? 0 : Math.floor(numerator / duration) >>> 0;
    if (this.imageTimingMode === 0)
      return [base, spread === 0 ? 0 : Math.floor(numerator / spread) >>> 0];
    if (this.imageTimingMode === 1) {
      if (duration === 0 || spread === 0) return [base, 0];
      const denominator = (duration + spread) >>> 0;
      if (denominator === 0) throw new RangeError('Aokana particle image duration divides by zero');
      return [base, (Math.floor(numerator / denominator) - base) >>> 0];
    }
    if (duration === 0) return [base, 0];
    const product = BigInt.asIntN(64, BigInt(base) * BigInt(spread));
    return [base, Number(BigInt.asUintN(32, product / BigInt(duration)))];
  }
  /** 0f21d0/0f25a0 copy all requested surface descriptors before checking the type/variant. */
  configureImages(
    kind: number,
    variant: number,
    count: number,
    surface: number,
    duration: number,
    spread: number,
    frames: number,
    specialOption?: number,
  ): number {
    count >>>= 0;
    surface >>>= 0;
    let bitmaps: AokanaBitmap[] | null = null;
    if (count !== 0 && surface !== 0xffffffff) {
      bitmaps = [];
      for (let i = 0; i < count; i++) {
        const bitmap = this.manager.surfaces.snapshot((surface + i) >>> 0);
        if (bitmap === null) return 0x80000004;
        bitmaps.push(bitmap);
      }
    }
    const [rate, rateSpread] = this.imageRates(duration, spread, frames);
    kind >>>= 0;
    if (specialOption === undefined ? kind > 1 : kind !== 1) return 0x80000001;
    const result = this.variants.configureImages(
      specialOption !== undefined ? 'special' : kind === 0 ? 'snow' : 'firefly',
      variant,
      bitmaps,
      count,
      rate,
      rateSpread,
      specialOption,
    );
    const mapped =
      result === 0
        ? 0
        : result === 0x80000001
          ? 0x80000002
          : result === 0x80000003
            ? 0x80000005
            : 0x80000006;
    if (mapped === 0 && specialOption !== undefined) {
      for (let i = 0; i < 8; i++)
        this.find((0xc0000000 | i) >>> 0)?.controller.refreshSpecial(kind, variant);
    }
    return mapped;
  }
  setSpecialOption(kind: number, variant: number, option: number): number {
    if ((kind | 0) !== 1) return 0x80000001;
    const result = this.variants.setSpecialOption(variant, option);
    return result === 0 ? 0 : result === 0x80000001 ? 0x80000002 : 0x80000007;
  }
}
