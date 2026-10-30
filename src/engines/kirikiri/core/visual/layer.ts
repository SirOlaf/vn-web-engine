/**
 * `tTJSNI_BaseLayer` (krkrz `visual/LayerIntf.cpp`): the layer tree, geometry, images, drawing
 * functions, input and focus handling, caching, the update/completion pipeline and the
 * transition plumbing. The TJS class is `../classes/layer.ts`; the manager of a tree is
 * `layer-manager.ts`.
 *
 * Coordinates: a layer's `rect` is in its parent's coordinates; drawing functions take image
 * coordinates (offset by `imageLeft`/`imageTop` from the layer's own). Update regions travel
 * up the tree (`updateChildRegion`) to the manager, which completes them onto its draw device.
 *
 * Events are immediate script events (`TVP_EPT_IMMEDIATE`). The `fire…` methods return the
 * call's result code, which may be `TJS_E_SUSPENDED`; callers that continue afterwards run
 * them without suspension (`#fireNow`).
 */
import {TjsError, throwTjsError, tjsMessage} from '../../tjs2/runtime/errors.js';
import type {KirikiriMessageName} from '../../messages.js';
import {ObjectList} from './object-list.js';
import {
  TJS_MEMBERENSURE,
  TJS_S_OK,
  TJS_S_TRUE,
  failed,
  type Dispatch,
} from '../../tjs2/runtime/interface.js';
import {
  NativeInstanceBase,
  getNativeInstance,
  registerNativeClass,
} from '../../tjs2/runtime/native.js';
import {addRefVariant, releaseVariant, VariantSlot} from '../../tjs2/runtime/slot.js';
import {closureFuncCall} from '../../tjs2/runtime/dispatch.js';
import {
  NULL_OBJECT,
  asInteger,
  asObjectClosure,
  bool,
  int,
  integer,
  obj,
  real,
  str,
  type ObjectVariant,
  type Variant,
} from '../../tjs2/runtime/variant.js';
import type {TjsEngine} from '../../tjs2/runtime/engine.js';
import {
  TVP_COMPACT_LEVEL_DEACTIVATE,
  TVP_EPT_DISCARDABLE,
  TVP_EPT_IMMEDIATE,
  type TvpCompactEventCallback,
  type TvpContinuousEventCallback,
  type TvpEventSystem,
} from '../events.js';
import type {TvpLog} from '../log.js';
import {BltMethod, TVP_BB_COPY_MAIN, TVP_BB_COPY_MASK, TvpBaseBitmap} from './base-bitmap.js';
import {TvpComplexRect, TvpRect, intersectRect, unionRect} from './complex-rect.js';
import {
  TVP_TF_BOLD,
  TVP_TF_FONTFILE,
  TVP_TF_ITALIC,
  TVP_TF_STRIKEOUT,
  TVP_TF_UNDERLINE,
  copyFont,
  type TvpFont,
  type TvpFontSystem,
} from './font.js';
import {TvpLayerManager} from './layer-manager.js';
import {
  TVP_SS_ALT,
  TVP_SS_CTRL,
  TVP_SS_SHIFT,
  TvpTempBitmapHolder,
  dfAddAlpha,
  dfAlpha,
  dfAuto,
  dfMask,
  dfOpaque,
  dfProvince,
  htMask,
  htProvince,
  imDisable,
  isTypeUsingAddAlpha,
  isTypeUsingAlpha,
  isTypeUsingAlphaChannel,
  ltAddAlpha,
  ltAdditive,
  ltAlpha,
  ltBinder,
  ltDarken,
  ltDodge,
  ltEffect,
  ltFilter,
  ltLighten,
  ltMultiplicative,
  ltOpaque,
  ltPsAdditive,
  ltPsColorBurn,
  ltPsColorDodge,
  ltPsColorDodge5,
  ltPsDarken,
  ltPsDifference,
  ltPsDifference5,
  ltPsExclusion,
  ltPsHardLight,
  ltPsLighten,
  ltPsMultiplicative,
  ltPsNormal,
  ltPsOverlay,
  ltPsScreen,
  ltPsSoftLight,
  ltPsSubtractive,
  ltScreen,
  ltSubtractive,
  omAddAlpha,
  omAdditive,
  omAlpha,
  omAuto,
  omDarken,
  omDodge,
  omLighten,
  omMultiplicative,
  omOpaque,
  omPsAdditive,
  omPsColorBurn,
  omPsColorDodge,
  omPsColorDodge5,
  omPsDarken,
  omPsDifference,
  omPsDifference5,
  omPsExclusion,
  omPsHardLight,
  omPsLighten,
  omPsMultiplicative,
  omPsNormal,
  omPsOverlay,
  omPsScreen,
  omPsSoftLight,
  omPsSubtractive,
  omScreen,
  omSubtractive,
  type TvpDrawable,
  type TvpLayerTreeOwner,
} from './layer-types.js';
import type {TvpMemory} from './memory.js';
import {
  TvpBaseBitmapScanLineProvider,
  TvpObjectOptionProvider,
  ttExchange,
  ttSimple,
  tutDivisible,
  tutDivisibleFade,
  tutGiveUpdate,
  type TvpDivisibleData,
  type TvpDivisibleTransHandler,
  type TvpGiveUpdateTransHandler,
  type TvpTransitionRegistry,
} from './transition.js';

export const LAYER_CLASS_ID = registerNativeClass('Layer');
export const BITMAP_CLASS_ID = registerNativeClass('Bitmap');

export const TVP_UPDATE_UNITE_LIMIT = 300;
const TVP_CACHE_UNITE_LIMIT = 60;
const TVP_EXPOSED_UNITE_LIMIT = 30;
const TVP_DIRECT_UNITE_LIMIT = 10;

/** `tTVPGraphicSplitOperationType`. */
const gsotNone = 0;
const gsotSimple = 1;
const gsotInterlace = 2;
const gsotBiDirection = 3;

const VK_TAB = 0x09;
const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;

/** `TVPToActualColor` (system colours `clXXX` become RGB) and `TVPFromActualColor`. */
export interface TvpColorConversion {
  toActual(color: number): number;
  fromActual(color: number): number;
}

/** A graphic loaded into a bitmap (`TVPLoadGraphic`). */
export interface TvpLoadedGraphic {
  /** The province image name the graphic names, or the empty string. */
  readonly provinceName: string;
  /** The meta information dictionary (owned by the caller), or null. */
  readonly metainfo: Dispatch | null;
}

/** `glmNormal`, `glmPalettized`, `glmGrayscale`. */
export const glmNormal = 0;
export const glmPalettized = 1;
export const glmGrayscale = 2;

/** `TVPLoadGraphic` (`GraphicsLoaderIntf.cpp`). */
export interface TvpGraphicsLoader {
  load(
    dest: TvpBaseBitmap,
    name: string,
    keyidx: number,
    desw: number,
    desh: number,
    mode: number,
  ): TvpLoadedGraphic | Promise<TvpLoadedGraphic>;
}

/** What layers need from the core. */
export interface TvpVisualContext {
  readonly engine: TjsEngine;
  readonly events: TvpEventSystem;
  readonly log: TvpLog;
  readonly memory: TvpMemory;
  readonly fonts: TvpFontSystem;
  readonly temp: TvpTempBitmapHolder;
  readonly transitions: TvpTransitionRegistry;
  readonly colors: TvpColorConversion;
  /** `TVPGetTickCount`. */
  tickCount(): bigint;
  /** `TVPGetCursor`: the cursor number of a cursor storage. */
  getCursor(storage: string): number;
  /** `TVPCreateFontObject`: a Font object bound to the layer `owner` (owned by the caller). */
  createFontObject(owner: Dispatch): Dispatch;
  /** `TJSCreateArrayObject` (owned by the caller). */
  createArray(): Dispatch;
  /** `TVPLoadGraphic`; null until a graphics loader is configured. */
  readonly graphics: TvpGraphicsLoader | null;
  /** `TVPGraphicSplitOperationType` (`gsotSimple` by default). */
  readonly splitOperationType: number;
  /** `TVPDefaultHoldAlpha`. */
  readonly defaultHoldAlpha: boolean;
  /** `TVPFreeUnusedLayerCache`. */
  readonly freeUnusedLayerCache: boolean;
}

/** `t2DAffineMatrix`. */
export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/** `tTVPGLGammaAdjustData`. */
export interface GammaAdjustData {
  RGamma: number;
  RFloor: number;
  RCeil: number;
  GGamma: number;
  GFloor: number;
  GCeil: number;
  BGamma: number;
  BFloor: number;
  BCeil: number;
}

function notAvailable(what: string): never {
  throw new TjsError(`${what} is not available`);
}

/** The native instance of a layer object, or null. */
export function layerOf(object: Dispatch | null): LayerNI | null {
  return getNativeInstance<LayerNI>(object, LAYER_CLASS_ID);
}

/** `tTJSNI_BaseLayer`. */
export class LayerNI extends NativeInstanceBase implements TvpDrawable, TvpCompactEventCallback {
  owner: Dispatch | null = null;
  actionOwner: ObjectVariant = NULL_OBJECT;
  shutdown = false;
  #compactEventHookInit = false;

  manager: TvpLayerManager | null = null;

  // tree
  parent: LayerNI | null = null;
  readonly childList = new ObjectList<LayerNI>();
  name = '';
  visible = false;
  opacity = 255;
  orderIndex = 0;
  overallOrderIndex = 0;
  absoluteOrderMode = false;
  absoluteOrderIndex = 0;
  childrenOrderIndexValid = false;
  #visibleChildrenCount = -1;
  #childrenArray: Dispatch | null = null;
  #childrenArrayValid = false;

  // type
  type = ltAlpha;
  displayType = ltAlpha;

  // geometry
  readonly rect = new TvpRect(0, 0, 32, 32);
  #exposedRegionValid = false;
  readonly #exposedRegion = new TvpComplexRect();
  readonly #overlappedRegion = new TvpComplexRect();

  // images
  mainImage: TvpBaseBitmap | null = null;
  #canHaveImage = true;
  provinceImage: TvpBaseBitmap | null = null;
  neutralColor = 0x00ffffff;
  #transparentColor = 0x00ffffff;
  imageLeft = 0;
  imageTop = 0;

  // input / hit test
  hitType = htMask;
  hitThreshold = 16;
  #onHitTestWork = false;
  enabled = true;
  enabledWork = false;
  focusable = false;
  joinFocusChain = true;
  focusWork: LayerNI | null = null;
  attentionLeft = 0;
  attentionTop = 0;
  useAttention = false;
  imeMode = imDisable;
  cursor = 0;
  #cursorXWork = 0;
  hint = '';
  showParentHint = true;
  ignoreHintSensing = false;

  // cache
  #cacheBitmap: TvpBaseBitmap | null = null;
  readonly #cachedRegion = new TvpComplexRect();
  #cacheEnabledCount = 0;
  cached = false;

  // drawing
  #drawFace = dfAlpha;
  face = dfAuto;
  holdAlpha: boolean;
  imageModified = false;
  readonly clipRect = new TvpRect(0, 0, 0, 0);

  // font
  #font: TvpFont;
  #fontChanged = true;
  #fontObject: Dispatch | null = null;

  // update
  #updateOfsX = 0;
  #updateOfsY = 0;
  readonly #updateRectForChild = new TvpRect();
  #updateRectForChildOfsX = 0;
  #updateRectForChildOfsY = 0;
  #currentDrawTarget: TvpDrawable | null = null;
  #updateBitmapForChild: TvpBaseBitmap | null = null;
  readonly updateExcludeRect = new TvpRect();
  readonly #cacheRecalcRegion = new TvpComplexRect();
  readonly #drawnRegion = new TvpComplexRect();
  #directTransferToParent = false;
  callOnPaint = false;
  #inCompletion = false;

