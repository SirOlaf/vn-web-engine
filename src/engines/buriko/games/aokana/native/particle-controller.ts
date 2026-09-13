import {nativeParticleSineCosine} from '../bp/opcodes/native-math.js';
import {
  aokanaBitmapRectangle,
  intersectAokanaBitmapRectangle,
  translateAokanaBitmapRectangle,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import type {AokanaBitmapCompositor} from './bitmap-compositor.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaDisplayCriticalSection} from './display-critical-section.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import {AokanaParticleAir, type AokanaParticleVector} from './particle-air.js';
import type {AokanaParticleVariants} from './particle-images.js';
import {
  AokanaFireflyMovement,
  AokanaFireflyParticle,
  AokanaParticle,
  AokanaSnowParticle,
} from './particle-objects.js';
import type {AokanaCrtRandom} from './system-timing.js';

interface ParticleCamera {
  position: AokanaParticleVector;
  sineX: number;
  cosineX: number;
  sineY: number;
  cosineY: number;
  sineZ: number;
  cosineZ: number;
  projection: number;
}
export interface AokanaProjectedParticle extends AokanaParticleVector {
  particle: AokanaParticle;
}

function int32(value: number): number {
  value = Math.trunc(value);
  return !Number.isFinite(value) || value < -2147483648 || value > 2147483647
    ? -2147483648
    : value | 0;
}
function divide(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -2147483648 && denominator === -1))
    throw new RangeError('Aokana particle projection divides outside its numerical domain');
  return Math.trunc(numerator / denominator) | 0;
}

/** 096800: the descending in-place quicksort also preserves the native equal-depth swaps. */
export function sortAokanaParticlesByDepth(
  particles: AokanaProjectedParticle[],
  start = 0,
  count = particles.length,
): void {
  while (count >= 2) {
    const pivot = particles[start + (count >>> 1)]!.z;
    let left = 0,
      right = count - 1;
    while (true) {
      while (particles[start + left]!.z > pivot) left++;
      while (particles[start + right]!.z < pivot) right--;
      if (left >= right) break;
      const saved = particles[start + left]!;
      particles[start + left++] = particles[start + right]!;
      particles[start + right--] = saved;
    }
    if (left >= 2) sortAokanaParticlesByDepth(particles, start, left);
    start += left;
    count -= left;
  }
}

/**
 * DCParticleControl, 098960. The 32768 simulation slots belong to this concrete
 * controller; the eight display objects remain in the actual shared display manager.
 * 097620 binds processing to the same startup pool used by that manager.
 */
export class AokanaParticleController {
  interval = 10;
  previousTick: number;
  readonly targetCounts = new Int32Array(128);
  readonly currentCounts = new Int32Array(128);
  readonly spawnIntervals = new Uint32Array(128);
  readonly nextSpawnTicks = new Uint32Array(128);
  readonly movement = Array.from({length: 64}, () => new AokanaFireflyMovement());
  readonly air: AokanaParticleAir;
  readonly criticalSection: AokanaDisplayCriticalSection;
  private readonly slots: Array<AokanaParticle | null> = Array.from({length: 32768}, () => null);
  private count = 0;
  private camera: ParticleCamera | undefined;
  private rangeCursor = 0;
  private drawCursor = 0;
  private airVector: AokanaParticleVector | undefined;

  constructor(
    readonly variants: AokanaParticleVariants,
    private readonly random: AokanaCrtRandom,
    private readonly clock: AokanaNativeClock,
    readonly compositor: AokanaBitmapCompositor,
    readonly processing: AokanaDistributedProcessing,
  ) {
    this.previousTick = Number(BigInt.asUintN(32, clock.read()));
    this.air = new AokanaParticleAir(random);
    this.criticalSection = new AokanaDisplayCriticalSection(
      () => processing.allocator.currentActor,
    );
  }
  get activeCount(): number {
    return this.count;
  }
  particleAt(index: number): AokanaParticle | null {
    return this.slots[index >>> 0] ?? null;
  }

