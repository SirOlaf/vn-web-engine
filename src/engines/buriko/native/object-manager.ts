import {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {BurikoDisplayCriticalSection} from './display-critical-section.js';
import {BurikoDisplayDamage} from './display-damage.js';
import {BurikoDisplayEffectorRegistry} from './display-effector-registry.js';
import type {BurikoDisplayContext} from './display-object.js';
import {BurikoDisplayObjectLists} from './display-object-lists.js';
import {BurikoDisplayRenderer} from './display-renderer.js';
import {BurikoDistributedAllocator} from './distributed-processing.js';
import {BurikoSurfaces} from './surfaces.js';

/** The concrete CObjectManager state, shared by the global and window-local classes.
 * Its descriptor is a referenced record. Object pools, surfaces and CDspObj globals
 * remain owned by their separate native classes. */
export class BurikoObjectManager {
  readonly objectLock: BurikoDisplayCriticalSection;
  readonly lists: BurikoDisplayObjectLists;
  protected objectRenderer: BurikoDisplayRenderer | null = null;
  private renderPixelBudgetValue: number | undefined;
  private cachedBackdropType = 0;
  private objectManagerDisposed = false;
  minimumKey = 0;

  constructor(
    readonly compositor: BurikoBitmapCompositor,
    readonly allocator: BurikoDistributedAllocator,
    readonly damage: BurikoDisplayDamage,
    private readonly readContext: () => BurikoDisplayContext | null,
    readonly effectors: BurikoDisplayEffectorRegistry,
  ) {
    this.objectLock = new BurikoDisplayCriticalSection(() => allocator.currentActor);
    damage.bindCriticalSection(this.objectLock);
    this.lists = new BurikoDisplayObjectLists(this.objectLock, () => damage.clear());
    // 06EFF0 clears its new roots, sets minimum key zero, caches backdrop type zero,
    // then requests full damage. The supplied processing owner is installed by renderer.
    damage.clear();
    damage.force();
  }

  protected checkObjectManager(): void {
    if (this.objectManagerDisposed) throw new Error('Buriko accesses a deleted CObjectManager');
  }
  get context(): BurikoDisplayContext {
    this.checkObjectManager();
    const context = this.readContext();
    if (context === null) throw new Error('Buriko draws before display descriptor configuration');
    return context;
  }
  /** 06EA20 reads this cached +80 value. */
  get backdropRenderType(): number {
    this.checkObjectManager();
    return this.cachedBackdropType;
  }
  /** 06EAF0. */
  setBackdropRenderType(value: number): void {
    this.checkObjectManager();
    this.cachedBackdropType = value >>> 0;
  }
  /** 06EB00; the field is a strip pixel budget, independent of object count. */
  get renderPixelBudget(): number {
    this.checkObjectManager();
    if (this.renderPixelBudgetValue === undefined)
      throw new Error('Buriko render-strip pixel budget has not been configured');
    return this.renderPixelBudgetValue;
  }
  /** 06EB10. */
  setRenderPixelBudget(value: number): void {
    this.checkObjectManager();
    this.renderPixelBudgetValue = value >>> 0;
  }
  attachObjectRenderer(renderer: BurikoDisplayRenderer): void {
    this.checkObjectManager();
    if (this.objectRenderer !== null && this.objectRenderer !== renderer)
      throw new Error('Buriko object manager already has its renderer');
    this.objectRenderer = renderer;
  }
  /** Prepare the shared CObjectManager renderer after the CPU-derived budget is selected.
   * This only establishes traversal/worker ownership; display texture setup is separate. */
  initializeObjectRenderer(): BurikoDisplayRenderer {
    this.checkObjectManager();
    if (this.objectRenderer !== null) return this.objectRenderer;
    return new BurikoDisplayRenderer(this, this.renderPixelBudget);
  }
  /** 06F380. */
  clearDamage(): void {
    this.checkObjectManager();
    this.damage.clear();
  }
  /** 06EF20 shares +B8 with draw, list edits and recursive damage clearing. */
  clearObjectLists(): void {
    this.checkObjectManager();
    this.lists.clear();
  }
  /** Virtual08, 06EA20. */
  canUseStrips(): 0 | 1 {
    this.checkObjectManager();
    const type = this.backdropRenderType;
    return (type === 8 || type < 6 || type > 11) && this.effectors.permitsDistributedDraw() ? 1 : 0;
  }
  /** Virtual10, 06E9E0 invokes the current virtual08. */
  canDrawDamage(): 0 | 1 {
    this.checkObjectManager();
    return this.damage.fullRedraw === 0 && this.canUseStrips() !== 0 && !this.effectors.hasVisible()
      ? 1
      : 0;
  }
  /** 06EF90 clears nodes and destroys only the processing object it constructed. */
  dispose(): void {
    this.checkObjectManager();
    if (this.objectRenderer !== null) this.objectRenderer.dispose();
    else this.clearObjectLists();
    this.objectManagerDisposed = true;
  }
}

/** DCInnerDspObjMngr, 094AF0. Window 068040 owns this separate local manager. */
export class BurikoInnerDisplayObjectManager extends BurikoObjectManager {
  readonly renderer: BurikoDisplayRenderer;
  constructor(
    count: number,
    context: BurikoDisplayContext,
    surfaces: BurikoSurfaces,
    effectors: BurikoDisplayEffectorRegistry,
  ) {
    super(
      surfaces.compositor,
      surfaces.allocator,
      new BurikoDisplayDamage(count >>> 0, context.bounds),
      () => context,
      effectors,
    );
    this.renderer = new BurikoDisplayRenderer(this, 0xffffffff, null);
  }
  /** 094AB0 returns one independently of the global backdrop and effectors. */
  override canUseStrips(): 1 {
    this.checkObjectManager();
    return 1;
  }
  /** 094AA0 returns one even when the base full-damage flag is set. */
  override canDrawDamage(): 1 {
    this.checkObjectManager();
    return 1;
  }
}
