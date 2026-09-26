import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {nativeDisplayEasing} from '../bp/opcodes/native-math.js';
import type {BurikoNativeClock} from './clock.js';
import {burikoRosettaSseReciprocal} from './cpu-numerical-profile.js';
import type {BurikoCursorPolicy} from './cursor-policy.js';
import type {BurikoVirtualDisplayObject} from './display-virtual.js';
import type {BurikoWindowDisplayObject} from './display-window.js';
import {BurikoIconMotionTree} from './icon-motion-tree.js';
import {BurikoIndependentIconState} from './independent-icon.js';
import {BurikoIndependentIconEx} from './independent-icon-ex.js';
import type {BurikoIndependentProcedures} from './independent-procedure.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoNativeSplines} from './spline-registry.js';

interface Motion {
  row: number;
  column: number;
  state: number;
  blendA: number;
  blendB: number;
  easingIn: number;
  easingOut: number;
  duration: number;
  spline: number;
  // Native MOVUPS propagates opaque fourthDWORD; only xyz are consumed numerically.
  endpoint: readonly [number, number, number, undefined];
  delay: number;
  start: bigint;
}
const f32 = Math.fround;
const u64 = (n: bigint): bigint => BigInt.asUintN(64, n);
function read(points: BurikoBpPointer | null, offset: number): number {
  if (points === null) throw new Error('Buriko IconEEx dereferences null motion points');
  return pointerView({bytes: points.bytes, offset: points.offset + offset}, 4).getInt32(0, true);
}
function fraction(elapsed: number, duration: number): number {
  const total = f32(duration >>> 0),
    seed = burikoRosettaSseReciprocal(total),
    square = f32(seed * seed),
    twice = f32(seed + seed),
    refined = f32(twice - f32(total * square)),
    scaled = f32(f32(elapsed >>> 0) * 16777216),
    rounded = Math.floor(f32(f32(refined * scaled) + 0.5));
  return !Number.isFinite(rounded) || rounded < -0x80000000 || rounded >= 0x80000000
    ? -0x80000000
    : rounded | 0;
}

