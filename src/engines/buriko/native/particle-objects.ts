import {nativeParticleSineCosine} from '../bp/opcodes/native-math.js';
import {allocateBurikoBitmap, fillBurikoBitmap, type BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {mixBurikoBitmaps} from './bitmap-mix.js';
import {burikoParticleRandom, type BurikoParticleVector} from './particle-air.js';
import {BurikoParticleImages, BurikoParticleVariants} from './particle-images.js';
import type {BurikoCrtRandom} from './system-timing.js';

const absolute = (value: number): number => ((value ^ (value >> 31)) - (value >> 31)) | 0;
function int32(value: number): number {
  value = Math.trunc(value);
  return !Number.isFinite(value) || value < -2147483648 || value > 2147483647
    ? -2147483648
    : value | 0;
}
function int64Low(value: number): number {
  if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63) return 0;
  return Number(BigInt.asIntN(32, BigInt(Math.trunc(value))));
}
function divide(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -2147483648 && denominator === -1))
    throw new RangeError('Buriko particle signed division is outside its numerical domain');
  return Math.trunc(numerator / denominator) | 0;
}
function required(value: number | undefined): number {
  if (value === undefined) throw new Error('Buriko particle reads an unconfigured numeric field');
  return value;
}

/** Native controller-owned 38h movement record; only six constructor words are initialized. */
export class BurikoFireflyMovement {
  private readonly words: Array<number | undefined> = new Array(14);
  constructor() {
    this.words[0] = this.words[1] = this.words[2] = this.words[3] = 0;
    this.words[10] = 1;
    this.words[11] = 0;
  }
  get(index: number): number {
    return required(this.words[index]);
  }
  /** 0987f0, the exact fourteen input DWORD conversions. */
  configure(values: readonly number[]): void {
    if (values.length !== 14)
      throw new Error('Buriko firefly movement requires fourteen DWORD values');
    for (let i = 0; i < 14; i++) {
      let value = values[i]! | 0;
      if ([1, 4, 5, 13].includes(i)) value = absolute(value) >> 8;
      else if ([0, 2, 12].includes(i)) value >>= 8;
      else if ([6, 7, 8].includes(i)) value = absolute(value);
      this.words[i] = value;
    }
  }
}

/** DCParticle, 096000, with the five concrete base virtual methods at 17f248. */
export class BurikoParticle {
  active = 0;
  protected point: BurikoParticleVector | undefined;
  protected airScale: number | undefined;
  protected mode: number | undefined;
  protected transparencyValue: number | undefined;
  private framePosition = 0;
  private specialFramePosition = 0;
  private readonly frameIncrement: number;
  private specialFrameIncrement: number;
  private specialFrameCount: number;

  constructor(
    readonly kind: 0 | 1,
    readonly variant: number,
    protected readonly images: BurikoParticleImages,
    protected readonly random: BurikoCrtRandom,
  ) {
    this.frameIncrement =
      (burikoParticleRandom(random, images.durationSpread) + images.duration) | 0;
    this.specialFrameIncrement = this.frameIncrement;
    this.specialFrameCount = images.count;
  }
  position(): BurikoParticleVector {
    if (this.point === undefined) throw new Error('Buriko particle reads unconfigured position');
    return {...this.point};
  }
  blendMode(): number {
    return required(this.mode);
  }
  /** 095bb0/095ba0 read only the high WORD of the corresponding Q16 counters. */
  frame(): number {
    return this.framePosition >>> 16;
  }
  specialFrame(): number {
    return this.specialFramePosition >>> 16;
  }