  // transition
  #divisibleTransHandler: TvpDivisibleTransHandler | null = null;
  #giveUpdateTransHandler: TvpGiveUpdateTransHandler | null = null;
  #transDest: LayerNI | null = null;
  #transDestObj: Dispatch | null = null;
  #transSrc: LayerNI | null = null;
  #transSrcObj: Dispatch | null = null;
  inTransition = false;
  #transWithChildren = false;
  #transSelfUpdate = false;
  #transTick = 0n;
  #useTransTickCallback = false;
  #transTickCallback: ObjectVariant = NULL_OBJECT;
  #transType = ttSimple;
  #transUpdateType = tutDivisibleFade;
  #destSLP: TvpBaseBitmapScanLineProvider | null = null;
  #srcSLP: TvpBaseBitmapScanLineProvider | null = null;
  #transCompEventPrevented = false;
  readonly #transDrawable = new TransDrawable(this);
  readonly #transIdleCallback: TvpContinuousEventCallback = {
    onContinuousCallback: (tick) => {
      this.#invokeTransition(tick);
      return TJS_S_OK;
    },
  };

  constructor(readonly ctx: TvpVisualContext) {
    super();
    this.holdAlpha = ctx.defaultHoldAlpha;
    this.#updateDrawFace();
    this.#allocateDefaultImage();
    this.#font = copyFont(this.mainImage!.font);
  }

  get suspender() {
    return this.ctx.engine.suspender;
  }

  // --- object lifetime -----------------------------------------------------------------------

  override construct(args: readonly Variant[], owner: Dispatch): number {
    if (args.length < 2) return -4; // TJS_E_BADPARAMCOUNT
    this.owner = owner;
    const win = asObjectClosure(args[0]!);
    if (!win.object)
      throw new TjsError('layerTreeOwnerInterfaceを持つオブジェクトを指定してください');
    const ifaceSlot = new VariantSlot();
    let lto: TvpLayerTreeOwner | null;
    try {
      if (
        failed(
          win.object.propGet(0, 'layerTreeOwnerInterface', ifaceSlot, win.objthis ?? win.object),
        )
      )
        throw new TjsError('Cannot Retrive Layer Tree Owner Interface.');
      lto = this.ctx.memory.objectAt<TvpLayerTreeOwner>(Number(asInteger(ifaceSlot.value)));
    } finally {
      ifaceSlot.clear();
    }
    const par = asObjectClosure(args[1]!);
    let lay: LayerNI | null = null;
    if (par.object) {
      lay = layerOf(par.object);
      if (!lay) throwTjsError('TVPSpecifyLayer');
    }
    if (lay) {
      this.manager = lay.manager;
      this.manager!.addRef();
      this.#join(lay);
    } else {
      if (!lto) throw new TjsError('Cannot Retrive Layer Tree Owner Interface.');
      this.manager = new TvpLayerManager(lto, this.suspender);
      this.manager.attachPrimary(this);
      this.manager.registerSelfToWindow();
      this.type = this.displayType = ltOpaque;
      this.neutralColor = this.#transparentColor = 0xffffffff;
      this.#updateDrawFace();
      this.hitThreshold = 0;
    }
    const ao = asObjectClosure(args[0]!);
    addRefVariant(ao);
    this.actionOwner = ao;
    return TJS_S_OK;
  }

  override invalidate(): void {
    this.shutdown = true;
    this.stopTransition();
    if (this.#transDest) this.#transDest.stopTransition();
    this.#destSLP = this.#srcSLP = null;
    if (this.owner) this.ctx.events.cancelSourceEvents(this.owner);
    if (this.isPrimary) {
      this.manager?.detachPrimary();
      this.manager!.unregisterSelfFromWindow();
    }
    if (this.manager) {
      this.manager.release();
      this.manager = null;
    }
    this.#part();
    this.childList.safeForEach((child) => child.#part());
    this.#childrenChanged();
    if (this.#fontObject) {
      this.#fontObject.invalidate(0, null, this.#fontObject);
      this.#fontObject.release();
      this.#fontObject = null;
    }
    this.#deallocateImage();
    this.#deallocateCache();
    releaseVariant(this.actionOwner);
    this.actionOwner = NULL_OBJECT;
    if (this.#childrenArray) {
      this.#childrenArray.release();
      this.#childrenArray = null;
    }
    if (this.#compactEventHookInit) this.ctx.events.removeCompactEventHook(this);
    if (this.owner) this.ctx.events.cancelSourceEvents(this.owner);
  }

  #registerCompactEventHook(): void {
    if (!this.#compactEventHookInit) {
      this.ctx.events.addCompactEventHook(this);
      this.#compactEventHookInit = true;
    }
  }

  onCompact(level: number): void {
    if (level >= TVP_COMPACT_LEVEL_DEACTIVATE) this.#compactCache();
  }

  get layerTreeOwner(): TvpLayerTreeOwner | null {
    return this.manager?.layerTreeOwner ?? null;
  }

  // --- events ----------------------------------------------------------------------------------

  /** `TVPPostEvent(Owner, Owner, name, 0, flags, args)`. */
  #post(name: string, args: readonly Variant[] = [], flags = TVP_EPT_IMMEDIATE): number {
    return this.ctx.events.postEvent(this.owner!, this.owner!, name, 0, flags, args);
  }

  /** An immediate event whose caller continues afterwards. */
  #postNow(name: string, args: readonly Variant[] = [], flags = TVP_EPT_IMMEDIATE): void {
    this.suspender.nonSuspending(() => this.#post(name, args, flags));
  }

  #ownerVariant(l: LayerNI | null): Variant {
    return l ? obj(l.owner, l.owner) : NULL_OBJECT;
  }

  // --- tree management -----------------------------------------------------------------------

  /** `TVP_LAYER_FOR_EACH_CHILD_END`: the caches every locked child loop invalidates. */
  #childrenChanged(): void {
    this.#childrenArrayValid = false;
    this.childrenOrderIndexValid = false;
    this.manager?.invalidateOverallIndex();
  }

  /** Children in order, without holes (`TVP_LAYER_FOR_EACH_CHILD_NOLOCK`). */
  #forEachChildNoLock(fn: (child: LayerNI) => void): void {
    const n = this.childList.count;
    for (let i = 0; i < n; i++) {
      const c = this.childList.at(i);
      if (c) fn(c);
    }
  }

  /** `TVP_LAYER_FOR_EACH_CHILD_BEGIN … END`. */
  #forEachChild(fn: (child: LayerNI) => void): void {
    try {
      this.childList.safeForEach(fn);
    } finally {
      this.#childrenChanged();
    }
  }

  #join(parent: LayerNI | null): void {
    if (parent === this) throwTjsError('TVPCannotSetParentSelf');
    if (parent && parent.manager !== this.manager)
      throwTjsError('TVPCannotMoveToUnderOtherPrimaryLayer');
    if (this.parent) this.#part();
    this.parent = parent;
    if (parent) parent.#addChild(this);
  }

  #part(): void {
    this.update();
    this.manager?.notifyPart(this);
    if (this.parent) {
      this.parent.#severChild(this);
      this.parent = null;
    }
  }

  #addChild(child: LayerNI): void {
    this.#notifyChildrenVisualStateChanged();
    this.childList.add(child);
    if (this.absoluteOrderMode) {
      this.childList.compact();
      const count = this.childList.count;
      if (count >= 2) {
        const last = this.childList.at(count - 2)!;
        child.absoluteOrderIndex = last.getAbsoluteOrderIndex() + 1;
      }
    }
    this.#childrenArrayValid = false;
    this.childrenOrderIndexValid = false;
    this.manager?.checkTreeFocusableState(child);
    this.manager?.invalidateOverallIndex();
  }

  #severChild(child: LayerNI): void {
    this.manager?.blurTree(child);
    this.#notifyChildrenVisualStateChanged();
    this.childList.remove(child);
    this.#childrenArrayValid = false;
    this.childrenOrderIndexValid = false;
    this.manager?.invalidateOverallIndex();
  }

  /** `GetChildrenArrayObjectNoAddRef`. */
  getChildrenArrayObject(): Dispatch {
    if (!this.#childrenArray) this.#childrenArray = this.ctx.createArray();
    if (!this.#childrenArrayValid) {
      const arr = this.#childrenArray;
      arr.funcCall(0, 'clear', null, [], arr);
      let count = 0;
      this.#forEachChildNoLock((child) => {
        arr.propSetByNum(TJS_MEMBERENSURE, count, obj(child.owner, child.owner), arr);
        count++;
      });
      this.#childrenArrayValid = true;
    }
    return this.#childrenArray;
  }

  #getAncestorChild(ancestor: LayerNI): LayerNI | null {
    let c: LayerNI = this;
    let p = this.parent;
    while (p) {
      if (p === ancestor) return c;
      c = p;
      p = p.parent;
    }
    return null;
  }

  isAncestor(ancestor: LayerNI): boolean {
    let p = this.parent;
    while (p) {
      if (p === ancestor) return true;
      p = p.parent;
    }
    return false;
  }

  isAncestorOrSelf(ancestor: LayerNI): boolean {
    return ancestor === this || this.isAncestor(ancestor);
  }

  recreateOverallOrderIndex(index: {value: number}, nodes: LayerNI[]): void {
    this.overallOrderIndex = index.value;
    index.value++;
    nodes.push(this);
    this.#forEachChildNoLock((child) => child.recreateOverallOrderIndex(index, nodes));
  }

  /** `Exchange`: swaps this layer and `target` in the tree. */
  exchange(target: LayerNI, keepChildren = false): void {
    if (this === target) return;
    const thisAncestorChild = this.#getAncestorChild(target);
    const targetAncestorChild = target.#getAncestorChild(this);
    const thisParent = this.parent;
    const targetParent = target.parent;
    const thisPrimary = this.isPrimary;
    const targetPrimary = target.isPrimary;
    const thisParentAbsolute = this.parent ? this.parent.absoluteOrderMode : true;
    const thisIndex = this.getAbsoluteOrderIndex();
    const targetParentAbsolute = target.parent ? target.parent.absoluteOrderMode : true;
    const targetIndex = target.getAbsoluteOrderIndex();

    if (this.manager) {
      if (thisPrimary) this.manager.detachPrimary();
      if (targetPrimary) this.manager.detachPrimary();
    }
    this.#part();
    target.#part();

    let thisJoinedParent: LayerNI | null;
    let targetJoinedParent: LayerNI | null;

    const severChildrenAndJoin = (joinBoth: () => void) => {
      const thisOrders: number[] = [];
      const targetOrders: number[] = [];
      const thisChildren = ObjectList.from(this.childList);
      const targetChildren = ObjectList.from(target.childList);
      const thisCount = thisChildren.actualCount();
      const targetCount = targetChildren.actualCount();
      for (let i = 0; i < thisCount; i++) {
        thisOrders.push(thisChildren.at(i)!.getAbsoluteOrderIndex());
        thisChildren.at(i)!.#part();
      }
      for (let i = 0; i < targetCount; i++) {
        targetOrders.push(targetChildren.at(i)!.getAbsoluteOrderIndex());
        targetChildren.at(i)!.#part();
      }
      joinBoth();
      for (let i = 0; i < thisCount; i++) thisChildren.at(i)!.#join(target);
      for (let i = 0; i < targetCount; i++) targetChildren.at(i)!.#join(this);
      if (this.absoluteOrderMode && target.absoluteOrderMode) {
        for (let i = 0; i < thisCount; i++)
          thisChildren.at(i)!.setAbsoluteOrderIndex(thisOrders[i]!);
        for (let i = 0; i < targetCount; i++)
          targetChildren.at(i)!.setAbsoluteOrderIndex(targetOrders[i]!);
      }
    };

    if (thisAncestorChild) {
      // "this" is a descendant of "target".
      if (thisAncestorChild !== this) thisAncestorChild.#part();
      const joinBoth = () => {
        this.#join((thisJoinedParent = targetParent));
        if (target === thisParent) target.#join((targetJoinedParent = this));
        else target.#join((targetJoinedParent = thisParent));
      };
      if (!keepChildren) joinBoth();
      else severChildrenAndJoin(joinBoth);
      if (thisAncestorChild !== this) thisAncestorChild.#join(this);
    } else if (targetAncestorChild) {
      // "target" is a descendant of "this".
      if (targetAncestorChild !== target) targetAncestorChild.#part();
      const joinBoth = () => {
        if (this === targetParent) this.#join((thisJoinedParent = target));
        else this.#join((thisJoinedParent = targetParent));
        target.#join((targetJoinedParent = thisParent));
      };
      if (!keepChildren) joinBoth();
      else severChildrenAndJoin(joinBoth);
      if (targetAncestorChild !== target) targetAncestorChild.#join(target);
    } else {
      const joinBoth = () => {
        this.#join((thisJoinedParent = targetParent));
        target.#join((targetJoinedParent = thisParent));
      };
      if (!keepChildren) joinBoth();
      else severChildrenAndJoin(joinBoth);
    }

    if (this.manager) {
      if (thisPrimary) this.manager.attachPrimary(target);
      if (targetPrimary) this.manager.attachPrimary(this);
    }

    const tjp = targetJoinedParent!,
      thjp = thisJoinedParent!;
    if (
      tjp === thjp &&
      tjp &&
      tjp.absoluteOrderMode === targetParentAbsolute &&
      thjp.absoluteOrderMode === thisParentAbsolute &&
      targetParentAbsolute === thisParentAbsolute &&
      targetParentAbsolute === false
    ) {
      if (thisIndex < targetIndex) {
        target.setOrderIndex(thisIndex);
        this.setOrderIndex(targetIndex);
      } else {
        this.setOrderIndex(targetIndex);
        target.setOrderIndex(thisIndex);
      }
    } else {
      if (tjp && tjp.absoluteOrderMode === targetParentAbsolute) {
        if (targetParentAbsolute) target.setAbsoluteOrderIndex(targetIndex);
        else target.setOrderIndex(targetIndex);
      }
      if (thjp && thjp.absoluteOrderMode === thisParentAbsolute) {
        if (thisParentAbsolute) this.setAbsoluteOrderIndex(thisIndex);
        else this.setOrderIndex(thisIndex);
      }
    }
  }

  swap(target: LayerNI): void {
    this.exchange(target, true);
  }

  get visibleChildrenCount(): number {
    if (this.#visibleChildrenCount === -1) this.#checkChildrenVisibleState();
    return this.#visibleChildrenCount;
  }

  #checkChildrenVisibleState(): void {
    this.#visibleChildrenCount = 0;
    if (!this.childList.actualCount()) return;
    this.#forEachChildNoLock((child) => {
      if (child.visible && child.opacity !== 0) this.#visibleChildrenCount++;
    });
  }

  #notifyChildrenVisualStateChanged(): void {
    this.#visibleChildrenCount = -1;
    this.#exposedRegionValid = false;
    this.manager?.notifyVisualStateChanged();
  }

  getOrderIndex(): number {
    if (!this.parent) return 0;
    if (this.parent.childrenOrderIndexValid) return this.orderIndex;
    this.parent.#recreateOrderIndex();
    return this.orderIndex;
  }

  getOverallOrderIndex(): number {
    if (!this.manager) return 0;
    this.manager.recreateOverallOrderIndex();
    return this.overallOrderIndex;
  }

  #recreateOrderIndex(): void {
    let index = 0;
    this.#forEachChildNoLock((child) => {
      child.orderIndex = index++;
    });
    this.childrenOrderIndexValid = true;
  }

  get count(): number {
    return this.childList.actualCount();
  }

  setParent(parent: LayerNI | null): void {
    this.#join(parent);
  }

  setVisible(st: boolean): void {
    if (this.visible === st) return;
    if (this.isPrimary && !st) throwTjsError('TVPCannotSetPrimaryInvisible');
    if (!st) this.update();
    this.visible = st;
    if (st) this.update();
    if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
    if (this.visible) this.manager?.checkTreeFocusableState(this);
    else this.manager?.blurTree(this);
  }

  setOpacity(opa: number): void {
    if (this.opacity === opa) return;
    if (this.isPrimary && opa !== 255) throwTjsError('TVPCannotSetPrimaryInvisible');
    this.opacity = opa;
    if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
    this.update();
  }

  get isSeen(): boolean {
    return this.visible && this.opacity !== 0;
  }

  get isPrimary(): boolean {
    return !!this.manager && this.manager.primary === this;
  }

  getParentVisible(): boolean {
    let par = this.parent;
    while (par) {
      if (!par.visible) return false;
      par = par.parent;
    }
    return true;
  }

  getNodeVisible(): boolean {
    return this.getParentVisible() && this.visible;
  }

  getNeighborAbove(loop = false): LayerNI | null {
    if (!this.manager) return null;
    const index = this.getOverallOrderIndex();
    const all = this.manager.getAllNodes();
    if (all.length === 0) return null;
    if (index === 0) return loop ? all[all.length - 1]! : null;
    return all[index - 1]!;
  }

  getNeighborBelow(loop = false): LayerNI | null {
    if (!this.manager) return null;
    const index = this.getOverallOrderIndex();
    const all = this.manager.getAllNodes();
    if (all.length === 0) return null;
    if (index === all.length - 1) return loop ? all[0]! : null;
    return all[index + 1]!;
  }

  #checkZOrderMoveRule(lay: LayerNI): void {
    if (!this.parent) throwTjsError('TVPCannotMovePrimaryOrSiblingless');
    if (this.parent.childList.actualCount() <= 1)
      throwTjsError('TVPCannotMovePrimaryOrSiblingless');
    if (lay === this) throwTjsError('TVPCannotMoveNextToSelfOrNotSiblings');
    if (lay.parent !== this.parent) throwTjsError('TVPCannotMoveNextToSelfOrNotSiblings');
  }

  #childChangeOrder(from: number, to: number): void {
    if (from === to) return;
    const rects = new TvpComplexRect();
    const list = this.childList;
    list.compact();
    const fromlay = list.at(from)!;
    if (from < to) {
      for (let i = from; i < to; i++) {
        list.set(i, list.at(i + 1));
        const r = TvpRect.from(fromlay.rect);
        if (intersectRect(r, r, list.at(i)!.rect)) rects.or(r);
      }
    } else {
      for (let i = from; i > to; i--) {
        list.set(i, list.at(i - 1));
        const r = TvpRect.from(fromlay.rect);
        if (intersectRect(r, r, list.at(i)!.rect)) rects.or(r);
      }
    }
    list.set(to, fromlay);
    this.updateRegion(rects);
    this.#childrenChanged();
  }

  #childChangeAbsoluteOrder(from: number, absTo: number): void {
    let to = 0;
    const n = this.childList.count;
    for (let i = 0; i < n; i++) {
      const child = this.childList.at(i);
      if (!child) continue;
      if (child.absoluteOrderIndex >= absTo) break;
      to++;
    }
    if (from < to) to--;
    this.#childChangeOrder(from, to);
  }

  moveBefore(lay: LayerNI): void {
    this.parent?.setAbsoluteOrderMode(false);
    this.#checkZOrderMoveRule(lay);
    const thisOrder = this.getOrderIndex();
    const layOrder = lay.getOrderIndex();
    if (thisOrder < layOrder) this.parent!.#childChangeOrder(thisOrder, layOrder);
    else this.parent!.#childChangeOrder(thisOrder, layOrder + 1);
  }

  moveBehind(lay: LayerNI): void {
    this.parent?.setAbsoluteOrderMode(false);
    this.#checkZOrderMoveRule(lay);
    const thisOrder = this.getOrderIndex();
    const layOrder = lay.getOrderIndex();
    if (thisOrder < layOrder) this.parent!.#childChangeOrder(thisOrder, layOrder - 1);
    else this.parent!.#childChangeOrder(thisOrder, layOrder);
  }

  setOrderIndex(index: number): void {
    const parent = this.parent;
    if (!parent) throwTjsError('TVPCannotMovePrimaryOrSiblingless');
    parent.setAbsoluteOrderMode(false);
    if (index < 0) index = 0;
    const n = parent.childList.actualCount();
    if (index >= n) index = n - 1;
    parent.#childChangeOrder(this.getOrderIndex(), index);
    parent.#notifyChildrenVisualStateChanged();
  }

  bringToBack(): void {
    if (!this.parent) throwTjsError('TVPCannotMovePrimaryOrSiblingless');
    this.parent.setAbsoluteOrderMode(false);
    this.setOrderIndex(0);
  }

  bringToFront(): void {
    if (!this.parent) throwTjsError('TVPCannotMovePrimaryOrSiblingless');
    this.parent.setAbsoluteOrderMode(false);
    this.setOrderIndex(this.parent.childList.actualCount() - 1);
  }

  getAbsoluteOrderIndex(): number {
    if (!this.parent) return 0;
    if (this.parent.absoluteOrderMode) return this.absoluteOrderIndex;
    return this.getOrderIndex();
  }

  setAbsoluteOrderIndex(index: number): void {
    const parent = this.parent;
    if (!parent) throwTjsError('TVPCannotMovePrimaryOrSiblingless');
    parent.setAbsoluteOrderMode(true);
    parent.#childChangeAbsoluteOrder(this.getOrderIndex(), index);
    this.absoluteOrderIndex = index;
    parent.#notifyChildrenVisualStateChanged();
  }

  setAbsoluteOrderMode(b: boolean): void {
    if (this.absoluteOrderMode === b) return;
    this.absoluteOrderMode = b;
    if (b) this.#forEachChildNoLock((child) => (child.absoluteOrderIndex = child.getOrderIndex()));
  }

  /** `DumpStructure`: one log line per layer. */
  dumpStructure(level = 0): void {
    const indent = ' '.repeat(level * 2);
    const name = this.name || '<noname>';
    const r = this.rect;
    this.ctx.log.add(
      `${indent}${name} (object 0x${hex(this.owner)}) (native 0x${hex(this)}) (${r.left},${r.top})-(${r.right},${r.bottom}) (${r.width}x${r.height}) ${this.visible ? 'visible' : 'invisible'} index=${this.getAbsoluteOrderIndex()}${this.provinceImage ? ' p' : ''} ${this.typeNameString}`,
    );
    this.#forEachChildNoLock((child) => child.dumpStructure(level + 1));
  }

  // --- layer type ------------------------------------------------------------------------------

  #notifyLayerTypeChange(): void {
    this.#updateDrawFace();
    if (this.parent) this.parent.#notifyLayerTypeChange();
  }

  #updateDrawFace(): void {
    if (this.face === dfAuto) {
      switch (this.displayType) {
        case ltAlpha:
        case ltPsNormal:
        case ltPsAdditive:
        case ltPsSubtractive:
        case ltPsMultiplicative:
        case ltPsScreen:
        case ltPsOverlay:
        case ltPsHardLight:
        case ltPsSoftLight:
        case ltPsColorDodge:
        case ltPsColorDodge5:
        case ltPsColorBurn:
        case ltPsLighten:
        case ltPsDarken:
        case ltPsDifference:
        case ltPsDifference5:
        case ltPsExclusion:
          this.#drawFace = dfAlpha;
          break;
        case ltAddAlpha:
          this.#drawFace = dfAddAlpha;
          break;
        default:
          this.#drawFace = dfOpaque;
      }
    } else {
      this.#drawFace = this.face;
    }
  }

  get drawFace(): number {
    return this.#drawFace;
  }

  getOperationModeFromType(): number {
    switch (this.displayType) {
      case ltOpaque:
        return omOpaque;
      case ltAlpha:
        return omAlpha;
      case ltAdditive:
        return omAdditive;
      case ltSubtractive:
        return omSubtractive;
      case ltMultiplicative:
        return omMultiplicative;
      case ltDodge:
        return omDodge;
      case ltDarken:
        return omDarken;
      case ltLighten:
        return omLighten;
      case ltScreen:
        return omScreen;
      case ltAddAlpha:
        return omAddAlpha;
      case ltPsNormal:
        return omPsNormal;
      case ltPsAdditive:
        return omPsAdditive;
      case ltPsSubtractive:
        return omPsSubtractive;
      case ltPsMultiplicative:
        return omPsMultiplicative;
      case ltPsScreen:
        return omPsScreen;
      case ltPsOverlay:
        return omPsOverlay;
      case ltPsHardLight:
        return omPsHardLight;
      case ltPsSoftLight:
        return omPsSoftLight;
      case ltPsColorDodge:
        return omPsColorDodge;
      case ltPsColorDodge5:
        return omPsColorDodge5;
      case ltPsColorBurn:
        return omPsColorBurn;
      case ltPsLighten:
        return omPsLighten;
      case ltPsDarken:
        return omPsDarken;
      case ltPsDifference:
        return omPsDifference;
      case ltPsDifference5:
        return omPsDifference5;
      case ltPsExclusion:
        return omPsExclusion;
      default:
        return omOpaque;
    }
  }

  setType(type: number): void {
    if (this.type === type) return;
    this.type = type;
    const set = (neutral: number, display: number, canHaveImage: boolean) => {
      this.neutralColor = this.#transparentColor = neutral >>> 0;
      this.displayType = display;
      this.#canHaveImage = canHaveImage;
      if (canHaveImage) this.#allocateImage();
      else this.#deallocateImage();
    };
    const WHITE = 0x00ffffff,
      BLACK = 0x00000000,
      GRAY = 0x00808080;
    switch (type) {
      case ltBinder:
        set(WHITE, type, false);
        break;
      case ltOpaque:
      case ltAlpha:
      case ltSubtractive:
      case ltMultiplicative:
      case ltDarken:
      case ltPsSubtractive:
      case ltPsMultiplicative:
      case ltPsColorBurn:
      case ltPsDarken:
        set(WHITE, type, true);
        break;
      case ltAdditive:
      case ltDodge:
      case ltLighten:
      case ltScreen:
      case ltAddAlpha:
      case ltPsNormal:
      case ltPsAdditive:
      case ltPsScreen:
      case ltPsColorDodge:
      case ltPsColorDodge5:
      case ltPsLighten:
      case ltPsDifference:
      case ltPsDifference5:
      case ltPsExclusion:
        set(BLACK, type, true);
        break;
      case ltEffect:
      case ltFilter:
        set(WHITE, ltBinder, false);
        break;
      case ltPsOverlay:
      case ltPsHardLight:
      case ltPsSoftLight:
        set(GRAY, type, true);
        break;
    }
    this.#notifyLayerTypeChange();
    this.#exposedRegionValid = false;
    this.update();
  }

  get typeNameString(): string {
    return (
      [
        'ltBinder',
        'ltOpaque',
        'ltAlpha',
        'ltAdditive',
        'ltSubtractive',
        'ltMultiplicative',
        'ltEffect',
        'ltFilter',
        'ltDodge',
        'ltDarken',
        'ltLighten',
        'ltScreen',
        'ltAddAlpha',
        'PsNormal',
        'PsAdditive',
        'PsSubtractive',
        'PsMultiplicative',
        'PsScreen',
        'PsOverlay',
        'PsHardLight',
        'PsSoftLight',
        'PsColorDodge',
        'PsColorDodge5',
        'PsColorBurn',
        'PsLighten',
        'PsDarken',
        'PsDifference',
        'PsDifference5',
        'PsExclusion',
      ][this.type] ?? 'unknown'
    );
  }

  convertLayerType(fromtype: number): void {
    if (this.#drawFace === dfAddAlpha && fromtype === dfAlpha)
      this.mainImage?.convertAlphaToAddAlpha();
    else if (this.#drawFace === dfAlpha && fromtype === dfAddAlpha)
      this.mainImage?.convertAddAlphaToAlpha();
    else throwTjsError('TVPCannotConvertLayerTypeUsingGivenDirection');
    this.imageModified = true;
    this.update();
  }

  // --- geometry --------------------------------------------------------------------------------

  #createExposedRegion(): void {
    const exposed = this.#exposedRegion,
      overlapped = this.#overlappedRegion;
    exposed.clear();
    overlapped.clear();
    const rect = new TvpRect(0, 0, this.rect.width, this.rect.height);
    if (this.mainImage) {
      if (this.visibleChildrenCount > TVP_EXPOSED_UNITE_LIMIT) {
        exposed.or(rect);
        let first = true;
        const r2 = new TvpRect();
        this.#forEachChildNoLock((child) => {
          if (!child.isSeen) return;
          const r = TvpRect.from(child.rect);
          if (intersectRect(r, r, rect)) {
            if (first) {
              r2.assign(child.rect);
              first = false;
            } else unionRect(r2, r2, r);
          }
        });
        overlapped.or(r2);
        exposed.sub(overlapped);
      } else {
        exposed.or(rect);
        this.#forEachChildNoLock((child) => {
          if (!child.isSeen) return;
          const r = TvpRect.from(child.rect);
          if (intersectRect(r, r, rect)) overlapped.or(r);
        });
        exposed.sub(overlapped);
      }
    } else {
      overlapped.or(rect);
      if (this.visibleChildrenCount < TVP_DIRECT_UNITE_LIMIT) {
        const one = exposed;
        const two = new TvpComplexRect();
        this.#forEachChildNoLock((child) => {
          if (!child.isSeen) return;
          const r = child.rect;
          if (child.displayType === this.displayType && child.opacity === 255) {
            const oneAndR = TvpComplexRect.from(one);
            oneAndR.and(r);
            const twoAndR = TvpComplexRect.from(two);
            twoAndR.and(r);
            one.sub(oneAndR);
            two.or(oneAndR);
            two.or(twoAndR);
            const tmp = new TvpComplexRect();
            tmp.or(r);
            tmp.sub(oneAndR);
            tmp.sub(twoAndR);
            one.or(tmp);
          } else {
            two.or(r);
            one.sub(r);
          }
        });
      }
      overlapped.sub(exposed);
    }
    this.#exposedRegionValid = true;
  }

  #getExposedRegion(): TvpComplexRect {
    if (!this.#exposedRegionValid) this.#createExposedRegion();
    return this.#exposedRegion;
  }

  #getOverlappedRegion(): TvpComplexRect {
    if (!this.#exposedRegionValid) this.#createExposedRegion();
    return this.#overlappedRegion;
  }

  internalSetSize(width: number, height: number): void {
    if (this.rect.width === width && this.rect.height === height) return;
    this.update(false);
    this.rect.width = width;
    this.rect.height = height;
    if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
    this.#exposedRegionValid = false;
    this.#imageLayerSizeChanged();
    this.update(false);
    if (this.isPrimary && this.manager) this.manager.notifyLayerResize();
  }

  #internalSetBounds(rect: TvpRect): void {
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width < 0 || height < 0) throwTjsError('TVPInvalidParam');
    if (this.rect.left !== rect.left || this.rect.top !== rect.top) {
      const visible = this.visible || this.getNodeVisible();
      if (this.isPrimary && (rect.left !== 0 || rect.top !== 0))
        throwTjsError('TVPCannotMovePrimary');
      if (visible) this.#parentUpdate();
      this.rect.setOffsets(rect.left, rect.top);
      if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
      this.#exposedRegionValid = false;
      if (visible) this.#parentUpdate();
    }
    this.internalSetSize(width, height);
  }

  get left(): number {
    return this.rect.left;
  }
  get top(): number {
    return this.rect.top;
  }
  get width(): number {
    return this.rect.width >>> 0;
  }
  get height(): number {
    return this.rect.height >>> 0;
  }

  setLeft(left: number): void {
    if (this.rect.left === left) return;
    const visible = this.visible || this.getNodeVisible();
    if (this.isPrimary && left !== 0) throwTjsError('TVPCannotMovePrimary');
    if (visible) this.#parentUpdate();
    const w = this.rect.width;
    this.rect.left = left;
    this.rect.right = (w + left) | 0;
    if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
    if (visible) this.#parentUpdate();
  }

  setTop(top: number): void {
    if (this.rect.top === top) return;
    const visible = this.visible || this.getNodeVisible();
    if (this.isPrimary && top !== 0) throwTjsError('TVPCannotMovePrimary');
    if (visible) this.#parentUpdate();
    const h = this.rect.height;
    this.rect.top = top;
    this.rect.bottom = (h + top) | 0;
    if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
    if (visible) this.#parentUpdate();
  }

  setPosition(left: number, top: number): void {
    if (this.rect.left === left && this.rect.top === top) return;
    const visible = this.visible || this.getNodeVisible();
    if (this.isPrimary && (left !== 0 || top !== 0)) throwTjsError('TVPCannotMovePrimary');
    if (visible) this.#parentUpdate();
    this.rect.setOffsets(left, top);
    if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
    if (visible) this.#parentUpdate();
  }

  setWidth(width: number): void {
    if (this.rect.width === width) return;
    this.update(false);
    this.rect.width = width;
    if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
    this.#exposedRegionValid = false;
    this.#imageLayerSizeChanged();
    this.update(false);
    if (this.isPrimary && this.manager) this.manager.notifyLayerResize();
  }

  setHeight(height: number): void {
    if (this.rect.height === height) return;
    this.update(false);
    this.rect.height = height;
    if (this.parent) this.parent.#notifyChildrenVisualStateChanged();
    this.#exposedRegionValid = false;
    this.#imageLayerSizeChanged();
    this.update(false);
    if (this.isPrimary && this.manager) this.manager.notifyLayerResize();
  }

  setSize(width: number, height: number): void {
    this.internalSetSize(width, height);
  }

  setBounds(rect: TvpRect): void {
    this.#internalSetBounds(rect);
  }

  #parentRectToChildRect(rect: TvpRect): void {
    rect.left -= this.rect.left;
    rect.right -= this.rect.left;
    rect.top -= this.rect.top;
    rect.bottom -= this.rect.top;
  }

  toPrimaryCoordinates(p: {x: number; y: number}): void {
    let l: LayerNI | null = this;
    while (l && !l.isPrimary) {
      p.x += l.rect.left;
      p.y += l.rect.top;
      l = l.parent;
    }
  }

  fromPrimaryCoordinates(p: {x: number; y: number}): void {
    let l: LayerNI | null = this;
    while (l && !l.isPrimary) {
      p.x -= l.rect.left;
      p.y -= l.rect.top;
      l = l.parent;
    }
  }

  // --- image buffer management -----------------------------------------------------------------

  #changeImageSize(width: number, height: number): void {
    if (!width || !height) throwTjsError('TVPCannotCreateEmptyLayerImage');
    this.mainImage?.setSizeWithFill(width, height, this.neutralColor);
    this.provinceImage?.setSizeWithFill(width, height, 0);
    if (this.mainImage) this.resetClip();
    this.imageModified = true;
    this.#resizeCache();
  }

  #newBitmap(w: number, h: number, bpp: number): TvpBaseBitmap {
    return new TvpBaseBitmap(this.ctx.fonts, this.ctx.memory, w, h, bpp);
  }

  #allocateImage(): void {
    if (!this.mainImage) {
      this.imageLeft = 0;
      this.imageTop = 0;
      this.mainImage = this.#newBitmap(this.rect.width, this.rect.height, 32);
      this.mainImage.fill(new TvpRect(0, 0, this.rect.width, this.rect.height), this.neutralColor);
      this.mainImage.setFont(this.#font);
    }
    if (this.mainImage) this.resetClip();
    this.provinceImage?.setSizeWithFill(this.mainImage.width, this.mainImage.height, 0);
    this.#fontChanged = true;
    this.imageModified = true;
  }

  #deallocateImage(): void {
    if (this.mainImage) {
      this.mainImage.dispose();
      this.mainImage = null;
    }
    if (this.provinceImage) {
      this.provinceImage.dispose();
      this.provinceImage = null;
    }
    this.imageModified = true;
  }

  #allocateProvinceImage(): void {
    const neww = this.mainImage ? this.mainImage.width : this.rect.width;
    const newh = this.mainImage ? this.mainImage.height : this.rect.height;
    if (!this.provinceImage) {
      this.provinceImage = this.#newBitmap(neww, newh, 8);
      this.provinceImage.fill(new TvpRect(0, 0, neww, newh), 0);
    } else this.provinceImage.setSizeWithFill(neww, newh, 0);
    this.imageModified = true;
  }

  #deallocateProvinceImage(): void {
    if (this.provinceImage) {
      this.provinceImage.dispose();
      this.provinceImage = null;
    }
    this.imageModified = true;
  }

  #allocateDefaultImage(): void {
    if (!this.mainImage) this.mainImage = TvpBaseBitmap.from(this.ctx.temp.initial);
    else this.mainImage.assign(this.ctx.temp.initial);
    this.#fontChanged = true;
    this.resetClip();
    this.imageModified = true;
  }

  assignImages(src: LayerNI): void {
    let mainChanged = true;
    if (src.mainImage) {
      if (this.mainImage) mainChanged = this.mainImage.assign(src.mainImage);
      else this.mainImage = TvpBaseBitmap.from(src.mainImage);
      this.#fontChanged = true;
    } else this.#deallocateImage();
    if (src.provinceImage) {
      if (this.provinceImage) this.provinceImage.assign(src.provinceImage);
      else this.provinceImage = TvpBaseBitmap.from(src.provinceImage);
    } else this.#deallocateProvinceImage();
    if (mainChanged && this.mainImage)
      this.#internalSetImageSize(this.mainImage.width, this.mainImage.height);
    this.imageModified = true;
    if (this.mainImage) this.resetClip();
    if (mainChanged) this.update(false);
  }

  assignMainImageWithUpdate(bmp: TvpBaseBitmap | null): void {
    let mainChanged = true;
    if (bmp) {
      if (this.mainImage) mainChanged = this.mainImage.assign(bmp);
      else this.mainImage = TvpBaseBitmap.from(bmp);
      this.#fontChanged = true;
    } else this.#deallocateImage();
    if (mainChanged && this.mainImage)
      this.#internalSetImageSize(this.mainImage.width, this.mainImage.height);
    this.imageModified = true;
    if (this.mainImage) this.resetClip();
    if (mainChanged) this.update(false);
  }

  assignMainImage(bmp: TvpBaseBitmap): void {
    if (
      !this.mainImage ||
      bmp.width !== this.mainImage.width ||
      bmp.height !== this.mainImage.height
    )
      throwTjsError('TVPInternalError');
    if (this.mainImage.assign(bmp)) {
      this.imageModified = true;
      this.update(false);
    }
  }

  setHasImage(b: boolean): void {
    if (!this.#canHaveImage && b) throwTjsError('TVPLayerCannotHaveImage');
    if (b) this.#allocateImage();
    else this.#deallocateImage();
    this.#notifyChildrenVisualStateChanged();
    this.update();
  }

  get hasImage(): boolean {
    return this.mainImage !== null;
  }

  #requireImage(): TvpBaseBitmap {
    if (!this.mainImage) throwTjsError('TVPNotDrawableLayerType');
    return this.mainImage;
  }

  setImageLeft(left: number): void {
    const img = this.#requireImage();
    if (this.imageLeft === left) return;
    if (left > 0) throwTjsError('TVPInvalidImagePosition');
    if (img.width + left < this.rect.width) throwTjsError('TVPInvalidImagePosition');
    this.imageLeft = left;
    this.update();
  }

  getImageLeft(): number {
    this.#requireImage();
    return this.imageLeft;
  }

  setImageTop(top: number): void {
    const img = this.#requireImage();
    if (this.imageTop === top) return;
    if (top > 0) throwTjsError('TVPInvalidImagePosition');
    if (img.height + top < this.rect.height) throwTjsError('TVPInvalidImagePosition');
    this.imageTop = top;
    this.update();
  }

  getImageTop(): number {
    this.#requireImage();
    return this.imageTop;
  }

  setImagePosition(left: number, top: number): void {
    const img = this.#requireImage();
    if (this.imageLeft === left && this.imageTop === top) return;
    if (left > 0) throwTjsError('TVPInvalidImagePosition');
    if (top > 0) throwTjsError('TVPInvalidImagePosition');
    if (img.width + left < this.rect.width) throwTjsError('TVPInvalidImagePosition');
    if (img.height + top < this.rect.height) throwTjsError('TVPInvalidImagePosition');
    this.imageLeft = left;
    this.imageTop = top;
    this.update();
  }

  setImageWidth(width: number): void {
    const img = this.#requireImage();
    if (width === img.width) return;
    if (width < this.rect.width) {
      this.imageLeft = 0;
      this.setWidth(width);
    }
    if (width + this.imageLeft < this.rect.width) this.imageLeft = this.rect.width - width;
    this.#changeImageSize(width, img.height);
  }

  getImageWidth(): number {
    return this.#requireImage().width;
  }

  setImageHeight(height: number): void {
    const img = this.#requireImage();
    if (height === img.height) return;
    if (height < this.rect.height) {
      this.imageTop = 0;
      this.setHeight(height);
    }
    if (height + this.imageTop < this.rect.height) this.imageTop = this.rect.height - height;
    this.#changeImageSize(img.width, height);
  }

  getImageHeight(): number {
    return this.#requireImage().height;
  }

  #internalSetImageSize(width: number, height: number): void {
    if (width < this.rect.width) {
      this.imageLeft = 0;
      this.setWidth(width);
    }
    if (width + this.imageLeft < this.rect.width) this.imageLeft = this.rect.width - width;
    if (height < this.rect.height) {
      this.imageTop = 0;
      this.setHeight(height);
    }
    if (height + this.imageTop < this.rect.height) this.imageTop = this.rect.height - height;
    this.#changeImageSize(width, height);
  }

  setImageSize(width: number, height: number): void {
    const img = this.#requireImage();
    if (width === img.width && height === img.height) return;
    this.#internalSetImageSize(width, height);
  }

  #imageLayerSizeChanged(): void {
    const img = this.mainImage;
    if (!img) return;
    if (img.width < this.rect.width) this.#changeImageSize(this.rect.width, img.height);
    if (img.width + this.imageLeft < this.rect.width) {
      this.imageLeft = this.rect.width - img.width;
      this.update();
    }
    if (img.height < this.rect.height) this.#changeImageSize(img.width, this.rect.height);
    if (img.height + this.imageTop < this.rect.height) {
      this.imageTop = this.rect.height - img.height;
      this.update();
    }
  }

  independMainImage(copy = true): void {
    if (!this.mainImage) return;
    if (copy) this.mainImage.independ();
    else this.mainImage.independNoCopy();
  }

  independProvinceImage(copy = true): void {
    if (!this.provinceImage) return;
    if (copy) this.provinceImage.independ();
    else this.provinceImage.independNoCopy();
  }

  saveLayerImage(_name: string, _type: string): void {
    this.#requireImage();
    notAvailable('Layer.saveLayerImage (image encoders)');
  }

  #graphics(): TvpGraphicsLoader {
    return this.ctx.graphics ?? notAvailable('The graphics loader');
  }

  /**
   * `LoadImages`: loads the main image (and a province image the graphic names). Returns the
   * meta information (owned by the caller); a promise while the storage is read.
   */
  loadImages(name: string, colorkey: number): Dispatch | null | Promise<Dispatch | null> {
    const img = this.#requireImage();
    const loaded = this.#graphics().load(img, name, colorkey, 0, 0, glmNormal);
    const finish = (g: TvpLoadedGraphic): Dispatch | null | Promise<Dispatch | null> => {
      try {
        this.#internalSetImageSize(img.width, img.height);
        if (g.provinceName) {
          this.#allocateProvinceImage();
          const p = this.provinceImage!;
          const check = (): Dispatch | null => {
            if (p.width !== img.width || p.height !== img.height)
              throwTjsError('TVPProvinceSizeMismatch', g.provinceName);
            this.imageModified = true;
            this.resetClip();
            this.update(false);
            return g.metainfo;
          };
          const fail = (e: unknown): never => {
            this.#deallocateProvinceImage();
            throw e;
          };
          let pl: TvpLoadedGraphic | Promise<TvpLoadedGraphic>;
          try {
            pl = this.#graphics().load(p, g.provinceName, 0, img.width, img.height, glmPalettized);
          } catch (e) {
            fail(e);
          }
          if (pl! instanceof Promise)
            return pl.then(() => {
              try {
                return check();
              } catch (e) {
                return fail(e);
              }
            });
          try {
            return check();
          } catch (e) {
            return fail(e);
          }
        }
        this.#deallocateProvinceImage();
        this.imageModified = true;
        this.resetClip();
        this.update(false);
        return g.metainfo;
      } catch (e) {
        g.metainfo?.release();
        throw e;
      }
    };
    return loaded instanceof Promise ? loaded.then(finish) : finish(loaded);
  }

  /** `LoadProvinceImage`; a promise while the storage is read. */
  loadProvinceImage(name: string): void | Promise<void> {
    const img = this.#requireImage();
    this.#allocateProvinceImage();
    const p = this.provinceImage!;
    const done = () => {
      if (p.width !== img.width || p.height !== img.height)
        throwTjsError('TVPProvinceSizeMismatch', name);
      this.imageModified = true;
    };
    const fail = (e: unknown): never => {
      this.#deallocateProvinceImage();
      throw e;
    };
    let loaded: TvpLoadedGraphic | Promise<TvpLoadedGraphic>;
    try {
      loaded = this.#graphics().load(p, name, 0, img.width, img.height, glmPalettized);
    } catch (e) {
      return fail(e);
    }
    if (loaded instanceof Promise)
      return loaded.then(
        () => {
          try {
            done();
          } catch (e) {
            fail(e);
          }
        },
        (e: unknown) => fail(e),
      );
    try {
      done();
    } catch (e) {
      fail(e);
    }
  }

  getMainPixel(x: number, y: number): number {
    const img = this.#requireImage();
    return this.ctx.colors.fromActual(img.getPoint(x, y) & 0xffffff) >>> 0;
  }

  #pixelUpdate(x: number, y: number): void {
    const r = new TvpRect(this.imageLeft + x, this.imageTop + y);
    r.right = r.left + 1;
    r.bottom = r.top + 1;
    this.updateRect(r);
  }

  #outsideClip(x: number, y: number): boolean {
    const c = this.clipRect;
    return x < c.left || y < c.top || x >= c.right || y >= c.bottom;
  }

  setMainPixel(x: number, y: number, color: number): void {
    const img = this.#requireImage();
    if (this.#outsideClip(x, y)) return;
    img.setPointMain(x, y, this.ctx.colors.toActual(color));
    this.imageModified = true;
    this.#pixelUpdate(x, y);
  }

  getMaskPixel(x: number, y: number): number {
    const img = this.#requireImage();
    return (img.getPoint(x, y) & 0xff000000) >>> 24;
  }

  setMaskPixel(x: number, y: number, mask: number): void {
    const img = this.#requireImage();
    if (this.#outsideClip(x, y)) return;
    img.setPointMask(x, y, mask);
    this.imageModified = true;
    this.#pixelUpdate(x, y);
  }

  getProvincePixel(x: number, y: number): number {
    const p = this.provinceImage;
    if (!p) return 0;
    if (x < 0 || y < 0 || x >= p.width || y >= p.height) return 0;
    return p.getPoint(x, y);
  }

  setProvincePixel(x: number, y: number, n: number): void {
    if (!this.provinceImage) this.#allocateProvinceImage();
    if (this.#outsideClip(x, y)) return;
    this.provinceImage!.setPoint(x, y, n);
    this.imageModified = true;
    this.#pixelUpdate(x, y);
  }

  getMainImagePixelBuffer(): number {
    return this.mainImage ? this.mainImage.scanLine(0) : 0;
  }

  getMainImagePixelBufferForWrite(): number {
    if (!this.mainImage) return 0;
    this.imageModified = true;
    return this.mainImage.scanLineForWrite(0);
  }

  getMainImagePixelBufferPitch(): number {
    return this.mainImage ? this.mainImage.pitchBytes : 0;
  }

  getProvinceImagePixelBuffer(): number {
    return this.provinceImage ? this.provinceImage.scanLine(0) : 0;
  }

  getProvinceImagePixelBufferForWrite(): number {
    if (!this.provinceImage) this.#allocateProvinceImage();
    this.imageModified = true;
    return this.provinceImage!.scanLineForWrite(0);
  }

  getProvinceImagePixelBufferPitch(): number {
    return this.provinceImage ? this.provinceImage.pitchBytes : 0;
  }

  // --- input / hit test ------------------------------------------------------------------------

  setCursorByStorage(storage: string): void {
    this.cursor = this.ctx.getCursor(storage);
    this.manager?.notifyMouseCursorChange(this, this.#getLayerActiveCursor());
  }

  setCursorByNumber(num: number): void {
    this.cursor = num;
    this.manager?.notifyMouseCursorChange(this, this.#getLayerActiveCursor());
  }

  #getLayerActiveCursor(): number {
    let cursor = this.cursor;
    let p: LayerNI | null = this;
    while (cursor === 0) {
      p = p.parent;
      if (!p) break;
      cursor = p.cursor;
    }
    return cursor;
  }

  setCurrentCursorToWindow(): void {
    this.manager?.setMouseCursor(this.#getLayerActiveCursor());
  }

  getCursorX(): number {
    if (!this.manager) return 0;
    let {x} = this.manager.getCursorPos();
    let p: LayerNI | null = this;
    while (p && p.parent) {
      x -= p.rect.left;
      p = p.parent;
    }
    return x;
  }

  setCursorX(x: number): void {
    this.#cursorXWork = x;
  }

  getCursorY(): number {
    if (!this.manager) return 0;
    let {y} = this.manager.getCursorPos();
    let p: LayerNI | null = this;
    while (p && p.parent) {
      y -= p.rect.top;
      p = p.parent;
    }
    return y;
  }

  setCursorY(y: number): void {
    if (!this.manager) return;
    let x = this.#cursorXWork;
    let p: LayerNI | null = this;
    while (p && p.parent) {
      x += p.rect.left;
      y += p.rect.top;
      p = p.parent;
    }
    this.manager.setCursorPos(x, y);
  }

  setCursorPos(x: number, y: number): void {
    if (!this.manager) return;
    let p: LayerNI | null = this;
    while (p && p.parent) {
      x += p.rect.left;
      y += p.rect.top;
      p = p.parent;
    }
    this.manager.setCursorPos(x, y);
  }

  setCurrentHintToWindow(): void {
    if (this.ignoreHintSensing) return;
    if (!this.manager) return;
    let p: LayerNI = this;
    while (p.showParentHint) {
      if (!p.parent) break;
      p = p.parent;
    }
    this.manager.setHint(this.owner, p.hint);
  }

  setHint(hint: string): void {
    this.showParentHint = false;
    this.ignoreHintSensing = false;
    this.hint = hint;
    this.manager?.notifyHintChange(this, hint);
  }

  setAttentionLeft(l: number): void {
    this.attentionLeft = l;
    this.manager?.notifyAttentionStateChanged(this);
  }

  setAttentionTop(t: number): void {
    this.attentionTop = t;
    this.manager?.notifyAttentionStateChanged(this);
  }

  setAttentionPoint(l: number, t: number): void {
    this.attentionLeft = l;
    this.attentionTop = t;
    this.manager?.notifyAttentionStateChanged(this);
  }

  setUseAttention(b: boolean): void {
    this.useAttention = b;
    this.manager?.notifyAttentionStateChanged(this);
  }

  setImeMode(mode: number): void {
    this.imeMode = mode;
    this.manager?.notifyImeModeChanged(this);
  }

  #hitTestNoVisibleCheckRaw(x: number, y: number): boolean {
    if (this.hitType === htMask) {
      const img = this.mainImage;
      if (img) {
        const px = x - this.imageLeft,
          py = y - this.imageTop;
        if (px >= 0 && py >= 0 && px < img.width && py < img.height)
          return img.getPoint(px, py) >>> 24 >= this.hitThreshold;
        return false;
      }
      if (x >= 0 && y >= 0 && x < this.rect.width && y < this.rect.height)
        return !(0 < this.hitThreshold);
      return false;
    }
    if (this.hitType === htProvince) {
      const p = this.provinceImage;
      if (!p) return false;
      const px = x - this.imageLeft,
        py = y - this.imageTop;
      if (px >= 0 && py >= 0 && px < p.width && py < p.height) return p.getPoint(px, py) !== 0;
      return false;
    }
    return true;
  }

  hitTestNoVisibleCheck(x: number, y: number): boolean {
    let res = this.#hitTestNoVisibleCheckRaw(x, y);
    if (res) {
      if (this.owner && !this.shutdown) {
        this.#onHitTestWork = true;
        this.#postNow('onHitTest', [int(x), int(y), bool(true)]);
        res = this.#onHitTestWork;
      }
    }
    return res;
  }

  setHitTestWork(b: boolean): void {
    this.#onHitTestWork = b;
  }

  /** The internal `GetMostFrontChildAt` (the point in the parent's coordinates). */
  getMostFrontChildAtInternal(
    x: number,
    y: number,
    out: {layer: LayerNI | null},
    except: LayerNI | null,
    getDisabled: boolean,
  ): boolean {
    if (!this.visible) return false;
    x -= this.rect.left;
    y -= this.rect.top;
    if (x < 0 || y < 0 || x >= this.rect.width || y >= this.rect.height) return false;
    const ox = x,
      oy = y;
    const list = this.childList;
    list.safeLock();
    try {
      for (let i = list.safeLockedCount - 1; i >= 0; i--) {
        const child = list.safeLockedAt(i);
        if (!child) continue;
        if (child.getMostFrontChildAtInternal(x, y, out, except, getDisabled)) return true;
      }
    } finally {
      list.safeUnlock();
    }
    if (except === this) return false;
    if (this.hitTestNoVisibleCheck(ox, oy)) {
      if (!getDisabled && (!this.getNodeEnabled() || this.isDisabledByMode())) {
        out.layer = null;
        return true;
      }
      out.layer = this;
      return true;
    }
    return false;
  }

  getMostFrontChildAt(
    x: number,
    y: number,
    excludeSelf = false,
    getDisabled = false,
  ): LayerNI | null {
    if (!this.manager) return null;
    let p: LayerNI | null = this;
    while (p && p.parent) {
      x += p.rect.left;
      y += p.rect.top;
      p = p.parent;
    }
    return this.manager.getMostFrontChildAt(x, y, excludeSelf ? this : null, getDisabled);
  }

  #live(): boolean {
    return !!this.owner && !this.shutdown;
  }

  fireClick(x: number, y: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onClick', [int(x), int(y)]);
  }

  fireDoubleClick(x: number, y: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onDoubleClick', [int(x), int(y)]);
  }

  fireMouseDown(x: number, y: number, mb: number, flags: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onMouseDown', [int(x), int(y), int(mb), integer(BigInt(flags >>> 0))]);
  }

  fireMouseUp(x: number, y: number, mb: number, flags: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onMouseUp', [int(x), int(y), int(mb), integer(BigInt(flags >>> 0))]);
  }

  fireMouseMove(x: number, y: number, flags: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post(
      'onMouseMove',
      [int(x), int(y), integer(BigInt(flags >>> 0))],
      TVP_EPT_IMMEDIATE | TVP_EPT_DISCARDABLE,
    );
  }

  fireMouseEnter(): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onMouseEnter');
  }

  fireMouseLeave(): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onMouseLeave');
  }

  releaseCapture(): void {
    this.manager?.releaseCapture();
  }

  /** `FireMouseLeave` where the manager continues afterwards. */
  primaryLeaveNow(): void {
    if (this.#live()) this.#postNow('onMouseLeave');
  }

  fireTouchDown(x: number, y: number, cx: number, cy: number, id: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onTouchDown', [
      real(x),
      real(y),
      real(cx),
      real(cy),
      integer(BigInt(id >>> 0)),
    ]);
  }

  fireTouchUp(x: number, y: number, cx: number, cy: number, id: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onTouchUp', [
      real(x),
      real(y),
      real(cx),
      real(cy),
      integer(BigInt(id >>> 0)),
    ]);
  }

  fireTouchMove(x: number, y: number, cx: number, cy: number, id: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post(
      'onTouchMove',
      [real(x), real(y), real(cx), real(cy), integer(BigInt(id >>> 0))],
      TVP_EPT_IMMEDIATE | TVP_EPT_DISCARDABLE,
    );
  }

  fireTouchScaling(
    startdist: number,
    curdist: number,
    cx: number,
    cy: number,
    flag: number,
  ): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onTouchScaling', [
      real(startdist),
      real(curdist),
      real(cx),
      real(cy),
      int(flag),
    ]);
  }

  fireTouchRotate(
    startangle: number,
    curangle: number,
    dist: number,
    cx: number,
    cy: number,
    flag: number,
  ): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onTouchRotate', [
      real(startangle),
      real(curangle),
      real(dist),
      real(cx),
      real(cy),
      int(flag),
    ]);
  }

  fireMultiTouch(): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onMultiTouch');
  }

  parentFocusable(): boolean {
    let par = this.parent;
    while (par) {
      if (!par.visible || !par.enabled) return false;
      par = par.parent;
    }
    return true;
  }

  checkFocusable(): boolean {
    return this.focusable && this.visible && this.enabled;
  }

  getNodeFocusable(): boolean {
    return this.checkFocusable() && this.parentFocusable() && !this.isDisabledByMode();
  }

  setFocus(direction = true): boolean {
    return this.manager ? this.manager.setFocusTo(this, direction) : false;
  }

  get focused(): boolean {
    return !!this.manager && this.manager.focusedLayer === this;
  }

  searchFirstFocusable(ignoreChainFocusable = true): LayerNI | null {
    if (ignoreChainFocusable) {
      if (this.getNodeFocusable()) return this;
    } else if (this.getNodeFocusable() && this.joinFocusChain) return this;
    const n = this.childList.count;
    for (let i = 0; i < n; i++) {
      const child = this.childList.at(i);
      if (!child) continue;
      const lay = child.searchFirstFocusable(ignoreChainFocusable);
      if (lay) return lay;
    }
    return null;
  }

  #searchFocusable(step: (l: LayerNI) => LayerNI | null): LayerNI | null {
    const current = step(this);
    if (current === this || !current) return null;
    let p: LayerNI | null = current;
    do {
      if (p.getNodeFocusable() && p.joinFocusChain) return p;
      p = step(p);
    } while (p && p !== current);
    return null;
  }

  getPrevFocusable(): LayerNI | null {
    this.focusWork = this.#searchFocusable((l) => l.getNeighborAbove(true));
    if (this.#live() && (!this.focusWork || this.focusWork.owner))
      this.#postNow('onSearchPrevFocusable', [this.#ownerVariant(this.focusWork)]);
    return this.focusWork;
  }

  getNextFocusable(): LayerNI | null {
    this.focusWork = this.#searchFocusable((l) => l.getNeighborBelow(true));
    if (this.#live() && (!this.focusWork || this.focusWork.owner))
      this.#postNow('onSearchNextFocusable', [this.#ownerVariant(this.focusWork)]);
    return this.focusWork;
  }

  focusPrev(): LayerNI | null {
    return this.manager ? this.manager.focusPrev() : null;
  }

  focusNext(): LayerNI | null {
    return this.manager ? this.manager.focusNext() : null;
  }

  setFocusable(b: boolean): void {
    if (this.focusable === b) return;
    const before = this.getNodeFocusable();
    this.focusable = b;
    const after = this.getNodeFocusable();
    if (before !== after && !after) {
      if (this.manager && this.manager.focusedLayer === this)
        this.manager.setFocusTo(this.getNextFocusable(), true);
    }
  }

  fireBlur(prevFocused: LayerNI | null): void {
    if (!this.#live()) return;
    this.#postNow('onBlur', [this.#ownerVariant(prevFocused)]);
  }

  fireFocus(prevFocused: LayerNI | null, direction: boolean): void {
    if (!this.#live()) return;
    this.#postNow('onFocus', [this.#ownerVariant(prevFocused), bool(direction)]);
  }

  fireBeforeFocus(prevFocused: LayerNI | null, direction: boolean): LayerNI | null {
    this.focusWork = this;
    if (this.#live())
      this.#postNow('onBeforeFocus', [
        obj(this.owner, this.owner),
        this.#ownerVariant(prevFocused),
        bool(direction),
      ]);
    return this.focusWork;
  }

  setMode(): void {
    this.manager?.setModeTo(this);
  }

  removeMode(): void {
    this.manager?.removeModeFrom(this);
  }

  isDisabledByMode(): boolean {
    if (!this.manager) return false;
    const current = this.manager.getCurrentModalLayer();
    if (!current) return false;
    return !this.isAncestorOrSelf(current);
  }

  notifyNodeEnabledState(): void {
    const en = this.getNodeEnabled();
    if (this.#live() && this.enabledWork !== en)
      this.#postNow(en ? 'onNodeEnabled' : 'onNodeDisabled');
    this.#forEachChild((child) => child.notifyNodeEnabledState());
  }

  saveEnabledWork(): void {
    this.enabledWork = this.getNodeEnabled();
    this.#forEachChildNoLock((child) => child.saveEnabledWork());
  }

  setEnabled(b: boolean): void {
    if (this.enabled === b) return;
    this.manager?.saveEnabledWork();
    try {
      this.enabled = b;
      if (b) this.manager?.checkTreeFocusableState(this);
      else this.manager?.blurTree(this);
    } finally {
      this.manager?.notifyNodeEnabledState();
    }
  }

  parentEnabled(): boolean {
    let par = this.parent;
    while (par) {
      if (!par.enabled) return false;
      par = par.parent;
    }
    return true;
  }

  getNodeEnabled(): boolean {
    return this.enabled && this.parentEnabled() && !this.isDisabledByMode();
  }

  fireKeyDown(key: number, shift: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onKeyDown', [int(key), int(shift), bool(true)]);
  }

  fireKeyUp(key: number, shift: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onKeyUp', [int(key), int(shift), bool(true)]);
  }

  fireKeyPress(key: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onKeyPress', [str(key ? String.fromCharCode(key) : ''), bool(true)]);
  }

  fireMouseWheel(shift: number, delta: number, x: number, y: number): number {
    if (!this.#live()) return TJS_S_OK;
    return this.#post('onMouseWheel', [int(shift), int(delta), int(x), int(y)]);
  }

  /** `DefaultKeyDown`: the default `onKeyDown` behaviour. */
  defaultKeyDown(key: number, shift: number): number {
    const manager = this.manager;
    if (!manager) return TJS_S_OK;
    const noShift = !(shift & TVP_SS_SHIFT) && !(shift & TVP_SS_ALT) && !(shift & TVP_SS_CTRL);
    if ((key === VK_TAB || key === VK_RIGHT || key === VK_DOWN) && noShift) {
      manager.focusNext();
    } else if (
      (key === VK_TAB && shift & TVP_SS_SHIFT && !(shift & TVP_SS_ALT) && !(shift & TVP_SS_CTRL)) ||
      key === VK_LEFT ||
      key === VK_UP
    ) {
      manager.focusPrev();
    } else if ((key === VK_RETURN || key === VK_ESCAPE) && noShift) {
      if (this.parent && this.parent.getNodeEnabled()) return this.parent.fireKeyDown(key, shift);
    }
    return TJS_S_OK;
  }

  defaultKeyUp(key: number, shift: number): number {
    if (!this.manager) return TJS_S_OK;
    const noShift = !(shift & TVP_SS_SHIFT) && !(shift & TVP_SS_ALT) && !(shift & TVP_SS_CTRL);
    if ((key === VK_RETURN || key === VK_ESCAPE) && noShift) {
      if (this.parent && this.parent.getNodeEnabled()) return this.parent.fireKeyUp(key, shift);
    }
    return TJS_S_OK;
  }

  defaultKeyPress(key: number): number {
    if (!this.manager) return TJS_S_OK;
    if (key === 13 || key === 0x1b) {
      if (this.parent && this.parent.getNodeEnabled()) return this.parent.fireKeyPress(key);
    }
    return TJS_S_OK;
  }

  // --- cache -----------------------------------------------------------------------------------

  #allocateCache(): void {
    if (!this.#cacheBitmap)
      this.#cacheBitmap = this.#newBitmap(this.rect.width, this.rect.height, 32);
    else this.#cacheBitmap.setSize(this.rect.width, this.rect.height);
    this.#cacheRecalcRegion.or(new TvpRect(0, 0, this.rect.width, this.rect.height));
  }

  #resizeCache(): void {
    if (this.#cacheBitmap && this.mainImage)
      this.#cacheBitmap.setSize(this.mainImage.width, this.mainImage.height);
    this.#cacheRecalcRegion.or(new TvpRect(0, 0, this.rect.width, this.rect.height));
  }

  #deallocateCache(): void {
    if (this.#cacheBitmap) {
      this.#cacheBitmap.dispose();
      this.#cacheBitmap = null;
    }
  }

  #compactCache(): void {
    if (!this.#cacheEnabledCount) this.#deallocateCache();
  }

  get cacheEnabled(): boolean {
    return this.#cacheEnabledCount !== 0;
  }

  incCacheEnabledCount(): number {
    this.#cacheEnabledCount++;
    if (this.#cacheEnabledCount) {
      this.#registerCompactEventHook();
      this.#allocateCache();
    }
    return this.#cacheEnabledCount;
  }

  decCacheEnabledCount(): number {
    this.#cacheEnabledCount--;
    if (this.ctx.freeUnusedLayerCache && !this.#cacheEnabledCount) this.#deallocateCache();
    return this.#cacheEnabledCount;
  }

  setCached(b: boolean): void {
    if (b === this.cached) return;
    this.cached = b;
    if (b) this.incCacheEnabledCount();
    else this.decCacheEnabledCount();
  }

  // --- drawing ---------------------------------------------------------------------------------

  setFace(f: number): void {
    this.face = f;
    this.#updateDrawFace();
  }

  resetClip(): void {
    const img = this.#requireImage();
    this.clipRect.set(0, 0, img.width, img.height);
  }

  setClip(left: number, top: number, width: number, height: number): void {
    const img = this.#requireImage();
    const c = this.clipRect;
    c.left = left < 0 ? 0 : left;
    c.top = top < 0 ? 0 : top;
    const right = (width + left) | 0,
      bottom = (height + top) | 0;
    c.right = img.width < right ? img.width : right;
    c.bottom = img.height < bottom ? img.height : bottom;
    if (c.right < c.left) c.right = c.left;
    if (c.bottom < c.top) c.bottom = c.top;
  }

  setClipLeft(left: number): void {
    this.setClip(left, this.clipRect.top, this.clipRect.width, this.clipRect.height);
  }
  setClipTop(top: number): void {
    this.setClip(this.clipRect.left, top, this.clipRect.width, this.clipRect.height);
  }
  setClipWidth(width: number): void {
    this.setClip(this.clipRect.left, this.clipRect.top, width, this.clipRect.height);
  }
  setClipHeight(height: number): void {
    this.setClip(this.clipRect.left, this.clipRect.top, this.clipRect.width, height);
  }

  /** `ClipDestPointAndSrcRect`: returns the clipped point and source rectangle, or null. */
  #clipDestPointAndSrcRect(
    dx: number,
    dy: number,
    srcrect: TvpRect,
  ): {dx: number; dy: number; src: TvpRect} | null {
    const out = TvpRect.from(srcrect);
    const c = this.clipRect;
    const dr = dx + srcrect.right - srcrect.left;
    const db = dy + srcrect.bottom - srcrect.top;
    if (dx < c.left) {
      out.left += c.left - dx;
      dx = c.left;
    }
    if (dr > c.right) out.right -= dr - c.right;
    if (out.right <= out.left) return null;
    if (dy < c.top) {
      out.top += c.top - dy;
      dy = c.top;
    }
    if (db > c.bottom) out.bottom -= db - c.bottom;
    if (out.bottom <= out.top) return null;
    return {dx, dy, src: out};
  }

  /** `GetBltMethodFromOperationModeAndDrawFace`, or null when the combination is unknown. */
  #bltMethodFor(mode: number): BltMethod | null {
    switch (mode) {
      case omPsNormal:
        return BltMethod.bmPsNormal;
      case omPsAdditive:
        return BltMethod.bmPsAdditive;
      case omPsSubtractive:
        return BltMethod.bmPsSubtractive;
      case omPsMultiplicative:
        return BltMethod.bmPsMultiplicative;
      case omPsScreen:
        return BltMethod.bmPsScreen;
      case omPsOverlay:
        return BltMethod.bmPsOverlay;
      case omPsHardLight:
        return BltMethod.bmPsHardLight;
      case omPsSoftLight:
        return BltMethod.bmPsSoftLight;
      case omPsColorDodge:
        return BltMethod.bmPsColorDodge;
      case omPsColorDodge5:
        return BltMethod.bmPsColorDodge5;
      case omPsColorBurn:
        return BltMethod.bmPsColorBurn;
      case omPsLighten:
        return BltMethod.bmPsLighten;
      case omPsDarken:
        return BltMethod.bmPsDarken;
      case omPsDifference:
        return BltMethod.bmPsDifference;
      case omPsDifference5:
        return BltMethod.bmPsDifference5;
      case omPsExclusion:
        return BltMethod.bmPsExclusion;
      case omAdditive:
        return BltMethod.bmAdd;
      case omSubtractive:
        return BltMethod.bmSub;
      case omMultiplicative:
        return BltMethod.bmMul;
      case omDodge:
        return BltMethod.bmDodge;
      case omDarken:
        return BltMethod.bmDarken;
      case omLighten:
        return BltMethod.bmLighten;
      case omScreen:
        return BltMethod.bmScreen;
      case omAlpha:
        if (this.#drawFace === dfAlpha) return BltMethod.bmAlphaOnAlpha;
        if (this.#drawFace === dfAddAlpha) return BltMethod.bmAlphaOnAddAlpha;
        if (this.#drawFace === dfOpaque) return BltMethod.bmAlpha;
        return null;
      case omAddAlpha:
        if (this.#drawFace === dfAlpha) return BltMethod.bmAddAlphaOnAlpha;
        if (this.#drawFace === dfAddAlpha) return BltMethod.bmAddAlphaOnAddAlpha;
        if (this.#drawFace === dfOpaque) return BltMethod.bmAddAlpha;
        return null;
      case omOpaque:
        if (this.#drawFace === dfAlpha) return BltMethod.bmCopyOnAlpha;
        if (this.#drawFace === dfAddAlpha) return BltMethod.bmCopyOnAddAlpha;
        if (this.#drawFace === dfOpaque) return BltMethod.bmCopy;
        return null;
    }
    return null;
  }

  /** Update of a rectangle in image coordinates. */
  #imageUpdate(r: TvpRect): void {
    if (this.imageLeft !== 0 || this.imageTop !== 0) {
      const ur = TvpRect.from(r);
      ur.addOffsets(this.imageLeft, this.imageTop);
      this.updateRect(ur);
    } else this.updateRect(r);
  }

  #fillProvince(destrect: TvpRect, color: number): void {
    color &= 0xff;
    if (color) {
      if (!this.provinceImage) this.#allocateProvinceImage();
      if (this.provinceImage)
        this.imageModified = this.provinceImage.fill(destrect, color) || this.imageModified;
    } else if (this.provinceImage) {
      const p = this.provinceImage;
      if (
        destrect.left === 0 &&
        destrect.top === 0 &&
        destrect.right === p.width &&
        destrect.bottom === p.height
      ) {
        this.#deallocateProvinceImage();
        this.imageModified = true;
      } else this.imageModified = p.fill(destrect, color) || this.imageModified;
    }
  }

  fillRect(rect: TvpRect, color: number): void {
    const destrect = new TvpRect();
    if (!intersectRect(destrect, rect, this.clipRect)) return;
    const df = this.#drawFace;
    const colors = this.ctx.colors;
    if (df === dfAlpha || df === dfAddAlpha || (df === dfOpaque && !this.holdAlpha)) {
      const img = this.#requireImage();
      color = ((color & 0xff000000) + (colors.toActual(color & 0xffffff) & 0xffffff)) >>> 0;
      this.imageModified = img.fill(destrect, color) || this.imageModified;
    } else if (df === dfOpaque) {
      const img = this.#requireImage();
      this.imageModified =
        img.fillColor(destrect, colors.toActual(color), 255) || this.imageModified;
    } else if (df === dfMask) {
      const img = this.#requireImage();
      this.imageModified = img.fillMask(destrect, color & 0xff) || this.imageModified;
    } else if (df === dfProvince) {
      this.#fillProvince(destrect, color);
    }
    this.#imageUpdate(destrect);
  }

  colorRect(rect: TvpRect, color: number, opa: number): void {
    const destrect = new TvpRect();
    if (!intersectRect(destrect, rect, this.clipRect)) return;
    const colors = this.ctx.colors;
    switch (this.#drawFace) {
      case dfAlpha: {
        const img = this.#requireImage();
        if (opa > 0)
          this.imageModified =
            img.fillColorOnAlpha(destrect, colors.toActual(color), opa) || this.imageModified;
        else this.imageModified = img.removeConstOpacity(destrect, -opa) || this.imageModified;
        break;
      }
      case dfAddAlpha: {
        const img = this.#requireImage();
        if (opa >= 0)
          this.imageModified =
            img.fillColorOnAddAlpha(destrect, colors.toActual(color), opa) || this.imageModified;
        else throwTjsError('TVPNegativeOpacityNotSupportedOnThisFace');
        break;
      }
      case dfOpaque: {
        const img = this.#requireImage();
        this.imageModified =
          img.fillColor(destrect, colors.toActual(color), opa) || this.imageModified;
        break;
      }
      case dfMask: {
        const img = this.#requireImage();
        this.imageModified = img.fillMask(destrect, color & 0xff) || this.imageModified;
        break;
      }
      case dfProvince:
        this.#fillProvince(destrect, color);
        break;
    }
    this.#imageUpdate(destrect);
  }

  #textBltMethod(opa: number, what: string): BltMethod {
    switch (this.#drawFace) {
      case dfAlpha:
        return BltMethod.bmAlphaOnAlpha;
      case dfAddAlpha:
        if (opa < 0) throwTjsError('TVPNegativeOpacityNotSupportedOnThisFace');
        return BltMethod.bmAlphaOnAddAlpha;
      case dfOpaque:
        return BltMethod.bmAlpha;
      default:
        throwTjsError('TVPNotDrawableFaceType', what);
    }
  }

  drawText(
    x: number,
    y: number,
    text: string,
    color: number,
    opa: number,
    aa: boolean,
    shadowlevel: number,
    shadowcolor: number,
    shadowwidth: number,
    shadowofsx: number,
    shadowofsy: number,
  ): void {
    const img = this.#requireImage();
    const met = this.#textBltMethod(opa, 'drawText');
    this.#applyFont();
    const r = new TvpComplexRect();
    img.drawText(
      this.clipRect,
      x,
      y,
      text,
      this.ctx.colors.toActual(color),
      met,
      opa,
      this.holdAlpha,
      aa,
      shadowlevel,
      shadowcolor,
      shadowwidth,
      shadowofsx,
      shadowofsy,
      r,
    );
    if (r.count) this.imageModified = true;
    if (this.imageLeft !== 0 || this.imageTop !== 0) r.addOffsets(this.imageLeft, this.imageTop);
    this.updateRegion(r);
  }

  drawGlyph(): void {
    this.#requireImage();
    notAvailable('Layer.drawGlyph (glyph rendering)');
  }

  piledCopy(dx: number, dy: number, src: LayerNI, srcrect: TvpRect): void {
    const img = this.#requireImage();
    if (!src.mainImage) throwTjsError('TVPSourceLayerHasNoImage');
    const c = this.#clipDestPointAndSrcRect(dx, dy, srcrect);
    if (!c) return;
    src.incCacheEnabledCount();
    try {
      const bmp = src.complete(c.src)!;
      this.imageModified =
        img.copyRect(c.dx, c.dy, bmp, c.src, TVP_BB_COPY_MAIN | TVP_BB_COPY_MASK) ||
        this.imageModified;
    } finally {
      src.decCacheEnabledCount();
    }
    const ur = TvpRect.from(c.src);
    ur.setOffsets(c.dx, c.dy);
    this.#imageUpdate(ur);
  }

  copyRect(
    dx: number,
    dy: number,
    src: TvpBaseBitmap | null,
    provinceSrc: TvpBaseBitmap | null,
    srcrect: TvpRect,
  ): void {
    const c = this.#clipDestPointAndSrcRect(dx, dy, srcrect);
    if (!c) return;
    const need = (): [TvpBaseBitmap, TvpBaseBitmap] => {
      const img = this.#requireImage();
      if (!src) throwTjsError('TVPSourceLayerHasNoImage');
      return [img, src];
    };
    switch (this.#drawFace) {
      case dfAlpha:
      case dfAddAlpha: {
        const [img, s] = need();
        this.imageModified =
          img.copyRect(c.dx, c.dy, s, c.src, TVP_BB_COPY_MAIN | TVP_BB_COPY_MASK) ||
          this.imageModified;
        break;
      }
      case dfOpaque: {
        const [img, s] = need();
        this.imageModified =
          img.copyRect(
            c.dx,
            c.dy,
            s,
            c.src,
            this.holdAlpha ? TVP_BB_COPY_MAIN : TVP_BB_COPY_MAIN | TVP_BB_COPY_MASK,
          ) || this.imageModified;
        break;
      }
      case dfMask: {
        const [img, s] = need();
        this.imageModified =
          img.copyRect(c.dx, c.dy, s, c.src, TVP_BB_COPY_MASK) || this.imageModified;
        break;
      }
      case dfProvince:
        if (!provinceSrc) {
          this.provinceImage?.fill(c.src, 0);
          this.imageModified = true;
        } else {
          if (!this.provinceImage) this.#allocateProvinceImage();
          this.imageModified =
            this.provinceImage!.copyRect(c.dx, c.dy, provinceSrc, c.src) || this.imageModified;
        }
        break;
    }
    const ur = TvpRect.from(c.src);
    ur.setOffsets(c.dx, c.dy);
    this.#imageUpdate(ur);
  }

  stretchCopy(): void {
    notAvailable('Layer.stretchCopy (stretch kernels)');
  }

  affineCopy(): void {
    notAvailable('Layer.affineCopy (affine kernels)');
  }

  operateRect(
    dx: number,
    dy: number,
    src: TvpBaseBitmap,
    srcrect: TvpRect,
    mode: number,
    opacity: number,
  ): void {
    const c = this.#clipDestPointAndSrcRect(dx, dy, srcrect);
    if (!c) return;
    if (mode === omAuto) throwTjsError('TVPCannotAcceptModeAuto');
    const met = this.#bltMethodFor(mode);
    if (met === null) throwTjsError('TVPNotDrawableFaceType', 'operateRect');
    const img = this.#requireImage();
    this.imageModified =
      img.blt(c.dx, c.dy, src, c.src, met, opacity, this.holdAlpha) || this.imageModified;
    const ur = TvpRect.from(c.src);
    ur.setOffsets(c.dx, c.dy);
    this.#imageUpdate(ur);
  }

  operateStretch(): void {
    notAvailable('Layer.operateStretch (stretch kernels)');
  }

  operateAffine(): void {
    notAvailable('Layer.operateAffine (affine kernels)');
  }

  doBoxBlur(): void {
    notAvailable('Layer.doBoxBlur (box blur kernels)');
  }

  adjustGamma(_data: GammaAdjustData): void {
    notAvailable('Layer.adjustGamma (gamma kernels)');
  }

  doGrayScale(): void {
    const img = this.#requireImage();
    img.doGrayScale(this.clipRect);
    this.imageModified = true;
    this.update();
  }

  lrFlip(): void {
    const img = this.#requireImage();
    const r = new TvpRect(0, 0, img.width, img.height);
    img.lrFlip(r);
    this.provinceImage?.lrFlip(r);
    this.imageModified = true;
    this.update();
  }

  udFlip(): void {
    const img = this.#requireImage();
    const r = new TvpRect(0, 0, img.width, img.height);
    img.udFlip(r);
    this.provinceImage?.udFlip(r);
    this.imageModified = true;
    this.update();
  }

  // --- font ------------------------------------------------------------------------------------

  #applyFont(): void {
    if (this.#fontChanged && this.mainImage) {
      this.#fontChanged = false;
      this.mainImage.setFont(this.#font);
    }
  }

  /** `GetMainImage`: applies the font first. */
  getMainImage(): TvpBaseBitmap | null {
    this.#applyFont();
    return this.mainImage;
  }

  getProvinceImage(): TvpBaseBitmap | null {
    this.#applyFont();
    return this.provinceImage;
  }

  get font(): TvpFont {
    return this.#font;
  }

  setFontFace(face: string): void {
    if (this.#font.face !== face) {
      this.#font.face = face;
      this.#fontChanged = true;
    }
  }

  setFontHeight(height: number): void {
    if (height < 0) height = -height;
    if (this.#font.height !== height) {
      this.#font.height = height;
      this.#fontChanged = true;
    }
  }

  setFontAngle(angle: number): void {
    if (this.#font.angle !== angle) {
      angle %= 3600;
      if (angle < 0) angle += 3600;
      this.#font.angle = angle;
      this.#fontChanged = true;
    }
  }

  #setFontFlag(flag: number, b: boolean): void {
    if (((this.#font.flags & flag) !== 0) !== b) {
      this.#font.flags &= ~flag;
      if (b) this.#font.flags |= flag;
      this.#fontChanged = true;
    }
  }

  setFontBold(b: boolean): void {
    this.#setFontFlag(TVP_TF_BOLD, b);
  }
  setFontItalic(b: boolean): void {
    this.#setFontFlag(TVP_TF_ITALIC, b);
  }
  setFontStrikeout(b: boolean): void {
    this.#setFontFlag(TVP_TF_STRIKEOUT, b);
  }
  setFontUnderline(b: boolean): void {
    this.#setFontFlag(TVP_TF_UNDERLINE, b);
  }
  setFontFaceIsFileName(b: boolean): void {
    this.#setFontFlag(TVP_TF_FONTFILE, b);
  }

  #textImage(what: string): TvpBaseBitmap {
    if (!this.mainImage) throwTjsError('TVPUnsupportedLayerType', what);
    this.#applyFont();
    return this.mainImage;
  }

  getTextWidth(text: string): number {
    return this.#textImage('getTextWidth').getTextWidth(text);
  }
  getTextHeight(text: string): number {
    return this.#textImage('getTextHeight').getTextHeight(text);
  }
  getEscWidthX(text: string): number {
    return this.#textImage('getEscWidthX').getEscWidthX(text);
  }
  getEscWidthY(text: string): number {
    return this.#textImage('getEscWidthY').getEscWidthY(text);
  }
  getEscHeightX(text: string): number {
    return this.#textImage('getEscHeightX').getEscHeightX(text);
  }
  getEscHeightY(text: string): number {
    return this.#textImage('getEscHeightY').getEscHeightY(text);
  }
  getFontGlyphDrawRect(text: string, area: TvpRect): void {
    this.#textImage('getGlyphDrawRect').getFontGlyphDrawRect(text, area);
  }
  getFontList(flags: number): string[] {
    this.#applyFont();
    return this.mainImage!.getFontList(flags);
  }

  /** `GetFontObjectNoAddRef`. */
  getFontObject(): Dispatch {
    if (this.#fontObject) return this.#fontObject;
    if (!this.owner) throwTjsError('TVPLayerObjectIsNotProperlyConstructed');
    this.#fontObject = this.ctx.createFontObject(this.owner);
    return this.#fontObject;
  }

  // --- updating --------------------------------------------------------------------------------

  #updateTransDestinationOnSelfUpdate(region: TvpComplexRect | TvpRect): void {
    const d = this.#transDest;
    if (d && d.inTransition && d.#transSelfUpdate) {
      if (d.#transUpdateType === tutDivisibleFade) {
        if (region instanceof TvpComplexRect) d.updateRegion(TvpComplexRect.from(region), true);
        else d.updateRect(region, true);
      } else d.update(true);
    }
  }

  #updateChildRegion(
    child: LayerNI,
    region: TvpComplexRect,
    tempupdate: boolean,
    targvisible: boolean,
    addtoprimary: boolean,
  ): void {
    const cr = new TvpRect(0, 0, this.rect.width, this.rect.height);
    const converted = new TvpComplexRect();
    converted.copyWithOffsets(region, cr, child.rect.left, child.rect.top);
    if (!tempupdate && this.cacheEnabled && targvisible) {
      this.#cacheRecalcRegion.or(converted);
      if (this.#cacheRecalcRegion.count > TVP_CACHE_UNITE_LIMIT) this.#cacheRecalcRegion.unite();
    }
    if (this.parent)
      this.parent.#updateChildRegion(this, converted, tempupdate, targvisible, addtoprimary);
    else if (addtoprimary) this.manager?.addUpdateRegion(converted);
    this.#updateTransDestinationOnSelfUpdate(converted);
  }

  #internalUpdate(rect: TvpRect, tempupdate = false): void {
    const cr = new TvpRect(0, 0, this.rect.width, this.rect.height);
    if (!intersectRect(cr, cr, rect)) return;
    if (!tempupdate && this.cacheEnabled) {
      this.#cacheRecalcRegion.or(cr);
      if (this.#cacheRecalcRegion.count > TVP_CACHE_UNITE_LIMIT) this.#cacheRecalcRegion.unite();
    }
    if (this.parent) {
      const c = new TvpComplexRect();
      c.or(cr);
      this.parent.#updateChildRegion(this, c, tempupdate, this.visible, this.getNodeVisible());
    } else this.manager?.addUpdateRegion(cr);
    this.#updateTransDestinationOnSelfUpdate(cr);
  }

  /** `Update(tTVPComplexRect &, bool)`: `rects` is clipped in place. */
  updateRegion(rects: TvpComplexRect, tempupdate = false): void {
    rects.and(new TvpRect(0, 0, this.rect.width, this.rect.height));
    if (!rects.count) return;
    if (!tempupdate && this.cacheEnabled) {
      this.#cacheRecalcRegion.or(rects);
      if (this.#cacheRecalcRegion.count > TVP_CACHE_UNITE_LIMIT) this.#cacheRecalcRegion.unite();
    }
    if (this.parent)
      this.parent.#updateChildRegion(this, rects, tempupdate, this.visible, this.getNodeVisible());
    else this.manager?.addUpdateRegion(rects);
    this.#updateTransDestinationOnSelfUpdate(rects);
  }

  /** `Update(const tTVPRect &, bool)`. */
  updateRect(rect: TvpRect, tempupdate = false): void {
    const cr = new TvpRect(0, 0, this.rect.width, this.rect.height);
    if (!intersectRect(cr, cr, rect)) return;
    this.#internalUpdate(cr, tempupdate);
  }

  /** `Update(bool)`: the whole layer. */
  update(tempupdate = false): void {
    this.#internalUpdate(new TvpRect(0, 0, this.rect.width, this.rect.height), tempupdate);
  }

  updateAllChildren(tempupdate = false): void {
    this.#forEachChild((child) => child.update(tempupdate));
  }

  updateByScript(rect?: TvpRect): void {
    this.callOnPaint = true;
    if (rect) this.updateRect(rect);
    else this.update();
  }

  #parentUpdate(): void {
    if (!this.parent) return;
    const c = new TvpComplexRect();
    c.or(new TvpRect(0, 0, this.rect.width, this.rect.height));
    this.parent.#updateChildRegion(this, c, false, this.visible, this.getNodeVisible());
  }

  #beforeCompletion(): void {
    if (this.#inCompletion) return;
    if (this.callOnPaint) {
      this.callOnPaint = false;
      this.#postNow('onPaint');
    }
    if (this.inTransition) {
      if (this.#divisibleTransHandler) {
        if (this.#transSelfUpdate) this.#transTick = this.#getTransTick();
        const er = this.#divisibleTransHandler.startProcess(this.#transTick);
        if (er !== TJS_S_TRUE) this.#stopTransitionByHandler();
      }
    }
    if (this.inTransition && this.#transWithChildren && this.#transUpdateType === tutDivisible) {
      this.inTransition = false;
      this.#transDrawable.src1Bmp = this.complete();
      this.inTransition = true;
      if (this.#transSrc) this.#transDrawable.src2Bmp = this.#transSrc.complete();
    }
    this.#forEachChild((child) => child.#beforeCompletion());
  }

  #afterCompletion(): void {
    if (this.#inCompletion) return;
    if (this.inTransition && this.#divisibleTransHandler) {
      const er = this.#divisibleTransHandler.endProcess();
      if (er !== TJS_S_TRUE) this.#stopTransitionByHandler();
    }
    this.#forEachChild((child) => child.#afterCompletion());
  }

  /** `QueryUpdateExcludeRect`: completely opaque areas need not be drawn behind. */
  queryUpdateExcludeRect(rect: TvpRect, parentvisible: boolean): void {
    rect.left -= this.rect.left;
    rect.right -= this.rect.left;
    rect.top -= this.rect.top;
    rect.bottom -= this.rect.top;
    const dt = this.displayType;
    parentvisible =
      parentvisible &&
      this.visible &&
      (dt === ltOpaque || dt === ltAlpha || dt === ltAddAlpha || dt === ltPsNormal) &&
      this.opacity === 255;
    for (let i = this.childList.count - 1; i >= 0; i--) {
      const child = this.childList.at(i);
      if (child) child.queryUpdateExcludeRect(rect, parentvisible);
    }
    if (parentvisible) this.updateExcludeRect.assign(rect);
    else this.updateExcludeRect.clear();
    rect.left += this.rect.left;
    rect.right += this.rect.left;
    rect.top += this.rect.top;
    rect.bottom += this.rect.top;
    if (parentvisible && dt === ltOpaque && this.opacity === 255) {
      if (rect.isEmpty()) rect.assign(this.rect);
      else if (!intersectRect(rect, rect, this.rect)) rect.clear();
    }
  }

  /** `BltImage`: draws `src` onto `dest` as a layer of `drawtype` over one of `destlayertype`. */
  static bltImage(
    dest: TvpBaseBitmap,
    destlayertype: number,
    destx: number,
    desty: number,
    src: TvpBaseBitmap,
    srcrect: TvpRect,
    drawtype: number,
    opacity: number,
  ): void {
    let hda = false;
    let met: BltMethod;
    const alphaDest = isTypeUsingAlpha(destlayertype);
    const addAlphaDest = isTypeUsingAddAlpha(destlayertype);
    const channel = isTypeUsingAlphaChannel(destlayertype);
    switch (drawtype) {
      case ltBinder:
        return;
      case ltOpaque:
        met = alphaDest
          ? BltMethod.bmCopyOnAlpha
          : addAlphaDest
            ? BltMethod.bmCopyOnAddAlpha
            : BltMethod.bmCopy;
        break;
      case ltAlpha:
        met = alphaDest
          ? BltMethod.bmAlphaOnAlpha
          : addAlphaDest
            ? BltMethod.bmAlphaOnAddAlpha
            : BltMethod.bmAlpha;
        break;
      case ltAddAlpha:
        met = alphaDest
          ? BltMethod.bmAddAlphaOnAlpha
          : addAlphaDest
            ? BltMethod.bmAddAlphaOnAddAlpha
            : BltMethod.bmAddAlpha;
        break;
      default: {
        const m = DRAWTYPE_BLT[drawtype];
        if (m === undefined) return;
        hda = channel;
        met = m;
      }
    }
    dest.blt(destx, desty, src, srcrect, met, opacity, hda);
  }

  #drawSelf(target: TvpDrawable, pr: TvpRect, cr: TvpRect): void {
    const temp = this.ctx.temp;
    if (!this.mainImage) {
      if (this.displayType === ltOpaque) {
        const t = temp.getTemp(cr.width, cr.height);
        try {
          const bitmaprect = TvpRect.from(cr);
          bitmaprect.setOffsets(0, 0);
          this.#copySelf(t, 0, 0, bitmaprect);
          target.drawCompleted(pr, t, bitmaprect, this.displayType, this.opacity);
        } finally {
          temp.freeTemp();
        }
      }
      return;
    }
    cr.addOffsets(-this.imageLeft, -this.imageTop);
    if (this.inTransition && !this.#transWithChildren && this.#divisibleTransHandler) {
      const t = temp.getTemp(cr.width, cr.height);
      try {
        const bitmaprect = TvpRect.from(cr);
        bitmaprect.setOffsets(0, 0);
        this.#doDivisibleTransition(t, 0, 0, cr);
        target.drawCompleted(pr, t, bitmaprect, this.displayType, this.opacity);
      } finally {
        temp.freeTemp();
      }
    } else {
      target.drawCompleted(pr, this.mainImage, cr, this.displayType, this.opacity);
    }
  }

  #copySelfForRect(dest: TvpBaseBitmap, destx: number, desty: number, srcrect: TvpRect): void {
    const cr = TvpRect.from(srcrect);
    cr.addOffsets(-this.imageLeft, -this.imageTop);
    if (this.inTransition && !this.#transWithChildren && this.#divisibleTransHandler) {
      this.#doDivisibleTransition(dest, destx, desty, cr);
    } else if (this.mainImage) {
      dest.copyRect(destx, desty, this.mainImage, cr);
    } else {
      dest.fill(
        new TvpRect(destx, desty, destx + cr.width, desty + cr.height),
        this.displayType === ltOpaque ? this.neutralColor : this.#transparentColor,
      );
    }
  }

  #copySelf(dest: TvpBaseBitmap, destx: number, desty: number, r: TvpRect): void {
    const uer = this.updateExcludeRect;
    if (uer.isEmpty()) {
      this.#copySelfForRect(dest, destx, desty, r);
      return;
    }
    if (uer.top <= r.top && uer.bottom >= r.bottom) {
      if (uer.left > r.left && uer.right < r.right) {
        const r2 = TvpRect.from(r);
        r2.right = uer.left;
        this.#copySelfForRect(dest, destx, desty, r2);
        r2.right = r.right;
        r2.left = uer.right;
        this.#copySelfForRect(dest, destx + (r2.left - r.left), desty, r2);
      } else if (r.left >= uer.left && r.right <= uer.right) {
        // nothing to do
      } else if (r.right <= uer.left || r.left >= uer.right) {
        this.#copySelfForRect(dest, destx, desty, r);
      } else if (r.right > uer.left && r.right <= uer.right) {
        const r2 = TvpRect.from(r);
        r2.right = uer.left;
        this.#copySelfForRect(dest, destx, desty, r2);
      } else if (r.left >= uer.left && r.left < uer.left) {
        // Never true (`r.left < uer.left` after `r.left >= uer.left`), as natively.
        const r2 = TvpRect.from(r);
        r2.left = uer.right;
        this.#copySelfForRect(dest, destx + (r2.left - r.left), desty, r2);
      } else {
        this.#copySelfForRect(dest, destx, desty, r);
      }
    } else {
      this.#copySelfForRect(dest, destx, desty, r);
    }
  }

  /** `Draw`: draws `r` (in the parent's coordinates) of this layer to `target`. */
  draw(target: TvpDrawable, r: TvpRect, visiblecheck = true): void {
    if (visiblecheck && !this.isSeen) return;
    const rect = TvpRect.from(r);
    if (!intersectRect(rect, rect, this.rect)) return;
    this.#currentDrawTarget = target;
    this.#parentRectToChildRect(rect);
    if (this.inTransition && this.#transWithChildren) {
      this.#transDrawable.init(target);
      target = this.#transDrawable;
    }
    this.#directTransferToParent = false;
    const totalopaque = this.displayType === ltOpaque && this.opacity === 255;
    const temp = this.ctx.temp;
    if (
      this.cacheEnabled &&
      !(this.inTransition && !this.#transWithChildren && this.#divisibleTransHandler)
    ) {
      for (const it of this.#cacheRecalcRegion.rects()) {
        const cr = TvpRect.from(it);
        if (!intersectRect(cr, cr, rect)) continue;
        this.#drawnRegion.clear();
        this.#updateBitmapForChild = this.#cacheBitmap;
        if (this.mainImage) this.#copySelf(this.#updateBitmapForChild!, cr.left, cr.top, cr);
        this.#forEachChild((child) => {
          if (!intersectRect(this.#updateRectForChild, cr, child.rect)) return;
          this.#updateOfsX = 0;
          this.#updateOfsY = 0;
          this.#updateRectForChildOfsX = this.#updateRectForChild.left - child.rect.left;
          this.#updateRectForChildOfsY = this.#updateRectForChild.top - child.rect.top;
          child.draw(this, TvpRect.from(this.#updateRectForChild), true);
        });
        if (!this.mainImage) {
          const nr = new TvpComplexRect();
          nr.or(cr);
          nr.sub(this.#drawnRegion);
          for (const r2 of nr.rects())
            this.#copySelf(this.#updateBitmapForChild!, r2.left, r2.top, r2);
        }
      }
      this.#cacheRecalcRegion.sub(rect);
      if (this.#cacheRecalcRegion.count > TVP_CACHE_UNITE_LIMIT) this.#cacheRecalcRegion.unite();
      const pr = TvpRect.from(rect);
      pr.addOffsets(this.rect.left, this.rect.top);
      target.drawCompleted(pr, this.#cacheBitmap!, rect, this.displayType, this.opacity);
    } else if (this.visibleChildrenCount === 0) {
      const pr = TvpRect.from(rect);
      pr.addOffsets(this.rect.left, this.rect.top);
      this.#drawSelf(target, pr, TvpRect.from(rect));
    } else {
      const overlapped = this.#getOverlappedRegion();
      const exposed = this.#getExposedRegion();
      this.#drawnRegion.clear();
      for (const it of overlapped.rects()) {
        const cr = TvpRect.from(it);
        if (!intersectRect(cr, cr, rect)) continue;
        const updaterectforchild = new TvpRect();
        let tempalloc = false;
        if (totalopaque) {
          this.#updateBitmapForChild = target.getDrawTargetBitmap(cr, updaterectforchild);
        } else {
          this.#updateBitmapForChild = temp.getTemp(cr.width, cr.height);
          tempalloc = true;
          updaterectforchild.set(0, 0, cr.width, cr.height);
        }
        try {
          this.#copySelf(
            this.#updateBitmapForChild,
            updaterectforchild.left,
            updaterectforchild.top,
            cr,
          );
          this.#forEachChild((child) => {
            if (!child.visible) return;
            const chrect = new TvpRect();
            if (!intersectRect(chrect, cr, child.rect)) return;
            const ox = chrect.left - cr.left;
            const oy = chrect.top - cr.top;
            this.#updateRectForChild.assign(updaterectforchild);
            this.#updateRectForChild.addOffsets(ox, oy);
            this.#updateRectForChildOfsX = chrect.left - child.rect.left;
            this.#updateRectForChildOfsY = chrect.top - child.rect.top;
            this.#updateOfsX = cr.left - updaterectforchild.left;
            this.#updateOfsY = cr.top - updaterectforchild.top;
            child.draw(this, chrect, true);
          });
          if (this.displayType !== ltBinder) {
            const pr = TvpRect.from(cr);
            pr.addOffsets(this.rect.left, this.rect.top);
            target.drawCompleted(
              pr,
              this.#updateBitmapForChild!,
              updaterectforchild,
              this.displayType,
              this.opacity,
            );
          }
        } finally {
          if (tempalloc) temp.freeTemp();
        }
      }
      this.#directTransferToParent = true;
      for (const it of exposed.rects()) {
        const cr = TvpRect.from(it);
        if (!intersectRect(cr, cr, rect)) continue;
        if (this.mainImage) {
          const pr = TvpRect.from(cr);
          pr.addOffsets(this.rect.left, this.rect.top);
          this.#drawSelf(target, pr, cr);
        } else {
          this.#forEachChild((child) => {
            if (!child.visible) return;
            const chrect = new TvpRect();
            if (!intersectRect(chrect, cr, child.rect)) return;
            child.draw(this, chrect, true);
          });
        }
      }
      this.#directTransferToParent = false;
    }
    this.#currentDrawTarget = null;
  }

  getDrawTargetBitmap(rect: TvpRect, cliprect: TvpRect): TvpBaseBitmap {
    if (this.displayType === ltBinder || (!this.mainImage && this.#directTransferToParent)) {
      const r = TvpRect.from(rect);
      r.addOffsets(this.rect.left, this.rect.top);
      return this.#currentDrawTarget!.getDrawTargetBitmap(r, cliprect);
    }
    const w = rect.width,
      h = rect.height;
    if (this.#updateRectForChild.width < w || this.#updateRectForChild.height < h)
      throwTjsError('TVPInternalError');
    cliprect.assign(this.#updateRectForChild);
    cliprect.addOffsets(
      rect.left - this.#updateRectForChildOfsX,
      rect.top - this.#updateRectForChildOfsY,
    );
    return this.#updateBitmapForChild!;
  }

  getTargetLayerType(): number {
    if (this.displayType === ltBinder) return this.parent ? this.parent.displayType : ltOpaque;
    return this.displayType;
  }

  drawCompleted(
    destrect: TvpRect,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
    type: number,
    opacity: number,
  ): void {
    if (this.displayType === ltBinder || (!this.mainImage && this.#directTransferToParent)) {
      const d = TvpRect.from(destrect);
      d.addOffsets(this.rect.left, this.rect.top);
      this.#currentDrawTarget!.drawCompleted(d, bmp, TvpRect.from(cliprect), type, opacity);
      return;
    }
    if (bmp === this.#updateBitmapForChild) return;
    const ub = this.#updateBitmapForChild!;
    const sourceRect = (r: TvpRect) => {
      const sr = new TvpRect(
        cliprect.left + (r.left - destrect.left),
        cliprect.top + (r.top - destrect.top),
      );
      sr.right = sr.left + r.width;
      sr.bottom = sr.top + r.height;
      return sr;
    };
    if (!this.mainImage) {
      const nr = new TvpComplexRect();
      nr.or(destrect);
      nr.sub(this.#drawnRegion);
      const opr = new TvpComplexRect();
      if (this.displayType === type && opacity === 255) {
        for (const r of nr.rects())
          ub.copyRect(r.left - this.#updateOfsX, r.top - this.#updateOfsY, bmp, sourceRect(r));
        opr.or(destrect);
        opr.sub(nr);
      } else {
        for (const r of nr.rects()) {
          r.addOffsets(-this.#updateOfsX, -this.#updateOfsY);
          this.#copySelf(ub, r.left, r.top, r);
        }
        opr.or(destrect);
      }
      for (const r of opr.rects())
        LayerNI.bltImage(
          ub,
          this.displayType,
          r.left - this.#updateOfsX,
          r.top - this.#updateOfsY,
          bmp,
          sourceRect(r),
          type,
          opacity,
        );
      this.#drawnRegion.or(destrect);
    } else {
      LayerNI.bltImage(
        ub,
        this.displayType,
        destrect.left - this.#updateOfsX,
        destrect.top - this.#updateOfsY,
        bmp,
        cliprect,
        type,
        opacity,
      );
    }
  }

  #internalComplete2(updateregion: TvpComplexRect, drawable: TvpDrawable): void {
    this.manager?.queryUpdateExcludeRect();
    const split = this.ctx.splitOperationType;
    for (const it of updateregion.rects()) {
      const r = TvpRect.from(it);
      r.addOffsets(this.rect.left, this.rect.top);
      if (split !== gsotNone) {
        let oh: number;
        if (this.visibleChildrenCount || this.inTransition) {
          const rw = r.width;
          if (rw < 40) oh = 128;
          else if (rw < 80) oh = 64;
          else if (rw < 160) oh = 32;
          else if (rw < 320) oh = 16;
          else oh = 8;
        } else oh = r.height;
        const or = new TvpRect(r.left, 0, r.right, 0);
        if (split === gsotInterlace) {
          for (let y = r.top; y < r.bottom; y += oh * 2) {
            or.top = y;
            or.bottom = y + oh < r.bottom ? y + oh : r.bottom;
            this.draw(drawable, or, false);
          }
          for (let y = r.top + oh; y < r.bottom; y += oh * 2) {
            or.top = y;
            or.bottom = y + oh < r.bottom ? y + oh : r.bottom;
            this.draw(drawable, or, false);
          }
        } else if (split === gsotSimple) {
          for (let y = r.top; y < r.bottom; y += oh) {
            or.top = y;
            or.bottom = y + oh < r.bottom ? y + oh : r.bottom;
            this.draw(drawable, or, false);
          }
        } else if (split === gsotBiDirection) {
          if (bidirection & 1) {
            for (let y = r.top; y < r.bottom; y += oh) {
              or.top = y;
              or.bottom = y + oh < r.bottom ? y + oh : r.bottom;
              this.draw(drawable, or, false);
            }
          } else {
            let y = r.bottom - oh;
            if (y < r.top) y = r.top;
            for (;;) {
              or.top = y < r.top ? r.top : y;
              or.bottom = y + oh < r.bottom ? y + oh : r.bottom;
              if (or.bottom <= r.top) break;
              this.draw(drawable, or, false);
              y -= oh;
            }
          }
          bidirection++;
        }
      } else this.draw(drawable, r, false);
    }
    updateregion.clear();
  }

  #internalComplete(updateregion: TvpComplexRect, drawable: TvpDrawable): void {
    this.#beforeCompletion();
    this.#inCompletion = true;
    try {
      this.#internalComplete2(updateregion, drawable);
    } finally {
      this.#inCompletion = false;
    }
    this.#afterCompletion();
  }

  /** `CompleteForWindow`: draws the manager's update region onto its draw device. */
  completeForWindow(drawable: TvpDrawable): void {
    this.#beforeCompletion();
    const manager = this.manager!;
    manager.notifyUpdateRegionFixed();
    this.#inCompletion = true;
    const lto = manager.layerTreeOwner;
    lto.startBitmapCompletion(manager);
    try {
      this.#internalComplete2(manager.updateRegionForCompletion, drawable);
    } finally {
      lto.endBitmapCompletion(manager);
    }
    this.#inCompletion = false;
    this.#afterCompletion();
  }

  /** `Complete(rect)`: the cache bitmap with `rect` completed (caching must be enabled). */
  complete(rect = new TvpRect(0, 0, this.rect.width, this.rect.height)): TvpBaseBitmap | null {
    if (!this.cacheEnabled) return null;
    const img = this.mainImage;
    if (
      this.visibleChildrenCount === 0 &&
      this.imageLeft === 0 &&
      this.imageTop === 0 &&
      img &&
      img.width === this.width &&
      img.height === this.height
    )
      return img;
    if (this.#cacheRecalcRegion.count === 0) return this.#cacheBitmap;
    const cache = this.#cacheBitmap!;
    const displayType = this.displayType;
    const drawable: TvpDrawable = {
      getDrawTargetBitmap: (r, cliprect) => {
        cliprect.assign(r);
        return cache;
      },
      getTargetLayerType: () => displayType,
      drawCompleted: (destrect, bmp, cliprect) => {
        if (bmp !== cache) cache.copyRect(destrect.left, destrect.top, bmp, cliprect);
      },
    };
    const ur = new TvpComplexRect();
    ur.or(rect);
    this.#internalComplete(ur, drawable);
    return cache;
  }

  // --- transitions -----------------------------------------------------------------------------

  /** `StartTransition`. */
  startTransition(
    name: string,
    withchildren: boolean,
    transsource: LayerNI | null,
    options: ObjectVariant,
  ): void {
    if (this.inTransition) throwTjsError('TVPCurrentTransitionMustBeStopping');
    if (transsource && transsource.#transSrc === this) throwTjsError('TVPTransitionMutualSource');
    const pro = this.ctx.transitions.find(name);
    if (!options.object) throwTjsError('TJSNullAccess');
    const sop = new TvpObjectOptionProvider(options);

    const v = new VariantSlot();
    try {
      this.#transSelfUpdate = false;
      if (sop.getValue('selfupdate', v) && v.value.type !== 0)
        this.#transSelfUpdate = asInteger(v.value) !== 0n;
      releaseVariant(this.#transTickCallback);
      this.#transTickCallback = NULL_OBJECT;
      this.#useTransTickCallback = false;
      if (sop.getValue('callback', v) && v.value.type !== 0) {
        const cb = asObjectClosure(v.value);
        addRefVariant(cb);
        this.#transTickCallback = cb;
        this.#useTransTickCallback = true;
      }
    } finally {
      v.clear();
    }

    const size = (l: LayerNI, children: boolean) =>
      children ? [l.width, l.height] : [l.mainImage!.width, l.mainImage!.height];
    const [s1w, s1h] = size(this, withchildren);
    const [s2w, s2h] = transsource ? size(transsource, withchildren) : [0, 0];
    const started = pro.startTransition(sop, this.displayType, s1w!, s1h!, s2w!, s2h!);
    if (typeof started === 'number')
      throwTjsError('TVPTransHandlerError', 'iTVPTransHandlerProvider::StartTransition failed');
    const handler = started.handler;
    try {
      this.#transType = started.type;
      this.#transUpdateType = started.updateType;
      if (
        this.#transUpdateType !== tutDivisibleFade &&
        this.#transUpdateType !== tutDivisible &&
        this.#transUpdateType !== tutGiveUpdate
      )
        throwTjsError('TVPTransHandlerError', tjsMessageText('TVPUnknownUpdateType'));
      if (this.#transType !== ttSimple && this.#transType !== ttExchange)
        throwTjsError('TVPTransHandlerError', tjsMessageText('TVPUnknownTransitionType'));
      if (this.#transUpdateType === tutGiveUpdate)
        throwTjsError(
          'TVPTransHandlerError',
          tjsMessageText('TVPUnsupportedUpdateTypeTutGiveUpdate'),
        );
      if (this.#transType === ttExchange && !transsource)
        throwTjsError('TVPSpecifyTransitionSource');
      if (!withchildren) {
        if (!this.mainImage) throwTjsError('TVPTransitionSourceAndDestinationMustHaveImage');
        if (transsource && !transsource.mainImage)
          throwTjsError('TVPTransitionSourceAndDestinationMustHaveImage');
      }
    } catch (e) {
      handler.release();
      throw e;
    }
    this.#transWithChildren = withchildren;
    if (withchildren) {
      this.incCacheEnabledCount();
      transsource?.incCacheEnabledCount();
    }
    this.#transSrc = transsource;
    if (transsource) transsource.#transDest = this;
    if (handler.kind === 'divisible') this.#divisibleTransHandler = handler;
    else this.#giveUpdateTransHandler = handler;
    this.#transDestObj = this.owner;
    this.#transDestObj?.addRef();
    this.#transSrcObj = transsource ? transsource.owner : null;
    this.#transSrcObj?.addRef();
    if (!this.#transSelfUpdate) this.ctx.events.addContinuousEventHook(this.#transIdleCallback);
    if (this.#useTransTickCallback) {
      this.#transTick = 0n;
      if (this.#divisibleTransHandler) {
        this.#divisibleTransHandler.startProcess(this.#transTick);
        this.#divisibleTransHandler.endProcess();
      }
    } else this.#transTick = this.#getTransTick();
    this.inTransition = true;
    this.#transCompEventPrevented = false;
    this.update(true);
  }

  #internalStopTransition(): number {
    if (!this.inTransition) return TJS_S_OK;
    this.inTransition = false;
    this.#transCompEventPrevented = false;
    if (!this.#transSelfUpdate) this.ctx.events.removeContinuousEventHook(this.#transIdleCallback);
    if (this.#transWithChildren) {
      this.decCacheEnabledCount();
      this.#transSrc?.decCacheEnabledCount();
    }
    if (this.#transType === ttExchange) {
      const src = this.#transSrc!;
      const tl = this.rect.left,
        tt = this.rect.top;
      const sl = src.rect.left,
        st = src.rect.top;
      const tv = this.visible,
        sv = src.visible;
      if (this.#transWithChildren) this.exchange(src);
      else this.swap(src);
      this.setPosition(sl, st);
      src.setPosition(tl, tt);
      this.setVisible(sv);
      src.setVisible(tv);
    }
    const transsrcalive = !!this.#transSrc && !this.#transSrc.shutdown;
    if (this.#transSrc) this.#transSrc.#transDest = null;
    this.#transSrc = null;
    if (this.#divisibleTransHandler) {
      this.#divisibleTransHandler.release();
      this.#divisibleTransHandler = null;
    }
    if (this.#giveUpdateTransHandler) {
      this.#giveUpdateTransHandler.release();
      this.#giveUpdateTransHandler = null;
    }
    let hr = TJS_S_OK;
    if (this.#live() && transsrcalive) {
      const args = [
        obj(this.#transDestObj, this.#transDestObj),
        obj(this.#transSrcObj, this.#transSrcObj),
      ];
      for (const a of args) addRefVariant(a);
      this.#transDestObj?.release();
      this.#transDestObj = null;
      this.#transSrcObj?.release();
      this.#transSrcObj = null;
      try {
        hr = this.#post('onTransitionCompleted', args);
      } finally {
        // The event holds its own references to the arguments.
        for (const a of args) releaseVariant(a);
      }
    }
    this.#transDestObj?.release();
    this.#transDestObj = null;
    this.#transSrcObj?.release();
    this.#transSrcObj = null;
    releaseVariant(this.#transTickCallback);
    this.#transTickCallback = NULL_OBJECT;
    return hr;
  }

  /** `StopTransition`. Returns the result of `onTransitionCompleted` (may suspend). */
  stopTransition(): number {
    return this.#internalStopTransition();
  }

  #stopTransitionByHandler(): void {
    if (!this.ctx.events.eventDisabled)
      this.suspender.nonSuspending(() => this.#internalStopTransition());
    else this.#transCompEventPrevented = true;
  }

  #invokeTransition(tick: bigint): void {
    if (!this.#transCompEventPrevented) {
      this.#transTick = this.#useTransTickCallback ? this.#getTransTick() : tick;
      if (!this.getNodeVisible()) this.#stopTransitionByHandler();
      else if (
        !this.mainImage &&
        this.#transWithChildren &&
        this.#transUpdateType === tutDivisibleFade &&
        this.displayType !== ltOpaque
      ) {
        this.updateAllChildren(true);
        this.#transSrc?.updateAllChildren(true);
      } else this.update(true);
    } else if (!this.ctx.events.eventDisabled) {
      this.suspender.nonSuspending(() => this.#internalStopTransition());
    }
  }

  #slp(which: 'src' | 'dest', bmp: TvpBaseBitmap): TvpBaseBitmapScanLineProvider {
    if (which === 'src') {
      if (!this.#srcSLP) this.#srcSLP = new TvpBaseBitmapScanLineProvider(bmp);
      else this.#srcSLP.attach(bmp);
      return this.#srcSLP;
    }
    if (!this.#destSLP) this.#destSLP = new TvpBaseBitmapScanLineProvider(bmp);
    else this.#destSLP.attach(bmp);
    return this.#destSLP;
  }

  #doDivisibleTransition(dest: TvpBaseBitmap, dx: number, dy: number, srcrect: TvpRect): void {
    if (!this.inTransition || !this.#divisibleTransHandler) return;
    const src1 = this.#slp('src', this.mainImage!);
    const src2 = this.#transSrc ? this.#transSrc.#slp('src', this.#transSrc.mainImage!) : null;
    const data: TvpDivisibleData = {
      left: srcrect.left,
      top: srcrect.top,
      width: srcrect.width,
      height: srcrect.height,
      src1,
      src1Left: srcrect.left,
      src1Top: srcrect.top,
      src2,
      src2Left: srcrect.left,
      src2Top: srcrect.top,
      dest: this.#slp('dest', dest),
      destLeft: dx,
      destTop: dy,
    };
    this.imageModified = true;
    this.#divisibleTransHandler.process(data);
    if (data.dest === data.src1) dest.copyRect(dx, dy, this.mainImage!, srcrect);
    else if (data.dest === data.src2) dest.copyRect(dx, dy, this.#transSrc!.mainImage!, srcrect);
  }

  /** `tTransDrawable::DrawCompleted`. */
  transDrawCompleted(
    td: TransDrawable,
    destrect: TvpRect,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
    type: number,
    opacity: number,
  ): void {
    if (!this.inTransition || !this.#divisibleTransHandler) return;
    const src1bmp = this.#transUpdateType === tutDivisible ? td.src1Bmp! : bmp;
    this.imageModified = true;
    const src1 = this.#slp('src', src1bmp);
    let src: TvpBaseBitmap | null = null;
    let src2: TvpBaseBitmapScanLineProvider | null = null;
    const left = destrect.left - this.rect.left;
    const top = destrect.top - this.rect.top;
    if (this.#transSrc) {
      src = this.#transUpdateType === tutDivisible ? td.src2Bmp : this.#transSrc.complete(destrect);
      src2 = this.#transSrc.#slp('src', src!);
    }
    let dest: TvpBaseBitmap;
    let tempalloc = false;
    let destLeft: number, destTop: number;
    const temp = this.ctx.temp;
    if (bmp === td.target || !td.target) {
      dest = temp.getTemp(cliprect.width, cliprect.height, true);
      tempalloc = true;
      destLeft = 0;
      destTop = 0;
    } else {
      dest = td.target;
      destLeft = td.targetRect.left;
      destTop = td.targetRect.top;
    }
    const data: TvpDivisibleData = {
      left,
      top,
      width: cliprect.width,
      height: cliprect.height,
      src1,
      src1Left: cliprect.left,
      src1Top: cliprect.top,
      src2,
      src2Left: left,
      src2Top: top,
      dest: this.#slp('dest', dest),
      destLeft,
      destTop,
    };
    try {
      this.#divisibleTransHandler.process(data);
      const cr = TvpRect.from(cliprect);
      if (data.dest === this.#destSLP) {
        cr.setOffsets(data.destLeft, data.destTop);
        td.org!.drawCompleted(destrect, dest, cr, type, opacity);
      } else if (data.dest === data.src1) {
        cr.setOffsets(data.destLeft, data.destTop);
        td.org!.drawCompleted(destrect, bmp, cr, type, opacity);
      } else if (data.dest === data.src2 && this.#transSrc) {
        cr.setOffsets(data.destLeft, data.destTop);
        td.org!.drawCompleted(destrect, src!, cr, type, opacity);
      }
    } finally {
      if (tempalloc) temp.freeTemp();
    }
  }

  #getTransTick(): bigint {
    if (!this.#useTransTickCallback) return this.ctx.tickCount();
    const res = new VariantSlot();
    try {
      this.suspender.nonSuspending(() =>
        closureFuncCall(this.#transTickCallback, 0, null, res, [], null),
      );
      return BigInt.asUintN(64, asInteger(res.value));
    } finally {
      res.clear();
    }
  }
}

/** `tTVPGraphicSplitOperationType` `gsotBiDirection`: the static direction counter. */
let bidirection = 0;

/** Layer types and the `Blt` methods of the blends that keep the destination alpha. */
const DRAWTYPE_BLT: Partial<Record<number, BltMethod>> = {
  [ltAdditive]: BltMethod.bmAdd,
  [ltSubtractive]: BltMethod.bmSub,
  [ltMultiplicative]: BltMethod.bmMul,
  [ltDodge]: BltMethod.bmDodge,
  [ltDarken]: BltMethod.bmDarken,
  [ltLighten]: BltMethod.bmLighten,
  [ltScreen]: BltMethod.bmScreen,
  [ltPsNormal]: BltMethod.bmPsNormal,
  [ltPsAdditive]: BltMethod.bmPsAdditive,
  [ltPsSubtractive]: BltMethod.bmPsSubtractive,
  [ltPsMultiplicative]: BltMethod.bmPsMultiplicative,
  [ltPsScreen]: BltMethod.bmPsScreen,
  [ltPsOverlay]: BltMethod.bmPsOverlay,
  [ltPsHardLight]: BltMethod.bmPsHardLight,
  [ltPsSoftLight]: BltMethod.bmPsSoftLight,
  [ltPsColorDodge]: BltMethod.bmPsColorDodge,
  [ltPsColorDodge5]: BltMethod.bmPsColorDodge5,
  [ltPsColorBurn]: BltMethod.bmPsColorBurn,
  [ltPsLighten]: BltMethod.bmPsLighten,
  [ltPsDarken]: BltMethod.bmPsDarken,
  [ltPsDifference]: BltMethod.bmPsDifference,
  [ltPsDifference5]: BltMethod.bmPsDifference5,
  [ltPsExclusion]: BltMethod.bmPsExclusion,
};

/** `tTransDrawable`: the pipeline stage of a transition with children. */
class TransDrawable implements TvpDrawable {
  org: TvpDrawable | null = null;
  target: TvpBaseBitmap | null = null;
  readonly targetRect = new TvpRect();
  src1Bmp: TvpBaseBitmap | null = null;
  src2Bmp: TvpBaseBitmap | null = null;

  constructor(private readonly owner: LayerNI) {}

  init(org: TvpDrawable): void {
    this.org = org;
    this.target = null;
  }

  getDrawTargetBitmap(rect: TvpRect, cliprect: TvpRect): TvpBaseBitmap {
    this.target = this.org!.getDrawTargetBitmap(rect, cliprect);
    this.targetRect.assign(cliprect);
    return this.target;
  }

  getTargetLayerType(): number {
    return this.org!.getTargetLayerType();
  }

  drawCompleted(
    destrect: TvpRect,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
    type: number,
    opacity: number,
  ): void {
    this.owner.transDrawCompleted(this, destrect, bmp, cliprect, type, opacity);
  }
}

function tjsMessageText(name: KirikiriMessageName): string {
  return tjsMessage(name);
}

/** A stable per-object address for dumps. */
const addresses = new WeakMap<object, number>();
let nextAddress = 0x01000000;
function hex(o: object | null): string {
  if (!o) return '00000000';
  let a = addresses.get(o);
  if (a === undefined) addresses.set(o, (a = nextAddress += 0x40));
  return a.toString(16).toUpperCase().padStart(8, '0');
}
