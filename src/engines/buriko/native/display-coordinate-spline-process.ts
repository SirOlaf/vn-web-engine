import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {nativeDisplayEasing} from '../bp/opcodes/native-math.js';
import {BurikoDisplayControlProcess} from './display-control-process.js';
import {BurikoNativeSpline} from './spline.js';

const low32 = (value: bigint): number => Number(BigInt.asIntN(32, value));

/** 070CE0/070B10/0708A0: CProcCtrlDspObjBC, owning the actual shared CSpline implementation. */
export class BurikoCoordinateSplineControlProcess extends BurikoDisplayControlProcess {
  private readonly spline = new BurikoNativeSpline();
  private readonly target = new Int32Array(3);
  private readonly last = new Int32Array(3).fill(-0x80000000);
  private speed = 0x10000n;

  initializeCoordinates(
    count: number,
    points: BurikoBpPointer | null,
    positionEasing: number,
    blend: number,
    packedBlend: number,
    depth: number,
    duration: number,
    frequency: number,
    frameLimit: number,
  ): number {
    count |= 0;
    if (count <= 0) return 0x80000001;
    if (points === null) throw new Error('Buriko coordinate control dereferences null points');
    const endpoint = {bytes: points.bytes, offset: points.offset + (count - 1) * 16},
      xy = pointerView(endpoint, 8);
    this.initializeFull(
      xy.getInt32(0, true),
      xy.getInt32(4, true),
      positionEasing,
      blend,
      packedBlend & 0xffff,
      depth,
      duration,
      frequency,
      frameLimit,
    );
    const start = this.object.coordinates();
    this.spline.clear();
    this.spline.append(start.x, start.y, start.z);
    for (let index = 0; index < count; index++) {
      const point = pointerView({bytes: points.bytes, offset: points.offset + index * 16}, 12);
      const z = point.getInt32(8, true),
        y = point.getInt32(4, true),
        x = point.getInt32(0, true);
      this.spline.append(x, y, z);
    }
    this.spline.setDuration(0x10000);
    this.last.fill(-0x80000000);
    // Native reads the complete final record here even though the fourth DWORD is unused.
    const final = pointerView(endpoint, 16);
    for (let axis = 0; axis < 3; axis++) this.target[axis] = final.getInt32(axis * 4, true);
    this.speed = 0x100000000n / BigInt(packedBlend >>> 16 || 0x10000);
    return 0;
  }

  protected override update(forceFinish: boolean): boolean {
    if (forceFinish) this.current = this.total;
    else {
      let elapsed = (Number(BigInt.asUintN(32, this.clock.read())) - this.startTime) >>> 0;
      if (this.frameLimit !== 0) {
        elapsed = Math.min(elapsed, this.nextMaximum);
        this.nextMaximum = (elapsed + this.maximumStep) >>> 0;
      }
      this.current = (elapsed | 0) >= this.total ? this.total : elapsed | 0;
    }
    const finished = this.current === this.total,
      coordinates = new Int32Array(3);
    let blend: number, depth: number;
    if (finished) {
      coordinates.set(this.target);
      blend = (this.startBlend + this.deltaBlend) | 0;
      depth = (this.startDepth + this.deltaDepth) << 16;
    } else {
      const current = BigInt(this.current | 0),
        total = BigInt(this.total | 0),
        progress = low32((current << 24n) / total);
      this.spline.sample(
        nativeDisplayEasing(
          progress,
          this.positionEasing,
          this.manager.environment.compositor.revision,
        ),
        coordinates,
      );
      // IMUL and SHL wrap at 64 bits before the signed division and upper-only cap.
      const blendProgress = BigInt.asIntN(64, (current * this.speed) << 8n) / total,
        capped = blendProgress <= 0x1000000n ? low32(blendProgress) : 0x1000000,
        eased = nativeDisplayEasing(
          capped,
          this.blendEasing,
          this.manager.environment.compositor.revision,
        );
      blend =
        (this.startBlend + low32((BigInt(this.deltaBlend | 0) * BigInt(eased | 0)) >> 16n)) | 0;
      depth =
        (low32((BigInt(Math.imul(this.current, this.deltaDepth)) << 16n) / total) +
          (this.startDepth << 16)) |
        0;
    }
    if (
      coordinates[0] !== this.last[0] ||
      coordinates[1] !== this.last[1] ||
      coordinates[2] !== this.last[2] ||
      blend !== this.lastBlend ||
      depth !== this.lastDepth
    ) {
      this.last.set(coordinates);
      this.lastBlend = blend;
      this.lastDepth = depth;
      this.object.invalidate();
      const key = this.object.sortKey();
      this.object.setCoordinates(coordinates[0]!, coordinates[1]!, coordinates[2]!);
      this.object.setBlendValue(blend);
      this.object.setValueD8(1, depth);
      if (key !== this.object.sortKey()) this.manager.lists.resort(this.object);
      this.object.invalidate();
      this.dirty = true;
    }
    this.setDeadline(1);
    return finished;
  }

  override dispose(): void {
    this.spline.clear();
    super.dispose();
  }
}