/** 094A40 and17F008: complete DCIPIconEEx over accepted actual type1 rendering/input owners. */
export class BurikoIndependentIconEEx extends BurikoIndependentIconEx {
  override readonly type: number = 2;
  private readonly motions = new BurikoIconMotionTree<Motion>();
  constructor(
    shared: BurikoIndependentProcedures,
    window: BurikoWindowDisplayObject,
    input: BurikoNativeInput,
    priorities: BurikoProcedureState,
    clock: BurikoNativeClock,
    cursor: BurikoCursorPolicy,
    settings: BurikoIndependentIconState,
    private readonly splines: BurikoNativeSplines,
  ) {
    super(shared, window, input, priorities, clock, cursor, settings);
  }
  /** 08E380 searches original flat order, requiring actual present entry. */
  private motionChild(row: number, column: number): BurikoVirtualDisplayObject | null {
    for (const entry of this.flat)
      if (entry.present && entry.row === row && entry.column === column) return entry.child;
    return null;
  }
  private requireChild(child: BurikoVirtualDisplayObject | null): BurikoVirtualDisplayObject {
    if (child === null) throw new Error('Buriko IconEEx dereferences absent motion child');
    return child;
  }
  /** 0946E0: spline registry owns transformed xyz; temporary padding remains opaque. */
  configureMotion(
    row: number,
    column: number,
    count: number,
    points: BurikoBpPointer | null,
    blendA: number,
    blendB: number,
    easingIn: number,
    easingOut: number,
    duration: number,
    initial: number,
  ): number {
    row |= 0;
    column |= 0;
    count >>>= 0;
    const flags = this.motionRowFlags(row);
    if (flags === undefined) return 0x80000001;
    const child = this.motionChild(row, column);
    if (child === null) return 0x80000002;
    if (count < 2) return 0x80000003;
    const bytes = new Uint8Array(count * 16),
      view = new DataView(bytes.buffer);
    let spline = this.splines.create();
    for (let i = 0; i < count; i++)
      for (let axis = 0; axis < 3; axis++)
        view.setInt32(i * 16 + axis * 4, read(points, i * 16 + axis * 4) << 16, true);
    const status = this.splines.initialize(spline, count, {bytes, offset: 0}, duration);
    if (status === 2 || status === 3) {
      this.splines.remove(spline);
      return status === 2 ? 0x80000003 : 0x80000006;
    }
    const at = (count - 1) * 16;
    const motion: Motion = {
      row,
      column,
      state: Number(initial !== 0),
      blendA: blendA | 0,
      blendB: blendB | 0,
      easingIn: easingIn | 0,
      easingOut: easingOut | 0,
      duration: duration >>> 0,
      spline,
      endpoint: [
        view.getInt32(at, true),
        view.getInt32(at + 4, true),
        view.getInt32(at + 8, true),
        undefined,
      ],
      delay: 0,
      start: 0n,
    };
    const key = (row << 16) | column;
    this.motions.remove(key, (old) => this.splines.remove(old.spline));
    this.motions.insert(key, motion);
    const original = initial === 0 ? at : 0,
      z = read(points, original + 8),
      y = read(points, original + 4),
      x = read(points, original);
    this.moveIcon(row, column, x, y, z, blendA);
    child.setValue170((flags & 0x10000) !== 0 ? initial : 1);
    spline = 0x80000000;
    this.splines.remove(spline);
    return 0;
  }
  /** 094210: asynchronous direction/delay transitions preserve current progress. */
  private transition(row: number, column: number, target: number, delay: number): number {
    const status = this.motionIndexStatus(row, column);
    if (status !== 0) return status;
    const motion = this.motions.find((row << 16) | column);
    if (motion === undefined) return 0x80000007;
    const now = u64(this.clock.read()),
      child = this.motionChild(row, column);
    if (target !== 0) {
      if (motion.state === 0) {
        if (delay !== 0) motion.delay = delay >>> 0;
        motion.start = now;
        motion.state = 2;
      } else if (motion.state === 2) {
        if (motion.delay !== 0) motion.delay = delay >>> 0;
      } else if (motion.state === 3) {
        if (motion.delay !== 0) {
          motion.state = 1;
          motion.delay = 0;
          this.requireChild(child).setValue170(1);
        } else {
          motion.state = 2;
          motion.start = u64(now * 2n - BigInt(motion.duration) - motion.start);
        }
      }
    } else {
      this.requireChild(child).setValue170(~((this.motionRowFlags(row) ?? 0) >>> 16) & 1);
      if (motion.state === 1) {
        if (delay !== 0) motion.delay = delay >>> 0;
        motion.start = now;
        motion.state = 3;
      } else if (motion.state === 2) {
        if (motion.delay !== 0) {
          motion.delay = 0;
          motion.state = 0;
        } else {
          motion.start = u64(now * 2n - BigInt(motion.duration) - motion.start);
          motion.state = 3;
        }
      } else if (motion.state === 3 && motion.delay !== 0) motion.delay = delay >>> 0;
    }
    return 0;
  }
  protected override handleMessage(words: Uint32Array): number {
    if (words[0] !== 0x30000000) return super.handleMessage(words);
    return words.length === 5
      ? Number(this.transition(words[1]! | 0, words[2]! | 0, words[3]! | 0, words[4]! | 0) === 0)
      : 0;
  }
  protected override tick(elapsed: bigint): void {
    // One native16-byte stack output persists across the entire tree traversal.
    const bytes = new Uint8Array(16),
      view = new DataView(bytes.buffer);
    for (const motion of this.motions.values()) {
      if ((motion.state - 2) >>> 0 >= 2) continue;
      let time =
        (Number(BigInt.asUintN(32, elapsed)) - Number(BigInt.asUintN(32, motion.start))) >>> 0;
      if (motion.delay !== 0) {
        if (time < motion.delay) continue;
        motion.start = u64(motion.start + BigInt(motion.delay));
        time = (time - motion.delay) >>> 0;
        motion.delay = 0;
      }
      time = Math.min(time, motion.duration);
      const entering = motion.state === 2,
        easing = nativeDisplayEasing(
          fraction(time, motion.duration),
          entering ? motion.easingIn : motion.easingOut,
        ),
        product = Math.imul(motion.duration, easing) >>> 16,
        sampleTime = entering ? (motion.duration - product) >>> 0 : product,
        status = this.splines.sample({bytes, offset: 0}, motion.spline, sampleTime);
      if (status !== 0)
        for (let axis = 0; axis < 3; axis++) view.setInt32(axis * 4, motion.endpoint[axis]!, true);
      const start = entering ? motion.blendB : motion.blendA,
        end = entering ? motion.blendA : motion.blendB,
        blend = ((Math.imul((end - start) | 0, easing) >>> 16) + start) | 0,
        x = (view.getInt32(0, true) + 0x8000) >> 16,
        y = (view.getInt32(4, true) + 0x8000) >> 16,
        z = (view.getInt32(8, true) + 0x8000) >> 16;
      this.moveIcon(motion.row, motion.column, x, y, z, blend);
      if (time === motion.duration) {
        motion.state = entering ? 1 : 0;
        motion.start = 0n;
        if (entering) this.requireChild(this.motionChild(motion.row, motion.column)).setValue170(1);
      }
    }
    super.tick(elapsed);
  }
  override dispose(): void {
    this.check();
    this.motions.clear((motion) => this.splines.remove(motion.spline));
    super.dispose();
  }
}
