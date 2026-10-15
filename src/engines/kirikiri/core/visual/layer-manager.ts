/**
 * `tTVPLayerManager` (krkrz `visual/LayerManager.cpp`): one layer tree's primary layer, update
 * region, mouse capture, focus, modal layers and input dispatch. It is the drawable the tree
 * completes onto; completed pieces go to the layer tree owner (the Window, which hands them to
 * its draw device).
 *
 * Input notifications return result codes: the layer events they fire may suspend, so the
 * dispatch that continues after an event is written as a suspendable routine.
 */
import {throwTjsError} from '../../tjs2/runtime/errors.js';
import {failed, TJS_S_OK, type Dispatch} from '../../tjs2/runtime/interface.js';
import {
  runRoutine,
  type SuspendableRoutine,
  type Suspender,
} from '../../tjs2/runtime/suspension.js';
import {TvpBaseBitmap} from './base-bitmap.js';
import {TvpComplexRect, TvpRect, intersectRect} from './complex-rect.js';
import {TVP_UPDATE_UNITE_LIMIT, type LayerNI} from './layer.js';
import {
  isAnyMouseButtonPressed,
  ltOpaque,
  type TvpDrawable,
  type TvpLayerManagerInterface,
  type TvpLayerTreeOwner,
} from './layer-types.js';

interface TouchCapture {
  readonly touchId: number;
  owner: LayerNI;
}

export class TvpLayerManager implements TvpLayerManagerInterface<LayerNI>, TvpDrawable {
  #refCount = 1;
  layerTreeOwner: TvpLayerTreeOwner;
  #drawDeviceData: unknown = null;
  #drawBuffer: TvpBaseBitmap | null = null;
  #desiredLayerType = ltOpaque;
  #captureOwner: LayerNI | null = null;
  #lastMouseMoveSent: LayerNI | null = null;
  readonly #touchCapture: TouchCapture[] = [];
  #releaseTouchCaptureIdMark = -1;
  readonly #modalLayers: LayerNI[] = [];
  focusedLayer: LayerNI | null = null;
  primary: LayerNI | null = null;
  #overallOrderIndexValid = false;
  #allNodes: LayerNI[] = [];
  readonly updateRegionForCompletion = new TvpComplexRect();
  #focusChangeLock = false;
  #visualStateChanged = true;
  #lastMouseMoveX = -1;
  #lastMouseMoveY = -1;
  #releaseCaptureCalled = false;
  #inNotifyingHintOrCursorChange = false;
  #enabledWorkRefCount = 0;

  constructor(
    owner: TvpLayerTreeOwner,
    private readonly suspender: Suspender,
  ) {
    this.layerTreeOwner = owner;
  }

  addRef(): void {
    this.#refCount++;
  }

  release(): void {
    if (this.#refCount === 1) {
      this.#refCount = 0;
      this.#drawBuffer?.dispose();
      this.#drawBuffer = null;
    } else this.#refCount--;
  }

  setDrawDeviceData(data: unknown): void {
    this.#drawDeviceData = data;
  }

  getDrawDeviceData(): unknown {
    return this.#drawDeviceData;
  }

  registerSelfToWindow(): void {
    this.layerTreeOwner.registerLayerManager(this);
  }

  unregisterSelfFromWindow(): void {
    this.layerTreeOwner.unregisterLayerManager(this);
  }

  setDesiredLayerType(type: number): void {
    this.#desiredLayerType = type;
  }

  // --- drawable --------------------------------------------------------------------------------

  getDrawTargetBitmap(rect: TvpRect, cliprect: TvpRect): TvpBaseBitmap {
    const w = rect.width,
      h = rect.height;
    const primary = this.primary!;
    if (!this.#drawBuffer) {
      this.#drawBuffer = new TvpBaseBitmap(primary.ctx.fonts, primary.ctx.memory, w, h, 32);
    } else {
      const bw = this.#drawBuffer.width,
        bh = this.#drawBuffer.height;
      if (bw < w || bh < h) {
        let neww = bw > w ? bw : w;
        neww += neww & 1;
        this.#drawBuffer.setSize(neww, bh > h ? bh : h);
      }
    }
    cliprect.set(0, 0, w, h);
    return this.#drawBuffer;
  }

