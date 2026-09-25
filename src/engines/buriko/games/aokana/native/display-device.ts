import type {AokanaBitmapRectangle} from './bitmap.js';
import {AokanaNativeClock} from './clock.js';
import type {AokanaDisplayCapabilities} from './display-capabilities.js';
import {aokanaDisplayViewport} from './display-geometry.js';
import {AokanaDisplayManager} from './display-manager.js';
import type {AokanaNativeDisplayState} from './display-state.js';
import {AokanaDisplayTexture, aokanaDisplayTextureSize} from './display-texture.js';
import {AokanaScopedLock} from './scoped-lock.js';
import {
  AOKANA_PRESENTATION_NUMERICAL_PROFILE,
  aokanaCubicPresentationSample,
  aokanaPresentationLinearRgbInto,
  aokanaPresentationTextureSampleInto,
  type AokanaPresentationColor,
  type AokanaPresentationSampler,
} from './presentation-sampling.js';

/** The selected Windows-compatible adapter record, supplied by the title's host profile. */
export interface AokanaDisplayAdapterProfile {
  readonly pixelShaderVersion: number;
  readonly refreshRate: number;
  /** The configured adapter owner supplies the actual GetAdapterDisplayMode query. */
  queryDesktopMode?(): boolean;
}

/** b20e0's four XYZRHW/diffuse/UV vertices, each with the native 28-byte stride. */
export function aokanaPresentationVertices(display: AokanaNativeDisplayState): Uint8Array {
  const [physicalWidth, physicalHeight] = aokanaDisplayTextureSize(
    display.logicalWidth,
    display.logicalHeight,
  );
  const [left, top, right, bottom] = aokanaDisplayViewport(display);
  const x0 = Math.fround(Math.fround(left) - 0.5),
    y0 = Math.fround(Math.fround(top) - 0.5);
  const x1 = Math.fround(Math.fround((right + 1) | 0) - 0.5),
    y1 = Math.fround(Math.fround((bottom + 1) | 0) - 0.5);
  const u = Math.fround(Math.fround(display.logicalWidth) / Math.fround(physicalWidth));
  const v = Math.fround(Math.fround(display.logicalHeight) / Math.fround(physicalHeight));
  const bytes = new Uint8Array(112),
    output = new DataView(bytes.buffer);
  const vertices = [
    [x0, y0, 0, 0],
    [x1, y0, u, 0],
    [x0, y1, 0, v],
    [x1, y1, u, v],
  ];
  for (let index = 0; index < 4; index++) {
    const vertex = vertices[index]!,
      offset = index * 28;
    output.setFloat32(offset, vertex[0]!, true);
    output.setFloat32(offset + 4, vertex[1]!, true);
    output.setFloat32(offset + 8, 0, true);
    output.setFloat32(offset + 12, 1, true);
    output.setUint32(offset + 16, 0x00ffffff, true);
    output.setFloat32(offset + 20, vertex[2]!, true);
    output.setFloat32(offset + 24, vertex[3]!, true);
  }
  return bytes;
}

/**
 * Actual browser software display device. In canvas mode the one supplied main
 * canvas receives the completed buffer. In no-presentation mode the logical
 * device, textures and timing remain available without acquiring a 2D context.
 * No canvas image-quality setting substitutes for the native sampling paths.
 * The browser provides no physical scanline-status API.
 * Its explicit virtual raster is between atomic frame commits, while vertical
 * synchronization uses the actual browser RAF callback.
 */
