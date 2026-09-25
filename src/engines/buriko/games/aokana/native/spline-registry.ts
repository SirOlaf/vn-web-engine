import type {AokanaBpPointer} from '../bp/memory.js';
import {pointerView} from '../bp/memory.js';
import {AokanaNativeSpline} from './spline.js';
import {gridOutput} from './logical-grid-path.js';

interface SplineEntry {
  readonly id: number;
  readonly spline: AokanaNativeSpline;
  duration: number | undefined;
}

/** 1400f6370/6300/6240/61b0: the independent C0 spline list, not a display-object bank. */
export class AokanaNativeSplines {
  private nextId = 0x80000000;
  private readonly entries: SplineEntry[] = [];

  create(): number {
    this.nextId = (this.nextId + 1) >>> 0;
    this.entries.unshift({id: this.nextId, spline: new AokanaNativeSpline(), duration: undefined});
    return this.nextId;
  }

  remove(id: number): number {
    const index = this.entries.findIndex((entry) => entry.id === id >>> 0);
    if (index < 0) return 1;
    this.entries[index]!.spline.clear();
    this.entries.splice(index, 1);
    return 0;
  }

  /** Final owner disposal; do not reuse signed-bank IDs. */
  disposeAll(): void {
    for (const entry of this.entries) entry.spline.clear();
    this.entries.length = 0;
  }

  initialize(id: number, count: number, points: AokanaBpPointer | null, duration: number): number {
    count >>>= 0;
    duration >>>= 0;
    if (count < 2) return 2;
    if (duration < 2) return 3;
    const entry = this.entries.find((entry) => entry.id === id >>> 0);
    if (entry === undefined) return 1;
    entry.spline.clear();
    for (let index = 0; index < count; index++) {
      if (points === null) throw new Error('Aokana spline initialization dereferences null points');
      const view = pointerView({bytes: points.bytes, offset: points.offset + index * 16}, 12);
      // The fourth DWORD is padding; even excess points are read before the 100-point rejection.
      const z = view.getInt32(8, true),
        y = view.getInt32(4, true),
        x = view.getInt32(0, true);
      entry.spline.append(x, y, z);
    }
    entry.spline.setDuration(duration);
    entry.duration = duration;
    return 0;
  }

  sample(output: AokanaBpPointer | null, id: number, time: number): number {
    const entry = this.entries.find((entry) => entry.id === id >>> 0);
    if (entry === undefined) return 1;
    if (entry.duration === undefined)
      throw new Error('Aokana spline sample reads uninitialized registry duration');
    if (time >>> 0 >= entry.duration) return 4;
    const position = new Int32Array(3);
    if (!entry.spline.sample(time, position)) return 0xffffffff;
    for (let axis = 0; axis < 3; axis++) gridOutput(output, position[axis]!, axis * 4);
    return 0;
  }
}