  /** 095b60 intentionally replaces secondary timing/count without replacing the primary image record. */
  configureSpecialFrames(images: BurikoParticleImages): void {
    this.specialFrameIncrement =
      (burikoParticleRandom(this.random, images.durationSpread) + images.duration) | 0;
    this.specialFrameCount = images.count;
  }
  /** 095c50 applies current environment displacement only to active particles. */
  applyAir(vector: BurikoParticleVector): void {
    if (this.active === 0) return;
    const point = this.point,
      scale = required(this.airScale);
    if (point === undefined) throw new Error('Buriko particle air reads unconfigured position');
    point.x = (point.x + (Math.imul(vector.x, scale) >> 8)) | 0;
    point.y = (point.y + (Math.imul(vector.y, scale) >> 8)) | 0;
    point.z = (point.z + (Math.imul(vector.z, scale) >> 8)) | 0;
  }
  /** 095be0 increments both counters even when inactive. */
  update(): number {
    this.framePosition = (this.framePosition + this.frameIncrement) >>> 0;
    this.specialFramePosition = (this.specialFramePosition + this.specialFrameIncrement) >>> 0;
    if (this.images.count !== 0) this.framePosition %= this.images.count << 16;
    if (this.specialFrameCount !== 0) this.specialFramePosition %= this.specialFrameCount << 16;
    return this.active;
  }
  /** Native base image/cleanup virtual methods are constant zero. */
  image(_scale: number): BurikoBitmap | null {
    return null;
  }
  releaseImage(): number {
    return 0;
  }
  /** 095fe0/09a830 restore the base vtable without releasing shared variant images. */
  dispose(): void {}
  transparency(): number {
    return required(this.transparencyValue);
  }
}

/** DCPSnow, constructor09ab90, update09a770 and image selector09a7b0. */
export class BurikoSnowParticle extends BurikoParticle {
  private velocity: BurikoParticleVector | undefined;
  constructor(variant: number, variants: BurikoParticleVariants, random: BurikoCrtRandom) {
    const images = variants.snowImages[variant >>> 0];
    if (images === undefined)
      throw new RangeError('Buriko snow variant is outside its native table');
    super(0, variant >>> 0, images, random);
    const p = variants.snowParameters[variant >>> 0]!;
    if (p[0] === 0) return;
    const around = (center: number, spread: number): number =>
      (burikoParticleRandom(random, Math.imul(spread, 2)) + (center - spread)) | 0;
    this.point = {x: around(0, p[1]!), y: p[2]!, z: around(0, p[3]!)};
    this.velocity = {x: around(p[4]!, p[5]!), y: around(p[6]!, p[7]!), z: around(p[8]!, p[9]!)};
    this.airScale = p[10]!;
    this.mode = 0x20;
    this.transparencyValue = 0;
    this.active = 1;
  }
  override update(): number {
    super.update();
    if (this.active !== 0) {
      const p = this.point!,
        v = this.velocity!;
      p.x = (p.x + v.x) | 0;
      p.y = (p.y + v.y) | 0;
      p.z = (p.z + v.z) | 0;
    }
    return this.active;
  }
  override image(scale: number): BurikoBitmap | null {
    scale >>>= 0;
    if (scale >= 32) return null;
    const bitmap = this.images.scales[scale]?.[this.frame()];
    if (bitmap === undefined) throw new Error('Buriko snow image descriptor is absent');
    return bitmap.storage === null ? null : bitmap;
  }
}

/** DCPFirefly, 09a5f0: lifespan, interpolated movement, fades and optional mixed image. */
export class BurikoFireflyParticle extends BurikoParticle {
  private lifetime: number | undefined;
  private age: number | undefined;
  private firstVelocity: BurikoParticleVector | undefined;
  private nextVelocity: BurikoParticleVector | undefined;
  private transitionDuration: number | undefined;
  private transitionAge: number | undefined;
  private fadeIn: number | undefined;
  private fadeOut: number | undefined;
  private mixedImage: BurikoBitmap | null = null;

  /** 099c90 releases only this particle's temporary mixed image before the base destructor. */
  override dispose(): void {
    this.releaseImage();
    super.dispose();
  }

