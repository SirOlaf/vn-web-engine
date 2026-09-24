import {AokanaDisplayManager} from './display-manager.js';
import type {AokanaBitmap} from './bitmap.js';
import {aokanaChildDibPixels} from './child-bitmap.js';
import {aokanaDisplayScaleSize, aokanaDisplayViewport} from './display-geometry.js';
import type {AokanaNativeDisplayState, AokanaNativeRectangle} from './display-state.js';

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
  constructor(
    readonly document: Document,
    readonly parent: HTMLElement,
    readonly surface: HTMLCanvasElement,
    readonly manager: AokanaDisplayManager,
    readonly callbacks: AokanaMainWindowCallbacks,
  ) {}

  get display(): AokanaNativeDisplayState {
    return this.manager.displayState;
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
    );
    if (position !== null) this.applyPosition(...position);
    // HWND_NOTOPMOST. Flags 108/10a suppress copy/redraw; activation belongs to the message owner.
    this.parent.style.zIndex = 'auto';
  }

  /** b6ec0's borderless MoveWindow uses the raw selected desktop extent. It retains the
   * saved requested windowed size, and does not activate, paint, or recreate the device. */
  applyFullscreenGeometry(left: number, top: number, width: number, height: number): void {
    this.applyGeometry(width, height, 0, 0, 0x90000000);
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
  ): void {
    this.applyWindowStyle(styleValue);
    this.parent.style.position = 'absolute';
    this.parent.style.boxSizing = 'border-box';
    this.parent.style.width = `${(width + insetWidth) | 0}px`;
    this.parent.style.height = `${(height + insetHeight) | 0}px`;
    this.parent.style.visibility = (styleValue & 0x10000000) !== 0 ? 'visible' : 'hidden';
    this.surface.style.width = `${width | 0}px`;
    this.surface.style.height = `${height | 0}px`;
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
