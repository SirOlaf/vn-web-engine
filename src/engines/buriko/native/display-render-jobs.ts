import type {BurikoBitmapRectangle} from './bitmap.js';
import {BurikoBitmapCompositor} from './bitmap-compositor.js';
import type {BurikoDisplayContext} from './display-object.js';
import {BurikoDisplayObjectLists, type BurikoDisplayListEntry} from './display-object-lists.js';
import {BurikoDistributedProcessing} from './distributed-processing.js';

export interface BurikoDisplayRenderJob {
  rectangle: BurikoBitmapRectangle;
  key: number;
}

/** 06e930: unsigned width division followed by signed-height/unsigned-strip-height division. */
export function burikoDisplayStripCount(
  pixelBudget: number,
  rectangle: BurikoBitmapRectangle,
): number {
  const width = (rectangle.right - rectangle.left + 1) >>> 0;
  if (width === 0) throw new RangeError('Buriko display strip division by zero');
  const stripHeight = Math.max(1, Math.trunc((pixelBudget >>> 0) / width));
  const height = (rectangle.bottom - rectangle.top + 1) | 0;
  return Math.trunc((height - 1 + stripHeight) / stripHeight) >>> 0;
}
export function burikoDisplayStrips(
  pixelBudget: number,
  rectangle: BurikoBitmapRectangle,
): BurikoBitmapRectangle[] {
  const count = burikoDisplayStripCount(pixelBudget, rectangle);
  const stripHeight = Math.max(
    1,
    Math.trunc((pixelBudget >>> 0) / ((rectangle.right - rectangle.left + 1) >>> 0)),
  );
  let remaining = (rectangle.bottom - rectangle.top + 1) >>> 0,
    top = rectangle.top;
  const output = new Array<BurikoBitmapRectangle>(count);
  for (let index = 0; index < count; index++) {
    const height = Math.min(stripHeight, remaining);
    const next = (top + height) | 0;
    output[index] = {left: rectangle.left, top, right: rectangle.right, bottom: (next - 1) | 0};
    top = next;
    remaining = (remaining - height) >>> 0;
  }
  return output;
}

/** Complete native 06e480/06e490 and 06e5c0 draw-worker path, using the actual shared pool. */
export class BurikoDisplayRenderJobs {
  private jobs: readonly BurikoDisplayRenderJob[] = [];
  private cursor = 0;
  constructor(
    readonly lists: BurikoDisplayObjectLists,
    readonly compositor: BurikoBitmapCompositor,
    readonly processing: BurikoDistributedProcessing,
    readonly context: BurikoDisplayContext,
    /** CObjectManager +78; native setter shifts its layer argument left16. */
    public minimumKey: number,
  ) {}

  /** 06e650 expands roots only in the current ordinary node's inclusive key interval. */
  drawExpanded(
    ordinary: BurikoDisplayListEntry,
    context: BurikoDisplayContext,
    rectangle: BurikoBitmapRectangle,
    alternate: BurikoDisplayContext | null,
    threshold: number,
    direction: number,
  ): void {
    const entries = this.lists.entries(true);
    let next = entries.next();
    if (next.done) return;
    let lower = ordinary.object.sortKey() >>> 0;
    let upper = ordinary.next === null ? 0xffffffff : ordinary.next.object.sortKey() >>> 0;
    threshold >>>= 0;
    if (direction === 0) {
      if (threshold < lower) return;
      upper = Math.min(upper, threshold);
    } else if (direction === 1) {
      if (upper < threshold) return;
      lower = Math.max(lower, threshold);
    }
    for (; !next.done; next = entries.next()) {
      const node = next.value;
      if (lower <= node.key) {
        if (upper < node.key) return;
        node.object.drawClipped(context, rectangle, node.key, alternate);
      }
    }
  }
  private claimAndDraw(): 0 | 1 {
    const force = this.processing.enterShared();
    const available = this.cursor < this.jobs.length;
    const job = available ? this.jobs[this.cursor++]! : null;
    this.processing.leaveShared(force);
    if (job === null) return 0;
    const rectangle = {...job.rectangle},
      key = job.key >>> 0;
    for (const node of this.lists.entries(false)) {
      const sortKey = node.object.sortKey() >>> 0;
      if (this.minimumKey >>> 0 <= sortKey || node.object.category === 0)
        node.object.drawClipped(this.context, rectangle, key, null);
      this.drawExpanded(node, this.context, rectangle, null, this.minimumKey, 1);
    }
    return 1;
  }
  run(jobs: readonly BurikoDisplayRenderJob[], distributedFlag: number): void {
    this.jobs = jobs;
    this.cursor = 0;
    this.processing.setCallback((state: BurikoDisplayRenderJobs) => state.claimAndDraw(), this);
    const attach = distributedFlag === 0 && this.compositor.processing === null;
    if (attach) this.compositor.processing = this.processing;
    this.processing.run(distributedFlag);
    if (attach) this.compositor.processing = null;
    this.processing.setCallback(null, null);
  }
}