  /** 096940, reached through the distinct snow098930 and firefly098900 setters. */
  setTarget(kind: 0 | 1, variant: number, count: number, interval: number): number {
    variant >>>= 0;
    count |= 0;
    if (variant >= 64) return 0x80000002;
    const selected = kind * 64 + variant;
    let total = 0;
    for (let i = 0; i < 128; i++) if (i !== selected) total = (total + this.targetCounts[i]!) | 0;
    if (count < 0 || ((total + count) | 0) >= 32769) return 0x80000003;
    this.targetCounts[selected] = count;
    this.spawnIntervals[selected] = interval >>> 0;
    return 0;
  }

  /** 0987c0 changes the air interval too; zero pauses subsequent controller updates. */
  setInterval(interval: number): boolean {
    interval >>>= 0;
    if (interval > 100) return false;
    this.interval = interval;
    this.air.setInterval(interval);
    return true;
  }
  /** 098680 retains all prior camera fields when the projection distance is not positive. */
  configureCamera(
    x: number,
    y: number,
    z: number,
    angleX: number,
    angleY: number,
    angleZ: number,
    projection: number,
  ): boolean {
    projection |= 0;
    if (projection <= 0) return false;
    const {sine: sineX, cosine: cosineX} = nativeParticleSineCosine(angleX);
    const {sine: sineY, cosine: cosineY} = nativeParticleSineCosine(angleY);
    const {sine: sineZ, cosine: cosineZ} = nativeParticleSineCosine(angleZ);
    this.camera = {
      position: {x: x >> 8, y: y >> 8, z: z >> 8},
      sineX,
      cosineX,
      sineY,
      cosineY,
      sineZ,
      cosineZ,
      projection,
    };
    return true;
  }
  configureMovement(variant: number, values: readonly number[]): number {
    variant >>>= 0;
    if (variant >= 64) return 0x80000002;
    this.movement[variant]!.configure(values);
    return 0;
  }
  /** 0976b0 only refreshes already constructed fireflies when a special image is present. */
  refreshSpecial(kind: number, variant: number): number {
    variant >>>= 0;
    if ((kind | 0) !== 1) return 0x80000001;
    if (variant >= 64) return 0x80000002;
    if (this.variants.hasSpecial(variant)) {
      for (const particle of this.slots)
        if (particle?.kind === 1) (particle as AokanaFireflyParticle).refreshSpecial(variant);
    }
    return 0;
  }

  /** 096e20 scans from slot zero, independent of variant and prior removal position. */
  private append(particle: AokanaParticle): boolean {
    if (this.count >= 32768) return false;
    for (let i = 0; i < 32768; i++) {
      if (this.slots[i] === null) {
        this.slots[i] = particle;
        this.count = (this.count + 1) | 0;
        return true;
      }
    }
    return false;
  }

  /** 096e70 retains independent unsigned next-spawn ticks for all 128 target records. */
  spawn(kind: 0 | 1, variant: number, now: number, force: boolean): number {
    variant >>>= 0;
    now >>>= 0;
    if (variant >= 64) return 0;
    const index = kind * 64 + variant;
    if (force) this.nextSpawnTicks[index] = now;
    let created = 0;
    while (this.nextSpawnTicks[index]! <= now) {
      if (this.targetCounts[index]! <= this.currentCounts[index]!) {
        this.nextSpawnTicks[index] = 0;
        break;
      }
      const particle =
        kind === 0
          ? new AokanaSnowParticle(variant, this.variants, this.random)
          : new AokanaFireflyParticle(
              variant,
              this.variants,
              this.random,
              this.movement[variant]!,
              this.compositor,
            );
      if (kind === 1 && this.variants.hasSpecial(variant))
        (particle as AokanaFireflyParticle).refreshSpecial(variant);
      this.append(particle);
      this.currentCounts[index] = (this.currentCounts[index]! + 1) | 0;
      const previous = this.nextSpawnTicks[index]!;
      this.nextSpawnTicks[index] =
        ((previous === 0 ? now : previous) + this.spawnIntervals[index]!) >>> 0;
      created++;
    }
    return created;
  }

