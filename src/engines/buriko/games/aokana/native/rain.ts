import {nativeRainSineCosine} from '../bp/opcodes/native-math.js';
import type {AokanaBitmap, AokanaBitmapRectangle} from './bitmap.js';
import {drawAokanaRainLine} from './rain-line.js';
import {AokanaCrtRandom} from './system-timing.js';
import {AokanaSystemTicks} from './system-ticks.js';

type Point = {x: number; y: number; z: number};
interface Drop {
  first: Point;
  second: Point;
}

function divide(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -0x80000000 && denominator === -1))
    throw new RangeError('Aokana rain native signed division fault');
  return Math.trunc(numerator / denominator) | 0;
}
function truncate(value: number): number {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -0x80000000 || integer > 0x7fffffff
    ? -0x80000000
    : integer;
}

/** Native rain state 0f1cc0, including its own list and lazily allocated NCPainter32. */
export class AokanaRain {
  private readonly parameters = Int32Array.of(
    -100,
    100,
    -100,
    100,
    -100,
    100,
    0,
    -1,
    0,
    0x3c00,
    0x15e00,
    -1,
    0,
    100,
    20,
    1,
  );
  private readonly transform = Int32Array.of(0, 0, 0, 0, 0, 0, 10);
  private readonly velocity = Int32Array.of(0, -60, 0, 0, -350, 0);
  private readonly rotation = Int32Array.of(0, 256, 0, 256, 0, 256);
  private drops: Drop[] = [];
  private previousTick: number | undefined;
  private painter: {
    bitmap: AokanaBitmap | null;
    clip: AokanaBitmapRectangle | undefined;
    color: number | undefined;
  } | null = null;
  private disposed = false;

  constructor(
    private readonly random: AokanaCrtRandom,
    private readonly ticks: AokanaSystemTicks,
  ) {}
  private check(): void {
    if (this.disposed) throw new Error('Aokana accesses a deleted rain object');
  }
  private now(): number {
    return this.parameters[15] !== 0 ? this.ticks.timeGetTime() : this.ticks.getTickCount();
  }

  /** 0f1bd0 exchanges all sixteen DWORDs before computing the unsigned speed shifts. */
  exchangeParameters(values: Int32Array): Int32Array {
    this.check();
    if (values.length < 16) throw new RangeError('Aokana rain reads sixteen parameter DWORDs');
    const previous = this.parameters.slice();
    this.parameters.set(values.subarray(0, 16));
    const speed = this.parameters[9]! >>> 8,
      length = this.parameters[10]! >>> 8;
    for (let axis = 0; axis < 3; axis++) {
      this.velocity[axis] = Math.imul(this.parameters[axis + 6]!, speed);
      this.velocity[axis + 3] = Math.imul(this.parameters[axis + 6]!, length);
    }
    return previous;
  }

  /** 0f1a60 exchanges seven DWORDs and stores trunc(sin/cos * 256) for all three axes. */
  exchangeTransform(values: Int32Array): Int32Array {
    this.check();
    if (values.length < 7) throw new RangeError('Aokana rain reads seven transform DWORDs');
    const previous = this.transform.slice();
    this.transform.set(values.subarray(0, 7));
    for (let axis = 0; axis < 3; axis++) {
      const angle = nativeRainSineCosine(this.transform[axis + 3]!);
      this.rotation[axis * 2] = truncate(angle.sine * 256);
      this.rotation[axis * 2 + 1] = truncate(angle.cosine * 256);
    }
    return previous;
  }

  /** 0f1a20 reads the selected raw clock before clearing the existing list. */
  start(elapsed: number): void {
    this.check();
    this.previousTick = (this.now() - elapsed) >>> 0;
    this.drops = [];
  }

  private advanceDrops(): void {
    let cursor = 0;
    while (cursor < this.drops.length) {
      const drop = this.drops[cursor]!;
      for (const point of [drop.first, drop.second]) {
        point.x = (point.x + this.velocity[0]!) | 0;
        point.y = (point.y + this.velocity[1]!) | 0;
        point.z = (point.z + this.velocity[2]!) | 0;
      }
      if (drop.first.y > this.parameters[4]!) {
        cursor++;
        continue;
      }
      // Removing the native tail moves the iterator to its predecessor, which can be visited again.
      const wasTail = cursor === this.drops.length - 1;
      this.drops.splice(cursor, 1);
      if (wasTail) {
        cursor--;
        if (cursor < 0) return;
      }
    }
  }