export class AokanaDisplayDevice {
  readonly numericalProfile = AOKANA_PRESENTATION_NUMERICAL_PROFILE;
  readonly nativeLock: AokanaScopedLock; // The one 27caf0 DCLock, separate from engine/object locks.
  private context: CanvasRenderingContext2D | null = null;
  private frame: ImageData | null = null;
  private source: AokanaDisplayTexture | null = null; // 1e6af8, system memory.
  private sampled: AokanaDisplayTexture | null = null; // 1e6b10, default pool.
  private dynamic: AokanaDisplayTexture | null = null; // 1e65e0, movie transfer.
  private baseVertices: Uint8Array | null = null;
  private vertices: Uint8Array | null = null;
  private shader: {readonly profile: typeof AOKANA_PRESENTATION_NUMERICAL_PROFILE} | null = null;
  private sampler: AokanaPresentationSampler = 'point';
  private rasterValid = false;
  private rasterCubic = false;
  private rasterSampler: AokanaPresentationSampler = 'point';
  private readonly rasterVertices = new Uint8Array(112);
  private shifted = 0;
  private lost = false;
  private needsReset = false;
  private disposed = false;
  private logicalDeviceReady = false;
  dialogBoxMode = false;
  textureAlpha = 0; // 1e6a5c.
  filterMode = 0; // 1e6a58.

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly manager: AokanaDisplayManager,
    readonly clock: AokanaNativeClock,
    readonly adapter: AokanaDisplayAdapterProfile,
    readonly presentationMode: 'canvas' | 'none' = 'canvas',
  ) {
    if (presentationMode !== 'canvas' && presentationMode !== 'none')
      throw new TypeError('Aokana display requires a selected presentation mode');
    this.nativeLock = new AokanaScopedLock(() => manager.surfaces.allocator.currentActor);
    if (presentationMode === 'canvas') {
      canvas.addEventListener('contextlost', this.onContextLost);
      canvas.addEventListener('contextrestored', this.onContextRestored);
    }
  }
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
  };
  private readonly onContextRestored = (): void => {
    this.lost = false;
    this.needsReset = true;
  };
  get display(): AokanaNativeDisplayState {
    return this.manager.displayState;
  }
  get fullscreen(): number {
    return this.display.fullscreen; // The single authoritative native 1e6af4 field.
  }
  get refreshRate(): number {
    return this.adapter.refreshRate >>> 0 || 60;
  }
  get dynamicTexture(): AokanaDisplayTexture | null {
    return this.dynamic;
  }
  get rasterStatusAvailable(): boolean {
    return false;
  }
  /** Virtual-raster profile: between atomic commits, B3590 reports vertical blank. */
  readRasterScanline(_output: {scanline?: number}): number {
    return 0x81000000;
  }
  isPresent(): boolean {
    return (this.context !== null || this.logicalDeviceReady) && !this.disposed;
  }
  /** SetDialogBoxMode is independent of the native modal-depth owner. */
  refresh(dialogBoxMode: boolean): void {
    this.dialogBoxMode = dialogBoxMode;
  }

  /** b0f20: capability gate precedes creating the implemented title shader and replacement. */
  private createShader(): number {
    if (this.adapter.pixelShaderVersion >>> 0 < 0xffff0300) return 15;
    const shader = {profile: this.numericalProfile};
    this.releaseShader();
    this.shader = shader;
    return 0;
  }
  /** b1090. The resource is the reconstructed mathematics, not embedded GPU instructions. */
  private releaseShader(): void {
    this.shader = null;
  }
  /** b0ed0 keeps the previous mode and shader when capability selection fails. */
  setFilter(mode: number): 0 | 1 {
    mode >>>= 0;
    if (mode === 0 || mode === 2 || mode === 3) this.releaseShader();
    else if (mode === 1 || mode === 4) {
      if (this.createShader() !== 0) return 0;
    } else return 0;
    this.filterMode = mode;
    return 1;
  }
  /** b7220 is deliberately separate from descriptor reconfiguration, which clears attachment. */
  attachTexture(): void {
    this.manager.setDisplayTexture(this.source);
  }
  /** b23a0 preserves source -> attachment -> sampled -> dynamic creation order. */
  private createTextures(): number {
    if (!this.isPresent()) return 4;
    const [width, height] = aokanaDisplayTextureSize(
      this.display.logicalWidth,
      this.display.logicalHeight,
    );
    const format = this.textureAlpha !== 0 ? 21 : 22;
    this.source?.dispose();
    this.source = null;
    try {
      this.source = new AokanaDisplayTexture(width, height, format);
    } catch {
      return 5;
    }
    this.source.clearLogical(this.display.logicalWidth, this.display.logicalHeight);
    this.attachTexture();
    this.sampled?.dispose();
    this.sampled = null;
    try {
      this.sampled = new AokanaDisplayTexture(width, height, format);
    } catch {
      return 7;
    }
    this.dynamic?.dispose();
    this.dynamic = null;
    try {
      this.dynamic = new AokanaDisplayTexture(width, height, 22);
    } catch {
      return 9;
    }
    return 0;
  }
  /** b20e0 installs a copied base quad and resets the transient offset latch. */
  private createVertices(): number {
    if (!this.isPresent()) return 4;
    this.vertices = null;
    this.baseVertices = aokanaPresentationVertices(this.display);
    this.vertices = this.baseVertices.slice();
    this.shifted = 0;
    return 0;
  }
  private resizeBackBuffer(): void {
    const [width, height] =
      this.fullscreen !== 0
        ? [this.display.desktopWidth, this.display.desktopHeight]
        : [this.display.requestedWidth, this.display.requestedHeight];
    this.canvas.width = width;
    this.canvas.height = height;
    this.frame =
      this.presentationMode === 'canvas' ? this.context!.createImageData(width, height) : null;
    this.rasterValid = false;
  }
  /** B1CE0's attempt; the controller supplies the one concrete interface owner.
   * Direct device-level callers can exercise the software device without that outer interface. */
  create(fullscreen: number, capabilities: AokanaDisplayCapabilities | null = null): number {
    this.nativeLock.enter(); // b3080.
    try {
      if (capabilities === null) this.release();
      else {
        if (capabilities.device !== this)
          throw new Error('Aokana device creation requires its own shared interface');
        capabilities.release(); // b11b0 precedes Direct3DCreate9 on every attempt.
        if (!capabilities.create()) return 1;
      }
      if (this.presentationMode === 'canvas') {
        this.context = this.canvas.getContext('2d', {alpha: false});
        if (this.context === null) return 3;
      } else this.logicalDeviceReady = true;
      this.display.fullscreen = fullscreen | 0;
      if (this.adapter.queryDesktopMode?.() === false) return 2;
      this.resizeBackBuffer();
      let result = this.createTextures();
      if (result !== 0) return result;
      result = this.createVertices();
      if (result !== 0) return result;
      this.sampler = 'point';
      this.display.refreshPointerStep();
      this.lost = this.needsReset = false;
    } finally {
      this.nativeLock.leave(); // b30a0 precedes c6a50's scanline calibration.
    }
    // c6a50's actual no-physical-raster branch in this software device profile.
    this.display.scanlineHeight = (this.display.desktopHeight - 1) >>> 0;
    this.display.scanlinesPerMillisecond = Math.floor(
      (Math.imul(this.refreshRate, this.display.desktopHeight) >>> 0) / 1000,
    );
    this.nativeLock.enter();
    try {
      if (this.display.modalDepth > 0 && this.fullscreen === 1 && this.display.displayFlag === 0)
        this.refresh(true);
      this.setFilter(this.filterMode);
    } finally {
      this.nativeLock.leave();
    }
    return 0;
  }
  /** b1b70's release order differs from final device teardown. */
  reset(changeMode: number, fullscreen: number): number {
    this.nativeLock.enter();
    try {
      this.vertices = null;
      this.source?.dispose();
      this.source = null;
      this.sampled?.dispose();
      this.sampled = null;
      this.dynamic?.dispose();
      this.dynamic = null;
      this.releaseShader();
      if (changeMode !== 0) {
        this.display.fullscreen = fullscreen | 0;
        if (this.adapter.queryDesktopMode?.() === false) return 2;
      }
      if (this.lost) return 0x80000000;
      if (!this.isPresent()) return 0xfffffffe;
      this.resizeBackBuffer();
      this.sampler = 'point';
      let result = this.createTextures();
      if (result === 0) result = this.createVertices();
      if (result === 0) this.setFilter(this.filterMode);
      this.needsReset = false;
      return result;
    } finally {
      this.nativeLock.leave();
    }
  }
  /** b1b20 maps a successful reset to its distinct one-iteration reset notification. */
  cooperativeStatus(): number {
    if (!this.isPresent()) return 0xffffffff;
    if (this.lost) return 0x80000000;
    if (!this.needsReset) return 0;
    const result = this.reset(0, 0);
    return result === 0 ? 0x80000001 : result;
  }
  /** B6EC0's immediate black GDI fill affects the client surface, independently of textures. */
  clearWindowClient(): void {
    if (this.presentationMode === 'none') return;
    const context = this.canvas.getContext('2d', {alpha: false});
    if (context === null) return;
    context.save();
    context.resetTransform();
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'copy';
    context.fillStyle = '#000000';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.restore();
  }
  /** b1470 applies offsets to a fresh base copy whenever either current or prior offset is nonzero. */
  private moveQuad(x: number, y: number): void {
    x |= 0;
    y |= 0;
    if (this.shifted === 0 && x === 0 && y === 0) return;
    if (this.vertices === null || this.baseVertices === null)
      throw new Error('Aokana display quad is absent');
    const [left, top, right, bottom] = aokanaDisplayViewport(this.display);
    const dx = Math.fround(
      Math.fround(Math.fround((right - left + 1) | 0) * Math.fround(x)) /
        Math.fround(this.display.logicalWidth),
    );
    const dy = Math.fround(
      Math.fround(Math.fround((bottom - top + 1) | 0) * Math.fround(y)) /
        Math.fround(this.display.logicalHeight),
    );
    this.vertices.set(this.baseVertices);
    const view = new DataView(
      this.vertices.buffer,
      this.vertices.byteOffset,
      this.vertices.byteLength,
    );
    for (let offset = 0; offset < 112; offset += 28) {
      view.setFloat32(offset, Math.fround(view.getFloat32(offset, true) + dx), true);
      view.setFloat32(offset + 4, Math.fround(view.getFloat32(offset + 4, true) + dy), true);
    }
    this.shifted = x !== 0 || y !== 0 ? 1 : 0;
  }
  /** b1470: clear target, publish dirtiness, upload, sample the quad, end the completed scene. */
  prepare(
    count: number,
    rectangles: readonly AokanaBitmapRectangle[] | null,
    x: number,
    y: number,
  ): void {
    if (this.lost || !this.isPresent()) return;
    const source = this.source,
      sampled = this.sampled;
    if (source === null || sampled === null || this.vertices === null)
      throw new Error('Aokana display resources are absent');
    if (rectangles === null)
      source.addDirtyRectangle({
        left: 0,
        top: 0,
        right: this.display.logicalWidth - 1,
        bottom: this.display.logicalHeight - 1,
      });
    else
      for (let index = 0; index < count >>> 0; index++) {
        const rectangle = rectangles[index];
        if (rectangle === undefined)
          throw new RangeError('Aokana display damage count exceeds its supplied rectangles');
        source.addDirtyRectangle(rectangle);
      }
    const changed = sampled.updateFrom(source);
    let mode = this.filterMode;
    if (mode === 3 || mode === 4) mode = this.fullscreen === 0 ? 2 : mode === 3 ? 0 : 1;
    if (mode === 0 || mode === 2) this.sampler = mode === 0 ? 'linear' : 'point';
    if (mode === 1 && this.shader === null)
      throw new Error('Aokana presentation shader has not been created');
    this.moveQuad(x, y);
    if (this.frame !== null) {
      const cubic = mode === 1;
      const vertices = this.vertices!;
      let sameQuad = this.rasterValid;
      if (sameQuad)
        for (let index = 0; index < vertices.length; index++)
          if (vertices[index] !== this.rasterVertices[index]) {
            sameQuad = false;
            break;
          }
      if (!changed && sameQuad && this.rasterCubic === cubic && this.rasterSampler === this.sampler)
        return;
      this.rasterValid = false;
      const pixels = this.frame.data;
      pixels.fill(0);
      for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
      this.rasterizeQuad(sampled, cubic);
      this.rasterVertices.set(vertices);
      this.rasterCubic = cubic;
      this.rasterSampler = this.sampler;
      this.rasterValid = true;
    }
  }
  /** B31A0 draws the real movie texture without clearing or uploading ordinary display pixels. */
  drawMovieTexture(
    texture: AokanaDisplayTexture,
    widthMinusOne: number,
    heightMinusOne: number,
  ): void {
    if (this.lost || !this.isPresent()) return;
    if (this.vertices === null || this.baseVertices === null)
      throw new Error('Aokana movie draw uses an absent display quad');
    this.rasterValid = false;
    this.sampler = 'linear';
    const [width, height] = aokanaDisplayTextureSize(
      this.display.logicalWidth,
      this.display.logicalHeight,
    );
    this.vertices.set(this.baseVertices);
    const quad = new DataView(
      this.vertices.buffer,
      this.vertices.byteOffset,
      this.vertices.byteLength,
    );
    const u = Math.fround(Math.fround(widthMinusOne >>> 0) / Math.fround(width));
    const v = Math.fround(Math.fround(heightMinusOne >>> 0) / Math.fround(height));
    for (const [offset, value] of [
      [20, 0],
      [24, 0],
      [48, u],
      [52, 0],
      [76, 0],
      [80, v],
      [104, u],
      [108, v],
    ])
      quad.setFloat32(offset!, value!, true);
    this.shifted = 1;
    if (this.frame !== null) this.rasterizeQuad(texture, false);
  }
  private rasterizeQuad(sampled: AokanaDisplayTexture, cubic: boolean): void {
    const frame = this.frame!;
    const pixels = frame.data;
    const quad = new DataView(
      this.vertices!.buffer,
      this.vertices!.byteOffset,
      this.vertices!.byteLength,
    );
    const left = quad.getFloat32(0, true),
      top = quad.getFloat32(4, true),
      right = quad.getFloat32(28, true),
      bottom = quad.getFloat32(60, true);
    const uMax = quad.getFloat32(48, true),
      vMax = quad.getFloat32(80, true);
    const width = Math.fround(right - left),
      height = Math.fround(bottom - top);
    const firstX = Math.max(0, Math.ceil(left)),
      firstY = Math.max(0, Math.ceil(top));
    const lastX = Math.min(frame.width, Math.ceil(right)),
      lastY = Math.min(frame.height, Math.ceil(bottom));
    const frameWidth = frame.width;
    const logicalWidth = this.display.logicalWidth,
      logicalHeight = this.display.logicalHeight,
      sampler = this.sampler;
    const colorBuffer: AokanaPresentationColor = [0, 0, 0, 0];
    const sampleScratch = {
      a: [0, 0, 0, 0] as AokanaPresentationColor,
      b: [0, 0, 0, 0] as AokanaPresentationColor,
      c: [0, 0, 0, 0] as AokanaPresentationColor,
      d: [0, 0, 0, 0] as AokanaPresentationColor,
    };
    const frameRead = {validated: false};
    if (!cubic && lastX > firstX && lastY > firstY) {
      const columns = lastX - firstX;
      const sourceX = new Float64Array(columns);
      const fractionX = sampler === 'linear' ? new Float32Array(columns) : null;
      const textureWidth = Math.fround(sampled.width);
      const textureHeight = Math.fround(sampled.height);
      for (let column = firstX; column < lastX; column++) {
        const u = Math.fround(Math.fround(Math.fround(column - left) / width) * uMax);
        const x = Math.fround(Math.fround(u) * textureWidth);
        if (fractionX === null) sourceX[column - firstX] = Math.floor(x);
        else {
          const px = Math.fround(x - 0.5);
          const nx = Math.floor(px);
          sourceX[column - firstX] = nx;
          fractionX[column - firstX] = Math.fround(px - nx);
        }
      }
      const bytes = sampled.storage.bytes;
      for (let row = firstY; row < lastY; row++) {
        const v = Math.fround(Math.fround(Math.fround(row - top) / height) * vMax);
        const y = Math.fround(Math.fround(v) * textureHeight);
        const py = fractionX === null ? y : Math.fround(y - 0.5);
        const ny = Math.floor(py);
        const fy = Math.fround(py - ny);
        for (let column = firstX; column < lastX; column++) {
          const index = column - firstX;
          const nx = sourceX[index]!;
          const offset = (row * frameWidth + column) * 4;
          pixels[offset + 3] = 255;
          if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
            const u = Math.fround(Math.fround(Math.fround(column - left) / width) * uMax);
            aokanaPresentationTextureSampleInto(
              sampled,
              u,
              v,
              sampler,
              colorBuffer,
              sampleScratch,
              frameRead,
            );
            pixels[offset] = Math.fround(colorBuffer[0] * 255);
            pixels[offset + 1] = Math.fround(colorBuffer[1] * 255);
            pixels[offset + 2] = Math.fround(colorBuffer[2] * 255);
          } else if (fractionX !== null) {
            aokanaPresentationLinearRgbInto(
              sampled,
              nx,
              ny,
              fractionX[index]!,
              fy,
              colorBuffer,
              frameRead,
            );
            pixels[offset] = Math.fround(colorBuffer[0] * 255);
            pixels[offset + 1] = Math.fround(colorBuffer[1] * 255);
            pixels[offset + 2] = Math.fround(colorBuffer[2] * 255);
          } else if (nx >= 0 && ny >= 0 && nx < sampled.width && ny < sampled.height) {
            const sourceOffset = ny * sampled.pitch + nx * 4;
            if (!frameRead.validated) {
              sampled.storage.range(sourceOffset, 4, true);
              frameRead.validated = true;
            }
            pixels[offset] = bytes[sourceOffset + 2]!;
            pixels[offset + 1] = bytes[sourceOffset + 1]!;
            pixels[offset + 2] = bytes[sourceOffset]!;
          }
        }
      }
      return;
    }
    for (let row = firstY; row < lastY; row++) {
      const v = Math.fround(Math.fround(Math.fround(row - top) / height) * vMax);
      for (let column = firstX; column < lastX; column++) {
        const u = Math.fround(Math.fround(Math.fround(column - left) / width) * uMax);
        const color = cubic
          ? aokanaCubicPresentationSample(sampled, logicalWidth, logicalHeight, u, v, sampler)
          : aokanaPresentationTextureSampleInto(
              sampled,
              u,
              v,
              sampler,
              colorBuffer,
              sampleScratch,
              frameRead,
            );
        const offset = (row * frameWidth + column) * 4;
        pixels[offset + 3] = 255;
        // XRGB target discards output alpha; Uint8ClampedArray defines UNORM rounding.
        pixels[offset] = Math.fround(color[0] * 255);
        pixels[offset + 1] = Math.fround(color[1] * 255);
        pixels[offset + 2] = Math.fround(color[2] * 255);
      }
    }
  }
  /** b30c0: absent scanline timing leaves the wait count zero; successful commit records native time. */
  async present(output: {waitCount: number}): Promise<number> {
    if (!this.isPresent() || this.lost) return 0x80000000;
    if (this.presentationMode === 'none') {
      this.display.lastPresentMilliseconds = Number(BigInt.asUintN(32, this.clock.read()));
      output.waitCount = 0;
      return 0;
    }
    if (this.frame === null) return 0x80000000;
    if (this.display.verticalSynchronization !== 0) {
      const window = this.canvas.ownerDocument.defaultView;
      if (window === null) return 0x80000000;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    if (this.lost || this.context === null || this.frame === null) return 0x80000000;
    this.context.putImageData(this.frame, 0, 0);
    this.display.lastPresentMilliseconds = Number(BigInt.asUintN(32, this.clock.read()));
    output.waitCount = 0;
    return 0;
  }
  /** b11b0/b2040: shader, source, sampled, dynamic, quad, device. */
  release(): void {
    this.rasterValid = false;
    this.releaseShader();
    this.source?.dispose();
    this.source = null;
    this.sampled?.dispose();
    this.sampled = null;
    this.dynamic?.dispose();
    this.dynamic = null;
    this.vertices = this.baseVertices = null;
    this.frame = null;
    this.context = null;
    this.logicalDeviceReady = false;
  }
  dispose(): void {
    this.release();
    if (this.presentationMode === 'canvas') {
      this.canvas.removeEventListener('contextlost', this.onContextLost);
      this.canvas.removeEventListener('contextrestored', this.onContextRestored);
    }
    this.disposed = true;
  }
}