  /** 0960b0 range claims are serialized by the processing pool's own shared lock. */
  private claimRange(): {start: number; count: number} | null {
    const entered = this.processing.enterShared();
    const start = this.rangeCursor;
    const count = Math.min(1024, 32768 - start);
    if (start < 32768) this.rangeCursor += count;
    this.processing.leaveShared(entered);
    return start < 32768 ? {start, count} : null;
  }

  /** 097010 calls Position even when the preceding virtual Update returned zero. */
  private updateWorker(): number {
    const range = this.claimRange();
    if (range === null) return 0;
    for (let i = range.start; i < range.start + range.count; i++) {
      const particle = this.slots[i];
      if (particle === null) continue;
      particle!.applyAir(this.airVector!);
      const updated = particle!.update();
      const position = particle!.position();
      const x = position.x >> 8,
        y = position.y >> 8,
        z = position.z >> 8;
      if (updated === 0 || (x + 16000) >>> 0 > 32000 || y >>> 0 > 16000 || z > 8000 || z < -8000) {
        const index = particle!.kind * 64 + particle!.variant;
        this.currentCounts[index] = (this.currentCounts[index]! - 1) | 0;
        particle!.dispose();
        this.slots[i] = null;
        this.count = (this.count - 1) | 0;
      }
    }
    return 1;
  }

  /** 097170 returns no gap flag when paused; native future timestamps skip simulation only. */
  private updateExisting(now: number): boolean | null {
    if (this.interval === 0) return null;
    const withinGap = now <= (this.previousTick + 500) >>> 0;
    if (withinGap && now < this.previousTick) return true;
    if (!withinGap) this.previousTick = now;
    do {
      this.air.advance();
      this.airVector = this.air.current().vector;
      this.rangeCursor = 0;
      this.processing.setCallback(() => this.updateWorker(), null);
      this.processing.run(1);
      this.processing.setCallback(null, null);
      this.previousTick = (this.previousTick + this.interval) >>> 0;
    } while (this.previousTick <= now);
    return withinGap;
  }

  /** 097250 updates existing particles before spawning, kind zero before kind one. */
  update(now: number): void {
    now >>>= 0;
    const withinGap = this.updateExisting(now);
    if (withinGap === null) return;
    for (let kind = 0; kind < 2; kind++)
      for (let variant = 0; variant < 64; variant++)
        this.spawn(kind as 0 | 1, variant, now, !withinGap);
  }

  /** 098430 reads the BGI clock once before the full update. */
  updateFromClock(): void {
    this.update(Number(BigInt.asUintN(32, this.clock.read())));
  }

  /** 097740 advances one synthetic millisecond per iteration, preserving only saved timing fields. */
  warmUp(iterations: number): void {
    iterations >>>= 0;
    if (this.interval === 0) return;
    const previous = this.previousTick;
    const next = this.nextSpawnTicks.slice();
    const now = Number(BigInt.asUintN(32, this.clock.read()));
    for (let i = 1; i <= iterations; i = (i + 1) >>> 0) this.update((now + i) >>> 0);
    this.previousTick = previous;
    this.nextSpawnTicks.set(next);
  }

  /** 098460 clears instances/current counts/deadlines while retaining targets and spawn rates. */
  clear(): void {
    for (let i = 0; i < 32768; i++) {
      this.slots[i]?.dispose();
      this.slots[i] = null;
    }
    this.count = 0;
    this.currentCounts.fill(0);
    this.nextSpawnTicks.fill(0);
  }