  getTargetLayerType(): number {
    return this.#desiredLayerType;
  }

  drawCompleted(
    destrect: TvpRect,
    bmp: TvpBaseBitmap,
    cliprect: TvpRect,
    type: number,
    opacity: number,
  ): void {
    this.layerTreeOwner.notifyBitmapCompleted(
      this,
      destrect.left,
      destrect.top,
      bmp,
      cliprect,
      type,
      opacity,
    );
  }

  // --- primary layer ---------------------------------------------------------------------------

  attachPrimary(pri: LayerNI): void {
    this.detachPrimary();
    if (!this.primary) {
      this.primary = pri;
      this.#enabledWorkRefCount = 0;
      this.#overallOrderIndexValid = false;
      this.updateRegionForCompletion.clear();
      pri.setVisible(true);
      pri.setOpacity(255);
    }
  }

  detachPrimary(): void {
    if (!this.primary) return;
    this.setFocusTo(null);
    this.releaseCapture();
    this.releaseTouchCaptureAll();
    this.forceMouseLeave();
    this.notifyPart(this.primary);
    this.primary = null;
  }

  getPrimaryLayer(): LayerNI | null {
    return this.primary;
  }

  getPrimaryLayerSize(): {w: number; h: number} | null {
    if (!this.primary) return null;
    return {w: this.primary.width, h: this.primary.height};
  }

  notifyPart(lay: LayerNI): void {
    this.invalidateOverallIndex();
    this.blurTree(lay);
    this.releaseCaptureFromTree(lay);
  }

  invalidateOverallIndex(): void {
    this.#overallOrderIndexValid = false;
  }

