import {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {AokanaDisplayCriticalSection} from './display-critical-section.js';
import {AokanaDisplayDamage} from './display-damage.js';
import {AokanaDisplayEffectorRegistry} from './display-effector-registry.js';
import type {AokanaDisplayContext} from './display-object.js';
import {AokanaDisplayObjectLists} from './display-object-lists.js';
import {AokanaDisplayRenderer} from './display-renderer.js';
import {AokanaDistributedAllocator} from './distributed-processing.js';
import {AokanaSurfaces} from './surfaces.js';

/** The concrete CObjectManager state, shared by the global and window-local classes.
 * Its descriptor is a referenced record. Object pools, surfaces and CDspObj globals
 * remain owned by their separate native classes. */
export class AokanaObjectManager {
  readonly objectLock: AokanaDisplayCriticalSection;
  readonly lists: AokanaDisplayObjectLists;
  protected objectRenderer: AokanaDisplayRenderer | null = null;
  private renderPixelBudgetValue: number | undefined;
  private cachedBackdropType = 0;
  private objectManagerDisposed = false;
  minimumKey = 0;

  constructor(
    readonly compositor: AokanaBitmapCompositor,
    readonly allocator: AokanaDistributedAllocator,
    readonly damage: AokanaDisplayDamage,
    private readonly readContext: () => AokanaDisplayContext | null,
    readonly effectors: AokanaDisplayEffectorRegistry,
  ) {
    this.objectLock = new AokanaDisplayCriticalSection(() => allocator.currentActor);
    damage.bindCriticalSection(this.objectLock);
    this.lists = new AokanaDisplayObjectLists(this.objectLock, () => damage.clear());
    // 06EFF0 clears its new roots, sets minimum key zero, caches backdrop type zero,
    // then requests full damage. The supplied processing owner is installed by renderer.
    damage.clear();
    damage.force();
  }

  protected checkObjectManager(): void {
    if (this.objectManagerDisposed) throw new Error('Aokana accesses a deleted CObjectManager');
  }
  get context(): AokanaDisplayContext {
    this.checkObjectManager();
    const context = this.readContext();
    if (context === null) throw new Error('Aokana draws before display descriptor configuration');
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
      throw new Error('Aokana render-strip pixel budget has not been configured');
    return this.renderPixelBudgetValue;
  }
  /** 06EB10. */
  setRenderPixelBudget(value: number): void {
    this.checkObjectManager();
    this.renderPixelBudgetValue = value >>> 0;
  }
  attachObjectRenderer(renderer: AokanaDisplayRenderer): void {
    this.checkObjectManager();
    if (this.objectRenderer !== null && this.objectRenderer !== renderer)
      throw new Error('Aokana object manager already has its renderer');
    this.objectRenderer = renderer;
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
    return (type === 8 || type < 6 || type > 11) && this.effectors.permitsDistributedDraw()
      ? 1
      : 0;
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
export class AokanaInnerDisplayObjectManager extends AokanaObjectManager {
  readonly renderer: AokanaDisplayRenderer;
  constructor(
    count: number,
    context: AokanaDisplayContext,
    surfaces: AokanaSurfaces,
    effectors: AokanaDisplayEffectorRegistry,
  ) {
    super(
      surfaces.compositor,
      surfaces.allocator,
      new AokanaDisplayDamage(count >>> 0, context.bounds),
      () => context,
      effectors,
    );
    this.renderer = new AokanaDisplayRenderer(this, 0xffffffff, null);
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
