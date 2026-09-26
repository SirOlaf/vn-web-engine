import type {AokanaBpPointer} from '../bp/memory.js';
import {aokanaRosettaSseReciprocal} from './cpu-numerical-profile.js';
import type {
  AokanaDistributedProcessing,
  AokanaWorkContinuation,
} from './distributed-processing.js';
import {gridAbsolute, gridAllocation} from './logical-grid-path.js';
import type {AokanaLogicalSpatialManager} from './logical-spatial.js';
import {truncateSplineInteger} from './spline.js';

const f32 = Math.fround;

function nearestInteger(value: number): number {
  const floor = Math.floor(value),
    remainder = value - floor,
    rounded = remainder > 0.5 || (remainder === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return truncateSplineInteger(rounded);
}

/**
 * 1400a2b30's reachable spatial-search path. The only initial enqueue receives
 * identical source vectors. RSQRTSS(+0) produces +Infinity, refinement produces
 * NaN, and COMISS/JB rejects the seed. Constructor +168 is null; expansion can
 * only run after dequeue, so no expansion or successful-output path is reachable.
 */
export class AokanaLogicalSpatialSearch {
  private width: number | undefined;
  private height: number | undefined;
  private cells: Uint8Array | null = null;
  private readonly goals = new Int32Array(64);
  private integerDirections: Int32Array | null = null;
  private floatDirections: Float32Array | null = null;
  private active = false;
  private goal = -1;
  private workerPool: AokanaDistributedProcessing | null = null;
  private radius: number | undefined;
  private priority: number | undefined;
  private sourceIndex: number | undefined;
  private range: number | undefined;
  private step: number | undefined;
  private mask: number | undefined;
  private checkSegment: number | undefined;
  private resolution: number | undefined;
  private seedDistance: number | undefined;

  constructor(
    private readonly manager: AokanaLogicalSpatialManager,
    private readonly globalPool: AokanaDistributedProcessing,
  ) {}

  /** Empty 1400a1ab0/1400a1a20 queues still perform the native shared-lock pair. */
  private inspectEmptyQueue(): void {
    if (this.workerPool !== null) {
      const entered = this.workerPool.enterShared();
      this.workerPool.leaveShared(entered);
    }
  }

  private *worker(id: number): AokanaWorkContinuation {
    if (id === 0) {
      if (this.active) {
        this.inspectEmptyQueue();
        this.active = false;
      }
      this.workerPool?.wake(0);
    } else if (this.workerPool !== null) {
      while (this.active) {
        this.inspectEmptyQueue();
        yield* this.workerPool.park(id);
      }
    }
    return 0;
  }

  query(
    _output: AokanaBpPointer | null,
    _count: AokanaBpPointer | null,
    sourceIndex: number,
    targetIndex: number,
    range: number,
    step: number,
    mask: number,
    checkSegment: number,
    resolution: number,
    distributed: number,
  ): number {
    const source = this.manager.record(sourceIndex);
    if (source === undefined) return 0xa0000001;
    const target = this.manager.record(targetIndex);
    if (target === undefined) return 0xa0000002;
    step = f32(step === 0 ? 1 : step);
    range = f32(range);
    const seed = aokanaRosettaSseReciprocal(step),
      inverse = f32(f32(seed + seed) - f32(f32(seed * seed) * step)),
      radiusCount = Math.max(
        1,
        gridAbsolute(truncateSplineInteger(Math.ceil(f32(range * inverse)))),
      ),
      center = (radiusCount * 2) | 0,
      size = (center * 2 + 1) | 0,
      targetGrid = new Int32Array(4);
    for (let lane = 0; lane < 4; lane++) {
      const difference = f32(
        target.view.getFloat32(0x50 + lane * 4, true) -
          source.view.getFloat32(0x50 + lane * 4, true),
      );
      targetGrid[lane] = (nearestInteger(f32(f32(difference * 2) * inverse)) + center) | 0;
    }
    // The native bounds check tests only these upper bounds, with signed comparisons.
    if (targetGrid[0]! >= size || targetGrid[1]! >= size) return 0xa0000006;
    this.width = this.height = size;
    this.cells = gridAllocation(size, size, 32);
    this.goals.fill(0);
    const radius = source.view.getFloat32(4, true),
      goalRadius = gridAbsolute(
        truncateSplineInteger(
          Math.ceil(f32(f32(f32(radius + target.view.getFloat32(4, true)) * 2) * inverse)),
        ),
      ),
      diagonal =
        goalRadius >= 4 ? truncateSplineInteger((goalRadius + 0.7) * 0.7071067) : goalRadius,
      offsets = [
        [goalRadius, 0],
        [diagonal, diagonal],
        [0, goalRadius],
        [-diagonal, diagonal],
        [-goalRadius, 0],
        [-diagonal, -diagonal],
        [0, -goalRadius],
        [diagonal, -diagonal],
        [goalRadius + 1, 0],
        [diagonal + 1, diagonal + 1],
        [0, goalRadius + 1],
        [-diagonal - 1, diagonal + 1],
        [-goalRadius - 1, 0],
        [-diagonal - 1, -diagonal - 1],
        [0, -goalRadius - 1],
        [diagonal + 1, -diagonal - 1],
      ];
    for (let i = 0; i < 16; i++) {
      this.goals[i * 4] = (targetGrid[0]! + offsets[i]![0]!) | 0;
      this.goals[i * 4 + 1] = (targetGrid[1]! + offsets[i]![1]!) | 0;
    }
    this.radius = radius;
    this.priority = source.view.getInt32(20, true);
    this.sourceIndex = sourceIndex >>> 0;
    this.range = range;
    this.step = step;
    this.mask = mask >>> 0;
    this.checkSegment = checkSegment >>> 0;
    this.resolution = (4 << (resolution & 31)) >>> 0 < 17 ? resolution >>> 0 : 2;
    this.integerDirections = new Int32Array(64);
    this.floatDirections = new Float32Array(64);
    for (let i = 0; i < 4; i++) {
      const lower = i - 2,
        upper = 2 - i,
        lowerFloat = f32(f32(f32(lower) * step) * 0.5),
        upperFloat = f32(f32(f32(upper) * step) * 0.5),
        indices = [lower & 15, i + 2, i + 6, i + 10],
        integer = [
          [2, lower],
          [upper, 2],
          [-2, upper],
          [lower, -2],
        ],
        vector = [
          [step, lowerFloat],
          [upperFloat, step],
          [-step, upperFloat],
          [lowerFloat, -step],
        ];
      for (let side = 0; side < 4; side++) {
        const index = indices[side]! * 4;
        this.integerDirections[index] = integer[side]![0]!;
        this.integerDirections[index + 1] = integer[side]![1]!;
        this.floatDirections[index] = vector[side]![0]!;
        this.floatDirections[index + 1] = vector[side]![1]!;
      }
    }
    this.seedDistance = undefined;
    if (center >= 0 && center < size) {
      // Preserve every scalar operation of the verified seed-only RSQRT sequence.
      const squared = 0,
        inverseRoot = Infinity;
      this.seedDistance = f32(
        squared *
          f32(
            f32(inverseRoot * 1.5) +
              f32(f32(f32(f32(squared * inverseRoot) * inverseRoot) * inverseRoot) * -0.5),
          ),
      );
      // COMISS range, NaN sets CF, and JB rejects before accessing the cost grid.
    }
    this.workerPool = distributed >>> 0 !== 0 ? this.globalPool : null;
    this.active = true;
    this.goal = -1;
    this.globalPool.setWorkerCallback((search, worker) => search.worker(worker), this);
    this.globalPool.run(distributed);
    this.globalPool.setWorkerCallback(null, null);
    this.inspectEmptyQueue();
    // The native frees these three temporary allocations in this order.
    this.floatDirections = null;
    this.integerDirections = null;
    this.cells = null;
    return 0xa0000006;
  }
}
