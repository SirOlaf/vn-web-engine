import {AokanaDisplayManager} from './display-manager.js';
import type {AokanaBitmap} from './bitmap.js';
import {aokanaChildDibPixels} from './child-bitmap.js';
import {aokanaDisplayScaleSize, aokanaDisplayViewport} from './display-geometry.js';
import type {AokanaNativeDisplayState, AokanaNativeRectangle} from './display-state.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaWindowMessages} from './window-messages.js';
import type {AokanaMainDomInput} from './main-dom-input.js';
import {invalidateCanvasFrame} from '../../../../../graphics/canvas-frame-presenter.js';
import type {
  ViewportScreenMapping,
  WindowDisplayHost,
} from '../../../../../platform/window-display.js';

export interface AokanaMainWindowCallbacks {
  /** Native live-window gate 1e8d00, set by WM_CREATE and cleared by WM_DESTROY. */
  isReady(): boolean;
  /** Complete b7320(1,0,x,y): final-frame preparation, presentation, diagnostics, child redraw. */
  presentTransient(x: number, y: number): number | Promise<number>;
  /** Native 1e6c58 suppresses EDIT paint invalidation while the frame is already being drawn. */
  inlinePaintSuppressed(): boolean;
  /** b6d90 receives EDX=Y from B0 03's immediate-position branch (0d6038). */
  geometryChanged(y: number): void;
}

/** A live host mapping from viewport CSS pixels to the native monitor coordinate space. */
export type AokanaViewportScreenMapping = ViewportScreenMapping;

function nativeScreenEdge(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded < -0x80000000 || rounded > 0x7fffffff)
    throw new RangeError('Aokana window rectangle exceeds signed native screen coordinates');
  return rounded;
}

/** Exact DWORD monitor containment in 1400c6700. Monitor right/bottom remain exclusive OS edges. */
export function aokanaWindowPositionAllowed(
  display: AokanaNativeDisplayState,
  x: number,
  y: number,
): boolean {
  x |= 0;
  y |= 0;
  const width = display.requestedWidth | 0,
    height = display.requestedHeight | 0;
  return display.monitors.some(
    ([left, top, right, bottom]) =>
      x >= ((left - width + (width >>> 3)) | 0) &&
      x <= ((right - (width >> 3)) | 0) &&
      y >= ((top + (height >>> 3) - height) | 0) &&
      y <= ((bottom - (height >> 3)) | 0),
  );
}

/** 1400b6930 uses native signed truncation for each half and the actual nonclient origin. */
export function aokanaWindowCenteredPosition(
  display: AokanaNativeDisplayState,
): readonly [number, number] {
  if (display.fullscreen !== 0) return [0, 0];
  const [width, height] = display.adjustedDesktopSize();
  return [
    (Math.trunc(((width - display.requestedWidth - display.frameInsetWidth) | 0) / 2) +
      display.desktopOrigin[0]) |
      0,
    (Math.trunc(((height - display.requestedHeight) | 0) / 2) +
      display.desktopOrigin[1] +
      display.windowClientOrigin[1]) |
      0,
  ];
}

/** The concrete scoped browser window/DC for B0. The runtime retains descriptor/device/frame ownership.
 * It is constructed around that owner's existing canvas, never a second presentation surface. */
export class AokanaBrowserMainWindow {
  closePolicy = 1; // 1c945c: the executable's initialized DWORD is 1.
  closeMenuEnabled = true;
  private closeInput: AokanaNativeInput | null = null;
  private closeMessages: AokanaWindowMessages | null = null;
  private detached = false;
  private readScreenMapping: (() => AokanaViewportScreenMapping) | null = null;
  private lastRestoredOuterRectangle: AokanaNativeRectangle | null = null;
  private outerRectangleMinimized = false;
  private minimized = false;
  private inputIngress: AokanaMainDomInput | null = null;

  constructor(
    readonly document: Document,
    readonly parent: HTMLElement,
    readonly surface: HTMLCanvasElement,
    readonly manager: AokanaDisplayManager,
    readonly callbacks: AokanaMainWindowCallbacks,
    readonly presentationMode: 'canvas' | 'none' = 'canvas',
    readonly displayHost: WindowDisplayHost | null = null,
    readonly childWindowParent: HTMLElement = parent,
  ) {
    // The supplied canvas is the sole main client surface, even when the host
    // provides it detached. Keep an existing nested attachment in place.
    const owned =
      typeof parent.contains === 'function'
        ? parent.contains(surface)
        : Array.isArray(parent.children) && parent.children.includes(surface);
    if (!owned) parent.append(surface);
  }

