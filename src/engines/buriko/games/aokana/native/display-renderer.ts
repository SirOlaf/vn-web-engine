import {
  translateAokanaBitmapRectangle,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import type {AokanaDisplayContext, AokanaDisplayObject} from './display-object.js';
import type {AokanaObjectManager} from './object-manager.js';
import {
  AokanaDisplayRenderJobs,
  aokanaDisplayStripCount,
  aokanaDisplayStrips,
  type AokanaDisplayRenderJob,
} from './display-render-jobs.js';
import {AokanaDistributedProcessing} from './distributed-processing.js';

export interface AokanaDisplayDamageResult {
  /** An all-ones DWORD means full redraw; otherwise this is the output rectangle count. */
  count: number;
  rectangles: AokanaBitmapRectangle[];
}

/** CObjectManager's complete draw traversal, damage submission and worker ownership. */
export class AokanaDisplayRenderer {
  readonly processing: AokanaDistributedProcessing;
  readonly ownsProcessing: boolean;
  private disposed = false;
  constructor(
    readonly manager: AokanaObjectManager,
    pixelBudget: number,
    processing: AokanaDistributedProcessing | null = null,
  ) {
    this.ownsProcessing = processing === null;
    this.processing = processing ?? new AokanaDistributedProcessing(manager.allocator, 1);
    manager.setRenderPixelBudget(pixelBudget);
    manager.attachObjectRenderer(this);
  }
  private check(): void {
    if (this.disposed) throw new Error('Aokana accesses a deleted CObjectManager renderer');
  }
  private context(): AokanaDisplayContext {
    return this.manager.context;
  }
  private jobs(context = this.context()): AokanaDisplayRenderJobs {
    return new AokanaDisplayRenderJobs(
      this.manager.lists,
      this.manager.compositor,
      this.processing,
      context,
      this.manager.minimumKey,
    );
  }
  /** Virtual08, 06ea20; backdrop types6,7,9,10,11 cannot use independent strips. */
  canUseStrips(): 0 | 1 {
    this.check();
    return this.manager.canUseStrips();
  }
  /** Virtual10, 06e9e0 checks full-redraw first, then virtual08, then any visible effector. */
  canDrawDamage(): 0 | 1 {
    this.check();
    return this.manager.canDrawDamage();
  }
  /** 06ea60 sends notifications after damage has been cleared, ordinary then expanded roots. */
  private finishDraw(): void {
    this.manager.damage.clear();
    for (const entry of this.manager.lists.entries(false)) entry.object.notify(0xf0000000, 0, 0);
    for (const object of this.manager.lists.expandedRoots()) object.notify(0xf0000000, 0, 0);
  }
  /** 06eb20 performs a whole-context draw without the 06f110 conditional invalidation pass. */
  drawFull(): void {
    this.check();
    this.manager.objectLock.run(() => this.drawFullLocked());
  }
  private drawFullLocked(): void {
    const context = this.context(),
      flag = this.canUseStrips();
    const count =
      flag === 0 ? 1 : aokanaDisplayStripCount(this.manager.renderPixelBudget, context.bounds);
    // Static native review: a zero job allocation cannot hold the subsequent native first write.
    if (count === 0) throw new RangeError('Aokana full redraw has no native job storage');
    const rectangles =
      count < 2
        ? [{...context.bounds}]
        : aokanaDisplayStrips(this.manager.renderPixelBudget, context.bounds);
    this.jobs(context).run(
      rectangles.map((rectangle) => ({rectangle, key: 0})),
      flag,
    );
    this.finishDraw();
  }
  /** 06f110 preserves recorded rectangle/key order and returns all-ones for full redraw. */
  drawDamage(): AokanaDisplayDamageResult {
    this.check();
    return this.manager.objectLock.run(() => this.drawDamageLocked());
  }
  private drawDamageLocked(): AokanaDisplayDamageResult {
    for (const entry of this.manager.lists.entries(false))
      if (entry.object.conditionalDamage !== 0) entry.object.invalidate();
    for (const object of this.manager.lists.expandedRoots())
      if (object.conditionalDamage !== 0) object.invalidate();
    if (this.canDrawDamage() === 0) {
      this.drawFull();
      return {count: 0xffffffff, rectangles: []};
    }
    const damage = this.manager.damage.snapshot();
    let jobCount = 0;
    const counts = damage.map((entry) => {
      const count = aokanaDisplayStripCount(this.manager.renderPixelBudget, entry.rectangle);
      jobCount = (jobCount + count) >>> 0;
      return count;
    });
    const jobs = new Array<AokanaDisplayRenderJob>(jobCount);
    let cursor = 0;
    for (let index = 0; index < damage.length; index++) {
      const entry = damage[index]!,
        count = counts[index]!;
      const rectangles =
        count < 2
          ? [{...entry.rectangle}]
          : aokanaDisplayStrips(this.manager.renderPixelBudget, entry.rectangle);
      for (const rectangle of rectangles) {
        if (cursor >= jobCount)
          throw new RangeError('Aokana damage redraw exceeds its native job storage');
        jobs[cursor++] = {rectangle, key: entry.key};
      }
    }
    this.jobs().run(jobs, 1);
    this.finishDraw();
    return {count: damage.length >>> 0, rectangles: damage.map((entry) => entry.rectangle)};
  }
  /** 06ee90 collects ordinary object pointers in list order, without visibility filtering. */
  collectOrdinary(): AokanaDisplayObject[] {
    this.check();
    return this.manager.objectLock.run(() =>
      Array.from(this.manager.lists.entries(false), (entry) => entry.object),
    );
  }
  /** 06ed80 draws through an inclusive maximum layer into a copied output descriptor. */
  drawToBitmap(destination: AokanaBitmap, maximumLayer: number): void {
    this.check();
    const context = {
      bitmap: {...destination},
      bounds: {
        left: 0,
        top: 0,
        right: (destination.width - 1) | 0,
        bottom: (destination.height - 1) | 0,
      },
    };
    const upper = ((maximumLayer << 16) | 0xffff) >>> 0,
      renderer = this.jobs(context);
    this.manager.objectLock.run(() => {
      for (const entry of this.manager.lists.entries(false)) {
        if (entry.object.sortKey() >>> 0 <= upper)
          entry.object.drawClipped(context, context.bounds, 0, null);
        renderer.drawExpanded(entry, context, context.bounds, null, upper, 0);
      }
    });
  }
  /** 06ec80 clears the destination before drawing a translated logical rectangle. */
  drawTranslated(destination: AokanaBitmap, x: number, y: number, maximumLayer: number): void {
    this.check();
    const alternate = {
      bitmap: {...destination},
      bounds: {
        left: 0,
        top: 0,
        right: (destination.width - 1) | 0,
        bottom: (destination.height - 1) | 0,
      },
    };
    translateAokanaBitmapRectangle(alternate.bounds, x, y);
    clearAokanaBitmap(destination);
    const context = this.context(),
      upper = ((maximumLayer << 16) | 0xffff) >>> 0;
    const renderer = this.jobs(context);
    this.manager.objectLock.run(() => {
      for (const entry of this.manager.lists.entries(false)) {
        if (entry.object.sortKey() >>> 0 <= upper)
          entry.object.drawClipped(context, alternate.bounds, 0, alternate);
        renderer.drawExpanded(entry, context, alternate.bounds, alternate, upper, 0);
      }
    });
  }
  /** 06ef90 clears nodes and damage, then deletes only a privately constructed worker manager. */
  dispose(): void {
    this.check();
    this.manager.clearObjectLists();
    if (this.ownsProcessing) this.processing.dispose();
    this.disposed = true;
  }
}