  constructor(
    variant: number,
    private readonly variants: BurikoParticleVariants,
    random: BurikoCrtRandom,
    readonly movement: BurikoFireflyMovement,
    private readonly compositor: BurikoBitmapCompositor,
  ) {
    const images = variants.fireflyImages[variant >>> 0];
    if (images === undefined)
      throw new RangeError('Buriko firefly variant is outside its native table');
    super(1, variant >>> 0, images, random);
    const p = variants.fireflyParameters[variant >>> 0]!;
    if (p[0] === 0) return;
    this.lifetime = (burikoParticleRandom(random, p[2]!) + p[1]!) >>> 0;
    this.age = 0;
    this.point = {
      x: this.around(movement.get(0), p[3]!),
      y: this.around(p[4]!, movement.get(1)),
      z: this.around(movement.get(2), p[5]!),
    };
    this.nextVelocity = this.randomVelocity();
    this.normalizeVelocity(true);
    this.beginTransition();
    this.airScale = p[14]!;
    this.fadeIn = p[15]!;
    this.fadeOut = p[16]!;
    this.mode = p[17]!;
    this.active = 1;
  }
  private around(center: number, spread: number): number {
    return (burikoParticleRandom(this.random, Math.imul(spread, 2)) + (center - spread)) | 0;
  }
  private randomVelocity(): BurikoParticleVector {
    const p = this.variants.fireflyParameters[this.variant]!;
    return {
      x: this.around(p[6]!, p[7]!),
      y: this.around(p[8]!, p[9]!),
      z: this.around(p[10]!, p[11]!),
    };
  }
  /** 0996e0 computes attenuation before the random magnitude, in the native SSE2 order. */
  private normalizeVelocity(adjustLifetime: boolean): void {
    const p = this.movement;
    if (p.get(3) === 0) return;
    const v = this.nextVelocity!;
    let length = Math.sqrt(v.y * v.y + v.x * v.x + v.z * v.z);
    if (length === 0) length = 1;
    const yFactor = 1 - (Math.abs(v.y) / length) * ((65536 - p.get(7)) | 0) * (1 / 65536);
    const xFactor = 1 - (Math.abs(v.x) / length) * ((65536 - p.get(6)) | 0) * (1 / 65536);
    const zFactor = 1 - (Math.abs(v.z) / length) * ((65536 - p.get(8)) | 0) * (1 / 65536);
    const attenuation = yFactor * xFactor * zFactor;
    const magnitude = (burikoParticleRandom(this.random, p.get(5)) + p.get(4)) | 0;
    const multiplier = (magnitude * attenuation) / length;
    this.nextVelocity = {
      x: int32(multiplier * v.x),
      y: int32(multiplier * v.y),
      z: int32(multiplier * v.z),
    };
    if (adjustLifetime && p.get(9) !== 0 && p.get(4) > 0)
      this.lifetime = int64Low((p.get(4) * (required(this.lifetime) >>> 0)) / magnitude) >>> 0;
  }
  /** 099d10 rotates all axes by the same randomized angle or chooses a new normalized velocity. */
  private beginTransition(): void {
    const v = this.nextVelocity!;
    this.firstVelocity = {...v};
    const p = this.movement;
    if (p.get(11) === 0) {
      this.nextVelocity = this.randomVelocity();
      this.normalizeVelocity(false);
    } else {
      const angle = this.around(p.get(12), p.get(13));
      const {sine: s, cosine: c} = nativeParticleSineCosine(angle);
      const y = c * v.y - s * v.z,
        z = c * v.z + s * v.y;
      const nextZ = c * z - s * v.x,
        x = s * z + c * v.x;
      const nextY = c * y + s * x,
        nextX = c * x - s * y;
      const round = (value: number): number => int32(value < 0 ? value - 0.5 : value + 0.5);
      this.nextVelocity = {x: round(nextX), y: round(nextY), z: round(nextZ)};
    }
    const global = this.variants.fireflyParameters[this.variant]!;
    this.transitionDuration = (burikoParticleRandom(this.random, global[13]!) + global[12]!) | 0;
    if (this.transitionDuration === 0) this.transitionDuration = 1;
    this.transitionAge = 0;
  }
  override update(): number {
    super.update();
    if (this.active === 0) return 0;
    const oldAge = required(this.age) >>> 0;
    this.age = (oldAge + 1) >>> 0;
    if (required(this.lifetime) >>> 0 <= oldAge) return 0;
    const age = required(this.transitionAge) >>> 0,
      duration = required(this.transitionDuration);
    const first = this.firstVelocity!,
      next = this.nextVelocity!,
      point = this.point!;
    // Native evaluates Y/Z/X divisions, then stores X/Y/Z positions.
    const y = (first.y + divide(Math.imul((next.y - first.y) | 0, age), duration)) | 0;
    const z = (first.z + divide(Math.imul((next.z - first.z) | 0, age), duration)) | 0;
    const x = (first.x + divide(Math.imul((next.x - first.x) | 0, age), duration)) | 0;
    point.x = (point.x + x) | 0;
    point.y = (point.y + y) | 0;
    point.z = (point.z + z) | 0;
    if (duration >>> 0 <= age) this.beginTransition();
    else if (this.movement.get(10) !== 0) this.transitionAge = (age + 1) >>> 0;
    return 1;
  }
  override transparency(): number {
    if (this.active !== 0) {
      const age = required(this.age) >>> 0,
        remaining = (required(this.lifetime) - age) >>> 0;
      const fadeOut = required(this.fadeOut) >>> 0,
        fadeIn = required(this.fadeIn) >>> 0;
      if (remaining < fadeOut) return (256 - Math.floor(((remaining * 256) >>> 0) / fadeOut)) | 0;
      if (age < fadeIn) return (256 - Math.floor(((age << 8) >>> 0) / fadeIn)) | 0;
    }
    return 0;
  }
  /** 099cd0 filters the requested variant before changing secondary timing. */
  refreshSpecial(variant: number): boolean {
    if (variant >>> 0 !== this.variant) return false;
    this.configureSpecialFrames(this.variants.specialFireflyImages[this.variant]!);
    return true;
  }
  override releaseImage(): number {
    if (this.mixedImage === null) return 0;
    this.mixedImage.storage?.release();
    this.mixedImage = null;
    return 1;
  }
  override image(scale: number): BurikoBitmap | null {
    scale >>>= 0;
    if (scale >= 32) return null;
    const base = this.images.scales[scale]?.[this.frame()];
    if (base === undefined) throw new Error('Buriko firefly image descriptor is absent');
    if (base.storage === null) return null;
    const option = this.variants.specialOptions[this.variant]!;
    if (option === 0) return base;
    this.releaseImage();
    const special =
      this.variants.specialFireflyImages[this.variant]!.scales[scale]?.[this.specialFrame()];
    if (special === undefined) throw new Error('Buriko special firefly image descriptor is absent');
    const width = Math.max(base.width >>> 0, special.width >>> 0),
      height = Math.max(base.height >>> 0, special.height >>> 0);
    const output = allocateBurikoBitmap(width, height, base.format);
    this.mixedImage = output;
    fillBurikoBitmap(output, 0);
    this.compositor.draw(
      output,
      (width - base.width) >>> 1,
      (height - base.height) >>> 1,
      base,
      0x80,
      0,
    );
    if (special.width === width && special.height === height)
      mixBurikoBitmaps(output, output, special, option, this.compositor.processing);
    else {
      const expanded = allocateBurikoBitmap(width, height, base.format);
      fillBurikoBitmap(expanded, 0);
      this.compositor.draw(
        expanded,
        (width - special.width) >>> 1,
        (height - special.height) >>> 1,
        special,
        0x80,
        0,
      );
      mixBurikoBitmaps(output, output, expanded, option, this.compositor.processing);
      expanded.storage?.release();
    }
    return output;
  }
}
