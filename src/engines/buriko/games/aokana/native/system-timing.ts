import type {AokanaBpPointer} from '../bp/memory.js';
import {pointerView} from '../bp/memory.js';
import type {AokanaNativeClock} from './clock.js';

/** CRT per-OS-thread state: every cooperative VM thread uses this one generator. */
export class AokanaCrtRandom {
  private state = 1; // construct_ptd_array initializes __acrt_ptd +28 to one.

  seed(value: number): void {
    this.state = value >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 0x343fd) + 0x269ec3) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }

  bounded(bound: number): number {
    bound |= 0;
    if (bound <= 0) return 0;
    const first = this.next(),
      second = this.next(),
      third = this.next();
    return ((third ^ ((second ^ (first << 8)) << 8)) % bound) | 0;
  }
}

/** CRT __acrt_ptd +28 is a distinct seed for each actual cooperative OS-thread actor. */
export class AokanaThreadedCrtRandom extends AokanaCrtRandom {
  private readonly streams = new WeakMap<object, AokanaCrtRandom>();
  constructor(private readonly currentActor: () => object) {
    super();
  }
  private stream(): AokanaCrtRandom {
    const actor = this.currentActor();
    let stream = this.streams.get(actor);
    if (stream === undefined) {
      stream = new AokanaCrtRandom();
      this.streams.set(actor, stream);
    }
    return stream;
  }
  override seed(value: number): void {
    this.stream().seed(value);
  }
  override next(): number {
    return this.stream().next();
  }
}

/** DAT_1401eaf58/60: newest-first history recorded at the end of each outer-loop iteration. */
export class AokanaVmFrameHistory {
  private readonly samples = new Uint32Array(600);
  private head = 0;
  private previousTick: number;

  constructor(initialElapsedMilliseconds: number) {
    this.previousTick = initialElapsedMilliseconds | 0;
  }

  /** Native restart clears samples without resetting the ring cursor or previous tick. */
  clear(): void {
    this.samples.fill(0);
  }

  record(elapsedMilliseconds: number): void {
    const now = elapsedMilliseconds | 0;
    this.head = this.head === 0 ? 599 : this.head - 1;
    this.samples[this.head] = now - this.previousTick;
    this.previousTick = now;
  }

  copy(destination: AokanaBpPointer | null, count: number): number {
    count >>>= 0;
    if ((count - 1) >>> 0 >= 600) return 0;
    if (destination === null) throw new Error('Aokana native frame-history null destination');
    const output = pointerView(destination, count * 4);
    for (let index = 0; index < count; index++) {
      output.setUint32(index * 4, this.samples[(this.head + index) % 600]!, true);
    }
    return 1;
  }
}

/** Exact Win32 primitive boundary, including its independently failing calls. */
export interface AokanaNativePerformanceCounter {
  queryCounter(): bigint | null;
  queryFrequency(): bigint | null;
}

/** A supported browser host counter profile has microsecond ticks and a 1 MHz frequency. */
export class AokanaBrowserPerformanceCounter implements AokanaNativePerformanceCounter {
  constructor(private readonly performance: Pick<Performance, 'now'>) {}

  queryCounter(): bigint {
    return BigInt(Math.trunc(this.performance.now() * 1000));
  }

  queryFrequency(): bigint {
    return 1000000n;
  }
}

/** 1400fe560 uses double division/multiplication and truncation, not integer nanosecond arithmetic. */
export function nativeNanoseconds(
  counter: AokanaNativePerformanceCounter,
  clock: AokanaNativeClock,
): bigint {
  const ticks = BigInt.asIntN(64, counter.queryCounter() ?? clock.read());
  const frequency = BigInt.asIntN(64, counter.queryFrequency() ?? 1000n);
  const value = (Number(ticks) / Number(frequency)) * 1000000000;
  if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63) return -(1n << 63n);
  return BigInt(Math.trunc(value));
}