  get display(): AokanaNativeDisplayState {
    return this.manager.displayState;
  }

  /** B2FD0's host primitive reads the actual scoped outer border box in screen coordinates. */
  bindViewportScreenMapping(read: () => AokanaViewportScreenMapping): void {
    if (this.readScreenMapping !== null)
      throw new Error('Aokana main window screen mapping is already bound');
    this.readScreenMapping = read;
  }

  /** Browser viewport position through the supplied live native-screen profile and canvas client edge. */
  mapCanvasViewportPoint(
    x: number,
    y: number,
  ): {
    readonly clientX: number;
    readonly clientY: number;
    readonly screenX: number;
    readonly screenY: number;
  } {
    if (this.detached || this.readScreenMapping === null)
      throw new Error('Aokana canvas pointer requires a live screen mapping');
    const mapping = this.readScreenMapping(),
      rect = this.surface.getBoundingClientRect();
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(mapping.originX) ||
      !Number.isFinite(mapping.originY) ||
      !Number.isFinite(mapping.nativePixelsPerCssX) ||
      !Number.isFinite(mapping.nativePixelsPerCssY) ||
      mapping.nativePixelsPerCssX <= 0 ||
      mapping.nativePixelsPerCssY <= 0 ||
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.right) ||
      !Number.isFinite(rect.bottom) ||
      rect.right <= rect.left ||
      rect.bottom <= rect.top
    )
      throw new RangeError('Aokana canvas pointer requires measured geometry and screen mapping');
    const screenX = nativeScreenEdge(mapping.originX + x * mapping.nativePixelsPerCssX),
      screenY = nativeScreenEdge(mapping.originY + y * mapping.nativePixelsPerCssY),
      left = nativeScreenEdge(mapping.originX + rect.left * mapping.nativePixelsPerCssX),
      top = nativeScreenEdge(mapping.originY + rect.top * mapping.nativePixelsPerCssY);
    return {
      clientX: nativeScreenEdge(screenX - left),
      clientY: nativeScreenEdge(screenY - top),
      screenX,
      screenY,
    };
  }

  private measureOuterScreenRectangle(): AokanaNativeRectangle {
    if (this.detached) throw new Error('Aokana main window has been detached');
    if (this.readScreenMapping === null)
      throw new Error('Aokana main window requires a viewport-to-screen mapping');
    const mapping = this.readScreenMapping(),
      measured = this.parent.getBoundingClientRect();
    if (
      !Number.isFinite(mapping.originX) ||
      !Number.isFinite(mapping.originY) ||
      !Number.isFinite(mapping.nativePixelsPerCssX) ||
      !Number.isFinite(mapping.nativePixelsPerCssY) ||
      mapping.nativePixelsPerCssX <= 0 ||
      mapping.nativePixelsPerCssY <= 0 ||
      !Number.isFinite(measured.left) ||
      !Number.isFinite(measured.top) ||
      !Number.isFinite(measured.right) ||
      !Number.isFinite(measured.bottom) ||
      measured.right <= measured.left ||
      measured.bottom <= measured.top
    )
      throw new RangeError(
        'Aokana main window requires a measured outer border box and screen mapping',
      );
    const left = nativeScreenEdge(mapping.originX + measured.left * mapping.nativePixelsPerCssX),
      top = nativeScreenEdge(mapping.originY + measured.top * mapping.nativePixelsPerCssY),
      right = nativeScreenEdge(mapping.originX + measured.right * mapping.nativePixelsPerCssX),
      bottom = nativeScreenEdge(mapping.originY + measured.bottom * mapping.nativePixelsPerCssY);
    if (right <= left || bottom <= top)
      throw new RangeError('Aokana main window outer rectangle collapses in native screen pixels');
    return [left, top, right, bottom];
  }

  /** MonitorFromWindow uses the last restored outer rectangle while iconic. */
  readRestoredOuterScreenRectangle(): AokanaNativeRectangle {
    if (this.detached) throw new Error('Aokana main window has been detached');
    if (this.outerRectangleMinimized) {
      if (this.lastRestoredOuterRectangle === null)
        throw new Error('Aokana minimized main window has no restored outer rectangle');
      return [...this.lastRestoredOuterRectangle];
    }
    const rectangle = this.measureOuterScreenRectangle();
    this.lastRestoredOuterRectangle = rectangle;
    return [...rectangle];
  }

  /** Call immediately before a later host minimize operation changes the scoped DOM layout. */
  captureOuterRectangleBeforeMinimize(): void {
    if (this.outerRectangleMinimized) return;
    this.lastRestoredOuterRectangle = this.measureOuterScreenRectangle();
    this.outerRectangleMinimized = true;
  }

  /** Call after a later host restore operation makes the scoped outer bounds measurable again. */
  refreshOuterRectangleAfterRestore(): void {
    const rectangle = this.measureOuterScreenRectangle();
    this.lastRestoredOuterRectangle = rectangle;
    this.outerRectangleMinimized = false;
  }

  get isMinimized(): boolean {
    return this.minimized;
  }

  /** Scoped CloseWindow profile: preserve the restored screen box before hiding this HWND. */
  minimizeScopedWindow(): boolean {
    if (!this.isLiveMainWindow() || this.minimized || this.parent.style.visibility === 'hidden')
      return false;
    this.captureOuterRectangleBeforeMinimize();
    this.minimized = true;
    this.setPresentationVisibility(false);
    if (this.closeInput !== null) this.closeInput.iconic = 1;
    this.refreshInputForeground();
    return true;
  }

  /** Host restore publishes IsIconic independently of the script latch and size tail. */
  restoreScopedWindow(): boolean {
    if (!this.isLiveMainWindow() || !this.minimized) return false;
    this.setPresentationVisibility(true);
    this.refreshOuterRectangleAfterRestore();
    this.minimized = false;
    if (this.closeInput !== null) this.closeInput.iconic = 0;
    this.refreshInputForeground();
    return true;
  }

  /** Current client extent in native screen pixels for WM_SIZE's packed lParam. */
  readClientNativeSize(): readonly [number, number] {
    if (this.readScreenMapping === null)
      throw new Error('Aokana main client requires a screen mapping');
    const rectangle = this.surface.getBoundingClientRect(),
      mapping = this.readScreenMapping(),
      width = nativeScreenEdge((rectangle.right - rectangle.left) * mapping.nativePixelsPerCssX),
      height = nativeScreenEdge((rectangle.bottom - rectangle.top) * mapping.nativePixelsPerCssY);
    if (width < 0 || height < 0)
      throw new RangeError('Aokana main client has a negative measured size');
    return [width, height];
  }

  /** Bind the native Close menu policy to the live HWND/message owners. */
  bindCloseMenu(input: AokanaNativeInput, messages: AokanaWindowMessages): void {
    if (
      input.display !== this.display ||
      messages.input !== input ||
      messages.mainTarget() === null
    )
      throw new Error('Aokana main Close menu requires the shared live main-window owners');
    if (this.closeInput !== null) {
      if (this.closeInput !== input || this.closeMessages !== messages)
        throw new Error('Aokana main Close menu is already bound to another owner');
      return;
    }
    this.closeInput = input;
    this.closeMessages = messages;
  }

  /** FF520 stores the raw DWORD even when inputActive suppresses its menu update. */
  setClosePolicy(value: number): void {
    if (this.closeInput === null)
      throw new Error('Aokana main Close policy has no live menu owner');
    this.closePolicy = value >>> 0;
    if (!this.closeInput.inputActive) this.setCloseMenuEnabled(this.closePolicy !== 0);
  }

  /** WM_SIZE restore/minimize may set menu state independently of the raw policy. */
  setCloseMenuEnabled(enabled: boolean): void {
    if (this.closeInput === null) throw new Error('Aokana main Close menu has no live owner');
    this.closeMenuEnabled = enabled;
  }

  /** FF770 WM_SIZE's menu/input tail, after separately owned initialized-engine effects. */
  applySizeMenuTail(fullWParam: number | bigint, input: AokanaNativeInput): void {
    if (
      this.closeInput !== input ||
      this.closeMessages === null ||
      this.closeMessages.input !== input ||
      this.closeMessages.mainTarget() === null ||
      this.detached
    )
      throw new Error('Aokana size menu tail requires the shared live main-window owners');
    if (fullWParam === 0 || fullWParam === 0n) {
      this.setCloseMenuEnabled(true);
      input.inputActive = true;
    } else if (fullWParam === 1 || fullWParam === 1n) {
      if (this.closePolicy === 0) this.setCloseMenuEnabled(false);
      input.inputActive = false;
    }
  }

  /** Script and host close producers enqueue WM_CLOSE regardless of the displayed menu state. */
  postClose(): void {
    const messages = this.closeMessages;
    if (messages === null) return;
    const target = messages.mainTarget();
    if (target !== null) messages.post({target, message: 0x10, wParam: 0, lParam: 0});
  }

  isLiveMainWindow(): boolean {
    return (
      !this.detached && this.callbacks.isReady() && this.closeMessages?.mainTarget() === 'main'
    );
  }

  /** FF690's scoped ShowWindow host primitive; UpdateWindow belongs to the awaited paint owner. */
  showWindow(visible: boolean, deferForegroundRefresh = false): boolean {
    if (!this.isLiveMainWindow()) return false;
    this.setPresentationVisibility(visible);
    if (!deferForegroundRefresh) this.refreshInputForeground();
    return true;
  }

  /** FF690 refreshes input foreground only after its synchronous UpdateWindow returns. */
  refreshInputForeground(): void {
    this.inputIngress?.refreshForeground();
  }

  private setPresentationVisibility(visible: boolean): void {
    const visibility = visible ? 'visible' : 'hidden';
    this.parent.style.visibility = visibility;
    this.childWindowParent.style.visibility = visibility;
  }

  /** GetForegroundWindow equals the live main HWND only while focus belongs to its DOM subtree. */
  isForegroundWindow(): boolean {
    if (
      !this.isLiveMainWindow() ||
      this.parent.style.visibility === 'hidden' ||
      this.document.visibilityState === 'hidden' ||
      !this.document.hasFocus()
    )
      return false;
    const active = this.document.activeElement;
    return active !== null && this.parent.contains(active);
  }

  /** Default WM_CLOSE removes only this title's scoped DOM after nested WM_DESTROY returns. */
  detachScopedWindow(): void {
    if (this.detached) return;
    this.inputIngress?.dispose();
    this.inputIngress = null;
    this.detached = true;
    this.setPresentationVisibility(false);
    this.parent.remove();
  }

  bindInputIngress(ingress: AokanaMainDomInput): void {
    if (this.detached || this.inputIngress !== null || ingress.host !== this)
      throw new Error('Aokana main input ingress requires the live scoped host');
    this.inputIngress = ingress;
  }

  /** The window-message owner calls this after its native display/monitor selection. */
  configureMonitorProfile(
    monitors: readonly AokanaNativeRectangle[],
    selected: number,
    clientOriginX: number,
    clientOriginY: number,
  ): void {
    const current = monitors[selected];
    if (current === undefined)
      throw new RangeError('Aokana main window requires an existing selected monitor');
    this.display.monitors = monitors.map(
      (rectangle) => [...rectangle] as unknown as AokanaNativeRectangle,
    );
    this.display.desktopOrigin[0] = current[0] | 0;
    this.display.desktopOrigin[1] = current[1] | 0;
    this.display.desktopWidth = (current[2] - current[0]) >>> 0;
    this.display.desktopHeight = (current[3] - current[1]) >>> 0;
    this.display.windowClientOrigin[0] = clientOriginX | 0;
    this.display.windowClientOrigin[1] = clientOriginY | 0;
  }

  /** Geometry-only host boundary; the native caller/message owner determines activation and redraw. */
  applyPosition(x: number, y: number): void {
    this.display.windowX = x | 0;
    this.display.windowY = y | 0;
    if (this.displayHost !== null) {
      this.displayHost.setPosition(x | 0, y | 0);
      return;
    }
    this.parent.style.left = `${x | 0}px`;
    this.parent.style.top = `${y | 0}px`;
  }

  /** b6ec0's SetWindowLong/SetWindowPos boundary. The caller has already selected the
   * requested client size; null position is SWP_NOMOVE. Canvas storage belongs to the device. */
  applyWindowedGeometry(
    clientWidth: number,
    clientHeight: number,
    position: readonly [number, number] | null,
    styleValue: number,
  ): void {
    this.display.requestedWidth = clientWidth >>> 0;
    this.display.requestedHeight = clientHeight >>> 0;
    this.applyGeometry(
      clientWidth,
      clientHeight,
      this.display.frameInsetWidth,
      this.display.frameInsetHeight,
      styleValue,
      false,
    );
    if (position !== null) this.applyPosition(...position);
    // HWND_NOTOPMOST. Flags 108/10a suppress copy/redraw; activation belongs to the message owner.
    this.parent.style.zIndex = 'auto';
  }

  /** b6ec0's borderless MoveWindow uses the raw selected desktop extent. It retains the
   * saved requested windowed size, and does not activate, paint, or recreate the device. */
  applyFullscreenGeometry(left: number, top: number, width: number, height: number): void {
    this.applyGeometry(width, height, 0, 0, 0x90000000, true);
    this.applyPosition(left, top);
  }

  /** B6CF0 changes GWL_STYLE on the current host without a SetWindowPos operation. */
  applyWindowStyle(styleValue: number): void {
    this.parent.setAttribute('data-aokana-window-style', (styleValue >>> 0).toString(16));
  }

  private applyGeometry(
    width: number,
    height: number,
    insetWidth: number,
    insetHeight: number,
    styleValue: number,
    fullscreen: boolean,
  ): void {
    this.applyWindowStyle(styleValue);
    this.parent.style.position = 'absolute';
    this.parent.style.boxSizing = 'border-box';
    this.parent.style.width = `${(width + insetWidth) | 0}px`;
    this.parent.style.height = `${(height + insetHeight) | 0}px`;
    this.setPresentationVisibility((styleValue & 0x10000000) !== 0);
    this.inputIngress?.refreshForeground();
    this.surface.style.width = `${width | 0}px`;
    this.surface.style.height = `${height | 0}px`;
    this.displayHost?.configure({
      width: (width + insetWidth) | 0,
      height: (height + insetHeight) | 0,
      fullscreen,
    });
  }

  center(): 0 | 1 {
    if (this.display.fullscreen !== 0) return 0;
    this.applyPosition(...aokanaWindowCenteredPosition(this.display));
    return 1;
  }
  move(x: number, y: number): 0 | 1 {
    if (this.display.fullscreen !== 0 || !aokanaWindowPositionAllowed(this.display, x, y)) return 0;
    if (this.display.windowMoveImmediate === 0) {
      this.display.pendingWindowPosition[0] = x | 0;
      this.display.pendingWindowPosition[1] = y | 0;
      this.display.windowPositionPending = 1;
    } else {
      this.applyPosition(x, y);
      this.callbacks.geometryChanged(y | 0);
    }
    return 1;
  }
  focus(): void {
    this.surface.focus();
  }

  /** SetWindowTextW: the selected browser profile maps the main caption to Document.title. */
  setCaption(value: string): boolean {
    if (!this.callbacks.isReady()) return false;
    this.document.title = value;
    return true;
  }

  blitSurface(x: number, y: number, index: number): 0 | 1 | 2 {
    if (!this.callbacks.isReady()) return 1;
    const bitmap = this.manager.surfaces.snapshot(index);
    if (bitmap === null) return 2;
    this.blitBitmap(x, y, bitmap);
    return 0;
  }

  /** b7390 transformed GDI path. Browser high-quality canvas resampling is the explicit
   * platform HALFTONE profile; descriptor reads, geometry and clipping remain title-native. */
  private blitBitmap(x: number, y: number, bitmap: AokanaBitmap): void {
    if (this.presentationMode === 'none') return;
    const pixels = aokanaChildDibPixels(bitmap);
    if (pixels === null) return;
    const [destinationX, destinationY] = this.display.transformPoint(x, y, 0);
    const [width, height] = aokanaDisplayScaleSize(this.display, bitmap.width, bitmap.height);
    const [left, top, right, bottom] = aokanaDisplayViewport(this.display);
    const source = this.document.createElement('canvas');
    source.width = bitmap.width;
    source.height = bitmap.height;
    const input = source.getContext('2d'),
      context = this.surface.getContext('2d');
    if (input === null || context === null)
      throw new Error('Aokana main window cannot acquire its drawing context');
    input.putImageData(new ImageData(pixels, bitmap.width, bitmap.height), 0, 0);
    context.save();
    context.beginPath();
    // CreateRectRgn consumes exclusive edges even though b27b0 supplied inclusive ones.
    context.rect(left, top, (right - left) | 0, (bottom - top) | 0);
    context.clip();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    invalidateCanvasFrame(this.surface);
    context.drawImage(source, destinationX, destinationY, width, height);
    context.restore();
  }

  invalidateInline(rectangle: AokanaNativeRectangle): void {
    if (!this.callbacks.isReady() || this.callbacks.inlinePaintSuppressed()) return;
    this.manager.environment.damage.record(0, {
      left: rectangle[0],
      top: rectangle[1],
      right: rectangle[2],
      bottom: rectangle[3],
    });
    this.manager.redraw.request(0);
  }
}