  recreateOverallOrderIndex(): void {
    if (this.#overallOrderIndexValid) return;
    const index = {value: 0};
    this.#allNodes = [];
    this.primary?.recreateOverallOrderIndex(index, this.#allNodes);
    this.#overallOrderIndexValid = true;
  }

  getAllNodes(): LayerNI[] {
    if (!this.#overallOrderIndexValid) this.recreateOverallOrderIndex();
    return this.#allNodes;
  }

  notifyVisualStateChanged(): void {
    this.#visualStateChanged = true;
  }

  get visualStateChanged(): boolean {
    return this.#visualStateChanged;
  }

  queryUpdateExcludeRect(): void {
    if (!this.#visualStateChanged) return;
    const r = new TvpRect();
    this.primary?.queryUpdateExcludeRect(r, true);
    this.#visualStateChanged = false;
  }

  // --- cursor, hint ----------------------------------------------------------------------------

  #underCursor(): LayerNI | null {
    return (
      this.#captureOwner ?? this.getMostFrontChildAt(this.#lastMouseMoveX, this.#lastMouseMoveY)
    );
  }

  notifyMouseCursorChange(layer: LayerNI, cursor: number): void {
    if (this.#inNotifyingHintOrCursorChange) return;
    this.#inNotifyingHintOrCursorChange = true;
    try {
      if (this.#underCursor() === layer) this.setMouseCursor(cursor);
    } finally {
      this.#inNotifyingHintOrCursorChange = false;
    }
  }

  setMouseCursor(cursor: number): void {
    this.layerTreeOwner?.setMouseCursor(this, cursor);
  }

  getCursorPos(): {x: number; y: number} {
    return this.layerTreeOwner ? this.layerTreeOwner.getCursorPos(this) : {x: 0, y: 0};
  }

  setCursorPos(x: number, y: number): void {
    this.layerTreeOwner?.setCursorPos(this, x, y);
  }

  notifyHintChange(layer: LayerNI, hint: string): void {
    if (this.#inNotifyingHintOrCursorChange) return;
    this.#inNotifyingHintOrCursorChange = true;
    try {
      const l = this.#underCursor();
      if (l === layer) this.setHint(l.owner, hint);
    } finally {
      this.#inNotifyingHintOrCursorChange = false;
    }
  }

  setHint(sender: Dispatch | null, hint: string): void {
    this.layerTreeOwner?.setHint(this, sender, hint);
  }

  notifyLayerResize(): void {
    this.layerTreeOwner?.notifyLayerResize(this);
  }

  notifyWindowInvalidation(): void {
    this.layerTreeOwner?.notifyLayerImageChange(this);
  }

  setLayerTreeOwner(owner: TvpLayerTreeOwner): void {
    this.layerTreeOwner = owner;
  }

  notifyResizeFromWindow(w: number, h: number): void {
    this.primary?.internalSetSize(w, h);
  }

  // --- input -----------------------------------------------------------------------------------

  getMostFrontChildAt(
    x: number,
    y: number,
    except: LayerNI | null = null,
    getDisabled = false,
  ): LayerNI | null {
    if (!this.primary) return null;
    const out = {layer: null as LayerNI | null};
    this.primary.getMostFrontChildAtInternal(x, y, out, except, getDisabled);
    return out.layer;
  }

  #run(routine: SuspendableRoutine): number {
    return runRoutine(this.suspender, routine);
  }

  notifyClick(x: number, y: number): number {
    const l = this.getMostFrontChildAt(x, y);
    if (l && this.#captureOwner === l) {
      const p = {x, y};
      l.fromPrimaryCoordinates(p);
      return l.fireClick(p.x, p.y);
    }
    return TJS_S_OK;
  }

  notifyDoubleClick(x: number, y: number): number {
    const l = this.getMostFrontChildAt(x, y);
    if (l) {
      const p = {x, y};
      l.fromPrimaryCoordinates(p);
      return l.fireDoubleClick(p.x, p.y);
    }
    return TJS_S_OK;
  }

  notifyMouseDown(x: number, y: number, mb: number, flags: number): number {
    const self = this;
    return this.#run(
      (function* (): SuspendableRoutine {
        let hr = yield () => self.notifyMouseMove(x, y, flags);
        if (failed(hr)) return hr;
        const l = self.#captureOwner ?? self.getMostFrontChildAt(x, y);
        if (l) {
          const p = {x, y};
          l.fromPrimaryCoordinates(p);
          self.#releaseCaptureCalled = false;
          hr = yield () => l.fireMouseDown(p.x, p.y, mb, flags);
          if (failed(hr)) return hr;
          const noCapture = self.#releaseCaptureCalled;
          if (self.#captureOwner !== l) {
            self.releaseCapture();
            if (!noCapture) {
              self.#captureOwner = l;
              l.owner?.addRef();
            }
          }
          self.setHint(null, '');
        } else self.releaseCapture();
        return TJS_S_OK;
      })(),
    );
  }

  notifyMouseUp(x: number, y: number, mb: number, flags: number): number {
    const self = this;
    return this.#run(
      (function* (): SuspendableRoutine {
        const l = self.#captureOwner ?? self.getMostFrontChildAt(x, y);
        if (!l) return TJS_S_OK;
        const p = {x, y};
        l.fromPrimaryCoordinates(p);
        const hr = yield () => l.fireMouseUp(p.x, p.y, mb, flags);
        if (failed(hr)) return hr;
        if (!isAnyMouseButtonPressed(flags)) {
          self.releaseCapture();
          return yield () => self.notifyMouseMove(x, y, flags);
        }
        return TJS_S_OK;
      })(),
    );
  }

  /** `PrimaryMouseMove`: enter/leave events, then `onMouseMove` when the position changed. */
  notifyMouseMove(x: number, y: number, flags: number): number {
    const self = this;
    return this.#run(
      (function* (): SuspendableRoutine {
        const poschanged = self.#lastMouseMoveX !== x || self.#lastMouseMoveY !== y;
        self.#lastMouseMoveX = x;
        self.#lastMouseMoveY = y;
        const pick = () => self.#captureOwner ?? self.getMostFrontChildAt(x, y);
        let l = pick();
        if (self.#lastMouseMoveSent !== l) {
          const last = self.#lastMouseMoveSent;
          if (last) {
            const hr = yield () => last.fireMouseLeave();
            if (failed(hr)) return hr;
          }
          l = pick();
          if (l) {
            self.#inNotifyingHintOrCursorChange = true;
            try {
              const entered: LayerNI = l;
              let hr = yield () => entered.fireMouseEnter();
              if (failed(hr)) return hr;
              const ll = pick();
              if (l !== ll) {
                const left: LayerNI = l;
                hr = yield () => left.fireMouseLeave();
                if (failed(hr)) return hr;
                l = ll;
                if (l) {
                  const again: LayerNI = l;
                  hr = yield () => again.fireMouseEnter();
                  if (failed(hr)) return hr;
                }
              }
              if (l) l.setCurrentCursorToWindow();
              if (l) l.setCurrentHintToWindow();
            } finally {
              self.#inNotifyingHintOrCursorChange = false;
            }
          }
          if (!l) {
            self.setMouseCursor(0);
            self.setHint(null, '');
          }
        }
        if (self.#lastMouseMoveSent !== l) {
          if (self.#lastMouseMoveSent) {
            const lay = self.#lastMouseMoveSent;
            self.#lastMouseMoveSent = null;
            lay.owner?.release();
          }
          self.#lastMouseMoveSent = l;
          l?.owner?.addRef();
        }
        if (l && poschanged) {
          const p = {x, y};
          l.fromPrimaryCoordinates(p);
          const target: LayerNI = l;
          return yield () => target.fireMouseMove(p.x, p.y, flags);
        }
        return TJS_S_OK;
      })(),
    );
  }

  notifyTouchDown(x: number, y: number, cx: number, cy: number, id: number): number {
    const self = this;
    return this.#run(
      (function* (): SuspendableRoutine {
        self.releaseTouchCapture(id);
        const l = self.getMostFrontChildAt(Math.trunc(x), Math.trunc(y));
        if (!l) return TJS_S_OK;
        const p = {x, y};
        l.fromPrimaryCoordinates(p);
        self.#releaseTouchCaptureIdMark = id;
        const hr = yield () => l.fireTouchDown(p.x, p.y, cx, cy, id);
        if (failed(hr)) return hr;
        if (self.#releaseTouchCaptureIdMark === id) self.#setTouchCapture(id, l);
        return TJS_S_OK;
      })(),
    );
  }

  notifyTouchUp(x: number, y: number, cx: number, cy: number, id: number): number {
    const self = this;
    return this.#run(
      (function* (): SuspendableRoutine {
        const l =
          self.#getTouchCapture(id) ?? self.getMostFrontChildAt(Math.trunc(x), Math.trunc(y));
        if (!l) return TJS_S_OK;
        const p = {x, y};
        l.fromPrimaryCoordinates(p);
        const hr = yield () => l.fireTouchUp(p.x, p.y, cx, cy, id);
        if (failed(hr)) return hr;
        self.releaseTouchCapture(id);
        return TJS_S_OK;
      })(),
    );
  }

  notifyTouchMove(x: number, y: number, cx: number, cy: number, id: number): number {
    const l = this.#getTouchCapture(id) ?? this.getMostFrontChildAt(Math.trunc(x), Math.trunc(y));
    if (!l) return TJS_S_OK;
    const p = {x, y};
    l.fromPrimaryCoordinates(p);
    return l.fireTouchMove(p.x, p.y, cx, cy, id);
  }

  notifyTouchScaling(
    startdist: number,
    curdist: number,
    cx: number,
    cy: number,
    flag: number,
  ): number {
    return this.focusedLayer
      ? this.focusedLayer.fireTouchScaling(startdist, curdist, cx, cy, flag)
      : TJS_S_OK;
  }

  notifyTouchRotate(
    startangle: number,
    curangle: number,
    dist: number,
    cx: number,
    cy: number,
    flag: number,
  ): number {
    return this.focusedLayer
      ? this.focusedLayer.fireTouchRotate(startangle, curangle, dist, cx, cy, flag)
      : TJS_S_OK;
  }

  notifyMultiTouch(): number {
    return this.focusedLayer ? this.focusedLayer.fireMultiTouch() : TJS_S_OK;
  }

  forceMouseLeave(): void {
    const lay = this.#lastMouseMoveSent;
    if (!lay) return;
    this.#lastMouseMoveSent = null;
    lay.primaryLeaveNow();
    lay.owner?.release();
  }

  forceMouseRecheck(): number {
    return this.notifyMouseMove(this.#lastMouseMoveX, this.#lastMouseMoveY, 0);
  }

  notifyMouseOutOfWindow(): number {
    if (!this.#captureOwner) return this.notifyMouseMove(-1, -1, 0);
    return TJS_S_OK;
  }

  leaveMouseFromTree(root: LayerNI): void {
    const lay = this.#lastMouseMoveSent;
    if (lay && lay.isAncestorOrSelf(root)) {
      this.#lastMouseMoveSent = null;
      lay.primaryLeaveNow();
      lay.owner?.release();
    }
  }

  releaseCapture(): void {
    this.#releaseCaptureCalled = true;
    const lay = this.#captureOwner;
    if (lay) {
      this.#captureOwner = null;
      lay.owner?.release();
      this.layerTreeOwner.releaseMouseCapture(this);
    }
  }

  releaseCaptureFromTree(layer: LayerNI): void {
    if (this.#captureOwner && this.#captureOwner.isAncestorOrSelf(layer)) this.releaseCapture();
    for (let i = 0; i < this.#touchCapture.length;) {
      const t = this.#touchCapture[i]!;
      if (t.owner.isAncestorOrSelf(layer)) {
        t.owner.owner?.release();
        if (this.#releaseTouchCaptureIdMark === t.touchId) this.#releaseTouchCaptureIdMark = -1;
        this.#touchCapture.splice(i, 1);
      } else i++;
    }
  }

  releaseTouchCapture(id: number): void {
    const i = this.#touchCapture.findIndex((t) => t.touchId === id);
    if (i >= 0) {
      this.#touchCapture[i]!.owner.owner?.release();
      this.#touchCapture.splice(i, 1);
    }
    if (this.#releaseTouchCaptureIdMark === id) this.#releaseTouchCaptureIdMark = -1;
  }

  releaseTouchCaptureAll(): void {
    for (const t of this.#touchCapture) t.owner.owner?.release();
    this.#touchCapture.length = 0;
    this.#releaseTouchCaptureIdMark = -1;
  }

  #getTouchCapture(id: number): LayerNI | null {
    return this.#touchCapture.find((t) => t.touchId === id)?.owner ?? null;
  }

  #setTouchCapture(id: number, layer: LayerNI): void {
    const t = this.#touchCapture.find((c) => c.touchId === id);
    if (t) {
      t.owner.owner?.release();
      t.owner = layer;
    } else this.#touchCapture.push({touchId: id, owner: layer});
    layer.owner?.addRef();
  }

  // --- focus -----------------------------------------------------------------------------------

  blurTree(root: LayerNI): boolean {
    this.removeTreeModalState(root);
    this.leaveMouseFromTree(root);
    if (!this.focusedLayer) return false;
    if (!this.focusedLayer.isAncestorOrSelf(root)) return false;
    const next = root.getNextFocusable();
    if (next !== this.focusedLayer) this.setFocusTo(next, true);
    else this.setFocusTo(null, true);
    return true;
  }

  /** `CheckTreeFocusableState`: auto-focus is disabled natively. */
  checkTreeFocusableState(_root: LayerNI): void {}

  focusPrev(): LayerNI | null {
    const l = this.focusedLayer
      ? this.focusedLayer.getPrevFocusable()
      : this.searchFirstFocusable(false);
    if (l) this.setFocusTo(l, false);
    return l;
  }

  focusNext(): LayerNI | null {
    const l = this.focusedLayer
      ? this.focusedLayer.getNextFocusable()
      : this.searchFirstFocusable(false);
    if (l) this.setFocusTo(l, true);
    return l;
  }

  searchFirstFocusable(ignoreChainFocusable = true): LayerNI | null {
    return this.primary ? this.primary.searchFirstFocusable(ignoreChainFocusable) : null;
  }

  getFocusedLayer(): LayerNI | null {
    return this.focusedLayer;
  }

  setFocusedLayer(layer: LayerNI | null): void {
    this.setFocusTo(layer, false);
  }

  setFocusTo(layer: LayerNI | null, direction = true): boolean {
    if (layer && !layer.getNodeFocusable()) return false;
    if (layer && !layer.shutdown) layer = layer.fireBeforeFocus(this.focusedLayer, direction);
    if (layer && !layer.getNodeFocusable()) return false;
    if (this.focusedLayer === layer) return false;
    if (this.#focusChangeLock) throwTjsError('TVPCannotChangeFocusInProcessingFocus');
    this.#focusChangeLock = true;
    const org = this.focusedLayer;
    this.focusedLayer = layer;
    try {
      if (org && !org.shutdown) org.fireBlur(layer);
      if (this.focusedLayer && !this.focusedLayer.shutdown)
        this.focusedLayer.fireFocus(org, direction);
    } catch (e) {
      this.focusedLayer?.owner?.addRef();
      org?.owner?.release();
      this.#focusChangeLock = false;
      throw e;
    }
    this.focusedLayer?.owner?.addRef();
    org?.owner?.release();
    if (this.focusedLayer) this.#setImeModeOf(this.focusedLayer);
    else this.#resetImeMode();
    if (this.focusedLayer) this.#setAttentionPointOf(this.focusedLayer);
    else this.#disableAttentionPoint();
    this.#focusChangeLock = false;
    return true;
  }

  releaseAllModalLayer(): void {
    const copy = this.#modalLayers.splice(0);
    for (const l of copy) l.owner?.release();
  }

  setModeTo(layer: LayerNI | null): void {
    if (!layer) return;
    this.saveEnabledWork();
    try {
      const current = this.getCurrentModalLayer();
      if (current && layer.isAncestorOrSelf(current))
        throwTjsError('TVPCannotSetModeToDisabledOrModal');
      if (!layer.visible) layer.visible = true;
      if (!layer.getParentVisible() || !layer.enabled)
        throwTjsError('TVPCannotSetModeToDisabledOrModal');
      if (layer === current) throwTjsError('TVPCannotSetModeToDisabledOrModal');
      this.setFocusTo(layer.searchFirstFocusable(), true);
      layer.owner?.addRef();
      this.#modalLayers.push(layer);
    } finally {
      this.notifyNodeEnabledState();
    }
  }

  removeModeFrom(layer: LayerNI): void {
    let doNotify = false;
    try {
      for (let i = 0; i < this.#modalLayers.length;) {
        if (this.#modalLayers[i] === layer) {
          if (!doNotify) {
            doNotify = true;
            this.saveEnabledWork();
          }
          layer.owner?.release();
          this.setFocusTo(layer.getNextFocusable(), true);
          this.#modalLayers.splice(i, 1);
        } else i++;
      }
    } finally {
      if (doNotify) this.notifyNodeEnabledState();
    }
  }

  removeTreeModalState(root: LayerNI): void {
    let doNotify = false;
    try {
      for (let i = 0; i < this.#modalLayers.length;) {
        const m = this.#modalLayers[i]!;
        if (m.isAncestorOrSelf(root)) {
          if (!doNotify) {
            doNotify = true;
            this.saveEnabledWork();
          }
          m.owner?.release();
          this.setFocusTo(root.getNextFocusable(), true);
          this.#modalLayers.splice(i, 1);
        } else i++;
      }
    } finally {
      if (doNotify) this.notifyNodeEnabledState();
    }
  }

  getCurrentModalLayer(): LayerNI | null {
    return this.#modalLayers[this.#modalLayers.length - 1] ?? null;
  }

  #searchAttentionPoint(target: LayerNI | null): {x: number; y: number} | null {
    while (target) {
      if (target.useAttention) {
        const p = {x: target.attentionLeft, y: target.attentionTop};
        target.toPrimaryCoordinates(p);
        return p;
      }
      target = target.parent;
    }
    return null;
  }

  #setAttentionPointOf(layer: LayerNI): void {
    if (!this.layerTreeOwner) return;
    const p = this.#searchAttentionPoint(layer);
    if (p) this.layerTreeOwner.setAttentionPoint(this, layer, p.x, p.y);
    else this.layerTreeOwner.disableAttentionPoint(this);
  }

  #disableAttentionPoint(): void {
    this.layerTreeOwner?.disableAttentionPoint(this);
  }

  notifyAttentionStateChanged(from: LayerNI): void {
    if (this.focusedLayer === from) this.#setAttentionPointOf(from);
  }

  #setImeModeOf(layer: LayerNI): void {
    this.layerTreeOwner?.setImeMode(this, layer.imeMode);
  }

  #resetImeMode(): void {
    this.layerTreeOwner?.resetImeMode(this);
  }

  notifyImeModeChanged(from: LayerNI): void {
    if (this.focusedLayer === from) this.#setImeModeOf(from);
  }

  saveEnabledWork(): void {
    if (this.#enabledWorkRefCount === 0) this.primary?.saveEnabledWork();
    this.#enabledWorkRefCount++;
  }

  notifyNodeEnabledState(): void {
    this.#enabledWorkRefCount--;
    if (this.#enabledWorkRefCount === 0) this.primary?.notifyNodeEnabledState();
  }

  notifyKeyDown(key: number, shift: number): number {
    if (this.focusedLayer) return this.focusedLayer.fireKeyDown(key, shift);
    return this.primary ? this.primary.defaultKeyDown(key, shift) : TJS_S_OK;
  }

  notifyKeyUp(key: number, shift: number): number {
    if (this.focusedLayer) return this.focusedLayer.fireKeyUp(key, shift);
    return this.primary ? this.primary.defaultKeyUp(key, shift) : TJS_S_OK;
  }

  notifyKeyPress(key: number): number {
    if (this.focusedLayer) return this.focusedLayer.fireKeyPress(key);
    return this.primary ? this.primary.defaultKeyPress(key) : TJS_S_OK;
  }

  notifyMouseWheel(shift: number, delta: number, x: number, y: number): number {
    return this.focusedLayer ? this.focusedLayer.fireMouseWheel(shift, delta, x, y) : TJS_S_OK;
  }

  // --- updating --------------------------------------------------------------------------------

  addUpdateRegion(region: TvpComplexRect | TvpRect): void {
    this.updateRegionForCompletion.or(region);
    if (
      region instanceof TvpComplexRect &&
      this.updateRegionForCompletion.count > TVP_UPDATE_UNITE_LIMIT
    )
      this.updateRegionForCompletion.unite();
    this.notifyWindowInvalidation();
  }

  updateToDrawDevice(): void {
    this.primary?.completeForWindow(this);
  }

  notifyUpdateRegionFixed(): void {}

  requestInvalidation(r: TvpRect): void {
    if (!this.primary) return;
    const ur = new TvpRect();
    const cr = new TvpRect(0, 0, this.primary.rect.width, this.primary.rect.height);
    if (intersectRect(ur, r, cr)) this.addUpdateRegion(ur);
  }

  recheckInputState(): number {
    return this.forceMouseRecheck();
  }

  dumpLayerStructure(): void {
    this.primary?.dumpStructure();
  }

  /** The layer under which the last mouse move was delivered. */
  get lastMouseMoveSent(): LayerNI | null {
    return this.#lastMouseMoveSent;
  }
}