  /** 096440 truncates after each X/Y intermediate rotation, then rejects negative camera depth. */
  private projectWorker(output: AokanaProjectedParticle[]): number {
    const range = this.claimRange();
    if (range === null) return 0;
    const projected: AokanaProjectedParticle[] = [];
    for (let i = range.start; i < range.start + range.count; i++) {
      const particle = this.slots[i];
      if (particle === null) continue;
      const point = particle!.position();
      const camera = this.camera;
      if (camera === undefined)
        throw new Error('Aokana particle projection reads an unconfigured camera');
      const dz = (point.z - camera.position.z) | 0;
      const dy = (point.y - camera.position.y) | 0;
      const afterXz = int32(dz * camera.cosineX + camera.sineX * dy);
      const dx = (point.x - camera.position.x) | 0;
      const depth = int32(camera.cosineY * afterXz - camera.sineY * dx);
      const afterYx = int32(dx * camera.cosineY + camera.sineY * afterXz);
      const afterXy = int32(camera.cosineX * dy - camera.sineX * dz);
      if (depth >= 0)
        projected.push({
          x: int32(camera.cosineZ * afterYx - camera.sineZ * afterXy),
          y: int32(afterXy * camera.cosineZ + camera.sineZ * afterYx),
          z: depth,
          particle: particle!,
        });
    }
    this.criticalSection.run(() => output.push(...projected));
    return 1;
  }

  /** 0966c0's projection phase retains actual range-claim and completed-chunk append order. */
  project(): AokanaProjectedParticle[] {
    const output: AokanaProjectedParticle[] = [];
    this.rangeCursor = 0;
    this.processing.setCallback(() => this.projectWorker(output), null);
    this.processing.run(1);
    this.processing.setCallback(null, null);
    sortAokanaParticlesByDepth(output);
    return output;
  }

  /** 0966c0/096130 render interleaved sorted entries, collecting inclusive damage per worker. */
  draw(
    layers: readonly AokanaBitmap[],
    depths: readonly number[],
    centerX: number,
    centerY: number,
  ): AokanaBitmapRectangle[] {
    const projected = this.project();
    const damage: AokanaBitmapRectangle[] = [];
    this.drawCursor = 0;
    this.processing.setCallback(() => {
      const entered = this.processing.enterShared();
      const start = this.drawCursor++;
      this.processing.leaveShared(entered);
      const bounds = aokanaBitmapRectangle(layers[0]!);
      const local: AokanaBitmapRectangle[] = [];
      for (let i = start; i < projected.length; i += this.processing.capacity) {
        const point = projected[i]!,
          particle = point.particle;
        const distance = this.camera!.projection;
        const scale = (32 - divide(distance << 5, ((point.z >> 8) + distance) | 0)) | 0;
        const bitmap = particle.image(scale);
        if (bitmap === null) continue;
        const denominator = (Math.imul(distance, 256) + point.z) | 0;
        const x =
          (divide(Math.imul(distance, point.x), denominator) - (bitmap.width >>> 1) + centerX) | 0;
        const y =
          (centerY - divide(Math.imul(point.y, distance), denominator) - (bitmap.height >>> 1)) | 0;
        for (let layer = 0; layer < layers.length; layer++) {
          if (point.z > (depths[layer]! | 0)) continue;
          const transparency = particle.transparency(),
            mode = particle.blendMode();
          if (this.compositor.draw(layers[layer]!, x, y, bitmap, mode, transparency) === 0) {
            const rectangle = aokanaBitmapRectangle(bitmap);
            translateAokanaBitmapRectangle(rectangle, x, y);
            intersectAokanaBitmapRectangle(rectangle, bounds);
            local.push(rectangle);
          }
          break;
        }
        particle.releaseImage();
      }
      this.criticalSection.run(() => damage.push(...local));
      return 0;
    }, null);
    this.processing.run(1);
    this.processing.setCallback(null, null);
    return damage;
  }
}