  private spawnDrops(): void {
    const xRange = (this.parameters[3]! - this.parameters[0]!) >>> 0;
    const zRange = (this.parameters[5]! - this.parameters[2]!) >>> 0;
    for (let index = 0; index < this.parameters[13]!; index++) {
      // Native rand has already advanced before DIV can fault for a zero extent.
      const xRandom = this.random.next();
      if (xRange === 0) throw new RangeError('Aokana rain divides by a zero X extent');
      const x = (this.parameters[0]! + (xRandom % xRange)) | 0;
      const y = (this.parameters[1]! - (this.random.next() % 100)) | 0;
      const zRandom = this.random.next();
      if (zRange === 0) throw new RangeError('Aokana rain divides by a zero Z extent');
      const z = (this.parameters[2]! + (zRandom % zRange)) | 0;
      this.drops.push({
        second: {x, y, z},
        first: {
          x: (x - this.velocity[3]!) | 0,
          y: (y - this.velocity[4]!) | 0,
          z: (z - this.velocity[5]!) | 0,
        },
      });
    }
  }

  /** 0f19b0: gaps of at least 500ms discard elapsed time; smaller gaps run whole native ticks. */
  update(): number {
    this.check();
    const now = this.now();
    if (this.previousTick === undefined)
      throw new Error('Aokana rain reads its unwritten start time');
    let elapsed = (now - this.previousTick) >>> 0;
    if (elapsed >= 500) this.previousTick = this.now();
    else if (this.parameters[14]! >>> 0 <= elapsed) {
      do {
        this.advanceDrops();
        this.spawnDrops();
        elapsed = (elapsed - this.parameters[14]!) >>> 0;
      } while (this.parameters[14]! >>> 0 <= elapsed);
      this.previousTick = (now - elapsed) >>> 0;
    }
    return 0xffffffff;
  }

  /** 0f13c0: the Z rotation deliberately uses its already-updated X in the second equation. */
  private projectPoint(point: Point): Point {
    let x = (point.x - this.transform[0]!) | 0;
    let y = (point.y - this.transform[1]!) | 0;
    let z = (point.z - this.transform[2]!) | 0;
    const [sx, cx, sy, cy, sz, cz] = this.rotation as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    x = (Math.imul(cz, x) - Math.imul(sz, y)) >> 8;
    y = (Math.imul(cz, y) + Math.imul(sz, x)) >> 8;
    const rotatedZ = (Math.imul(sy, y) + Math.imul(cy, z)) >> 8;
    y = (Math.imul(cy, y) - Math.imul(sy, z)) >> 8;
    z = (Math.imul(cx, rotatedZ) - Math.imul(sx, x)) >> 8;
    x = (Math.imul(sx, rotatedZ) + Math.imul(cx, x)) >> 8;
    return {x, y, z};
  }

  /** 0f1940/0f1640/0f14c0 render existing drops without advancing their simulation. */
  draw(bitmap: AokanaBitmap): void {
    this.check();
    this.painter ??= {bitmap: null, clip: undefined, color: undefined};
    const painter = this.painter;
    if (bitmap.storage !== null && bitmap.width >>> 0 <= bitmap.stride >>> 0) {
      painter.bitmap = {...bitmap};
      painter.clip = {
        left: 0,
        top: 0,
        right: (bitmap.width - 1) | 0,
        bottom: (bitmap.height - 1) | 0,
      };
    }
    painter.color = this.parameters[11]!;
    for (const drop of this.drops) {
      const first = this.projectPoint(drop.first),
        near = this.transform[6]!;
      if (first.z <= near) continue;
      const second = this.projectPoint(drop.second);
      if (second.z <= near) continue;
      const alpha = this.parameters[11]! >>> 24;
      const attenuated = divide(Math.imul(alpha, near), Math.trunc(first.z / 8));
      painter.color =
        (this.parameters[11]! & 0xffffff) | ((Math.min(alpha, attenuated) & 255) << 24);
      const destination = painter.bitmap;
      const width = destination?.width ?? 0,
        height = destination?.height ?? 0;
      const y2 = ((height >>> 1) - divide(Math.imul(near, second.y), second.z)) | 0;
      const x2 = ((width >>> 1) + divide(Math.imul(near, second.x), second.z)) | 0;
      const y1 = ((height >>> 1) - divide(Math.imul(near, first.y), first.z)) | 0;
      const x1 = ((width >>> 1) + divide(Math.imul(near, first.x), first.z)) | 0;
      if (painter.clip === undefined)
        throw new Error('Aokana rain painter reads unwritten clipping bounds');
      if (destination === null)
        throw new Error('Aokana rain painter dereferences an unconfigured pixel buffer');
      drawAokanaRainLine(destination, painter.clip, painter.color, x1, y1, x2, y2);
    }
  }

  dispose(): void {
    this.check();
    this.drops = [];
    this.painter = null;
    this.disposed = true;
  }
}
