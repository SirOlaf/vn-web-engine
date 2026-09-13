import {refinedReciprocal} from '../bp/opcodes/fixed.js';

export type AokanaNativeRectangle = readonly [number, number, number, number];

function truncateInt32(value: number): number {
  return !Number.isFinite(value) || value < -2147483648 || value >= 2147483648
    ? -2147483648
    : Math.trunc(value) | 0;
}

/** Native window/coordinate globals shared by input hit testing and the renderer. */
export class AokanaNativeDisplayState {
  readonly presetWidths = Uint32Array.from([
    320, 640, 800, 1024, 1024, 1280, 1280, 1920, 1920, 2560, 2560, 3840, 3840, 1600, 1366, 960,
  ]);
  readonly presetHeights = Uint32Array.from([
    240, 480, 600, 768, 576, 960, 720, 1440, 1080, 1920, 1440, 2880, 2160, 900, 768, 540,
  ]);
  selectedSizePreset = 2;
  selectedWindowParameter = 1; // DAT_1401c976c: second argument saved by 1400c1d50.
  requestedWidth = 0;
  requestedHeight = 0;
  useSizePreset = 0;
  displayMode = 0;
  displayFlag = 1; // 1c9118: native windowed-presentation flag, initialized to one.
  verticalSynchronization = 1; // 1c9114.
  frameInterval = 4; // 1c911c.
  presentationEnabled = 1; // 1c9134.
  continuousPresentation = 0; // 1e6c54.
  frameDeadline = 0; // 1e6c68, pauseable-clock DWORD.
  measuredDrawCount = 0; // 1e6c40.
  inlinePaintSuppression = 0; // 1e6c58.
  deviceChangePending = 0; // 1e6b2c.
  forcedDeviceChange = 0; // 1e6c5c.
  deviceChangeDeadline = 0; // 1e6c60, raw GetTickCount DWORD.
  delayedRedrawDeadline = 0; // 1e6c50, raw GetTickCount DWORD.
  modeChangePending = 0; // 1e6c74.
  geometryChanged = 0; // 1e6c6c; also selects MonitorFromWindow's default policy.
  geometryPreference = 0x80000000; // 1c9128, saved by b6d90.
  modalDepth = 0; // 1e65fc.
  scanlineHeight = 0; // 1e6ae4.
  scanlinesPerMillisecond = 0; // 1e6b20.
  desktopRefreshRate = 0; // 1e65f0, the cached D3DDISPLAYMODE field.
  desktopFormat = 0; // 1e65f4.
  pixelShaderVersion = 0; // 1e6594, cached from primary-adapter caps by b11f0.
  readonly adapterIdentifier = new Uint8Array(0x450); // 1e6600.
  physicalRasterStatus = 0; // 1e6b24, Caps bit17; separate from the virtual raster profile.
  fullscreen = 0;
  windowStyleOption = 0;
  resizeInProgress = 0;
  positionLock = 0; // DAT_140277fe4, set by 1400ff510.
  lastPresentMilliseconds = 0; // DAT_1401e6ae0, written after successful IDirect3DDevice9::Present.
  pointerStepX = 0; // DAT_1401e6a60, Q16.16 motion tolerance recomputed by 1400b2620.
  pointerStepY = 0;
  aspectWidth = 0;
  aspectHeight = 0;
  frameInsetWidth = 0;
  frameInsetHeight = 0;
  ordinaryPresentationEnabled = 1; // DAT_1401c9120, temporarily changed by the shake procedure.
  windowMoveImmediate = 0; // DAT_140277f98.
  readonly pendingWindowPosition: [number, number] = [0, 0]; // DAT_140277fa0.
  windowPositionPending = 0; // DAT_140277fe0.
  monitors: AokanaNativeRectangle[] = []; // Monitor rectangles populated by the window host.
  readonly desktopOrigin: [number, number] = [0, 0];
  readonly windowClientOrigin: [number, number] = [0, 0];
  windowX = 0;
  windowY = 0;

  constructor(
    public desktopWidth: number,
    public desktopHeight: number,
  ) {}

  get logicalWidth(): number {
    const width = this.presetWidths[this.selectedSizePreset >>> 0];
    if (width === undefined) throw new RangeError('Aokana native display preset outside table');
    return width;
  }
  get logicalHeight(): number {
    const height = this.presetHeights[this.selectedSizePreset >>> 0];
    if (height === undefined) throw new RangeError('Aokana native display preset outside table');
    return height;
  }

  /** 1400b6e10 accepts signed negative dimensions; it rejects only zero. */
  setSizePreset(index: number, width: number, height: number): number {
    index >>>= 0;
    if (index > 15) return 1;
    if ((width | 0) === 0 || (height | 0) === 0) return 2;
    this.presetWidths[index] = width;
    this.presetHeights[index] = height;
    return 0;
  }

  /** 1400b2e50's native wide/tall desktop adjustment, including unsigned products. */
  adjustedDesktopSize(): readonly [number, number] {
    const width = this.desktopWidth >>> 0,
      height = this.desktopHeight >>> 0;
    if (width === 0 || height === 0) throw new Error('Aokana native display division by zero');
    const x = Math.floor(((width * 4) >>> 0) / height) > 9 ? width >>> 1 : width;
    const y =
      Math.floor(height / width) !== 0 && Math.floor(((height * 100) >>> 0) / width) < 125
        ? height >>> 1
        : height;
    return [x, y];
  }

  /** 1400b2b70 falls back to aspect-fit if native-size display cannot fit. */
  effectiveDisplayMode(): number {
    if (this.displayMode === 2) {
      const [width, height] = this.adjustedDesktopSize();
      if (width < this.logicalWidth || height < this.logicalHeight) return 0;
    }
    return this.displayMode >>> 0;
  }

  /** 1400b2620 runs when the display is configured; cursor polling reads the stored result. */
  refreshPointerStep(): void {
    const logicalWidth = this.logicalWidth,
      logicalHeight = this.logicalHeight;
    let width = this.requestedWidth >>> 0,
      height = this.requestedHeight >>> 0;
    if (this.fullscreen !== 0) {
      [width, height] = this.adjustedDesktopSize();
      const mode = this.effectiveDisplayMode();
      if (mode === 0) {
        const scale = Math.min(width / logicalWidth, height / logicalHeight) * 65536;
        const value =
          !Number.isFinite(scale) || scale < -(2 ** 63) || scale >= 2 ** 63
            ? 0
            : Number(BigInt.asUintN(32, BigInt(Math.trunc(scale))));
        this.pointerStepX = this.pointerStepY = value;
        return;
      }
      if (mode === 2) {
        this.pointerStepX = this.pointerStepY = 65536;
        return;
      }
      if (mode !== 1) return;
    }
    if (logicalWidth === 0 || logicalHeight === 0 || width === 0 || height === 0)
      throw new Error('Aokana native pointer tolerance division by zero');
    this.pointerStepX =
      width > logicalWidth
        ? Math.floor(((width << 16) >>> 0) / logicalWidth)
        : Math.floor(((logicalWidth << 16) >>> 0) / width);
    this.pointerStepY =
      height > logicalHeight
        ? Math.floor(((height << 16) >>> 0) / logicalHeight)
        : Math.floor(((logicalHeight << 16) >>> 0) / height);
  }

  /** 1400b2940, direction 0 game-to-client and direction 1 client-to-game. */
  transformPoint(x: number, y: number, direction: number): readonly [number, number] {
    x |= 0;
    y |= 0;
    const logicalWidth = this.logicalWidth,
      logicalHeight = this.logicalHeight;
    let width: number, height: number;
    if (this.fullscreen !== 0) {
      [width, height] = this.adjustedDesktopSize();
      const mode = this.effectiveDisplayMode();
      if (mode === 0) {
        const scale = Math.min(width / logicalWidth, height / logicalHeight);
        const left = ((width - truncateInt32(logicalWidth * scale)) | 0) >> 1;
        const top = ((height - truncateInt32(logicalHeight * scale)) | 0) >> 1;
        if (direction === 0)
          return [truncateInt32(left + x * scale), truncateInt32(top + y * scale)];
        if (direction === 1)
          return [truncateInt32(((x - left) | 0) / scale), truncateInt32(((y - top) | 0) / scale)];
        return [x, y];
      }
      if (mode !== 1) {
        if (mode === 2) {
          const left = (width - logicalWidth) >>> 1,
            top = (height - logicalHeight) >>> 1;
          if (direction === 0) return [(x + left) | 0, (y + top) | 0];
          if (direction === 1) return [(x - left) | 0, (y - top) | 0];
        }
        return [x, y];
      }
    } else {
      width = this.requestedWidth >>> 0;
      height = this.requestedHeight >>> 0;
    }
    if (direction === 0)
      return [
        truncateInt32((width * x) / logicalWidth),
        truncateInt32((height * y) / logicalHeight),
      ];
    if (direction === 1)
      return [
        truncateInt32((logicalWidth * x) / width),
        truncateInt32((logicalHeight * y) / height),
      ];
    return [x, y];
  }

  /** 1400ff580 preserves the selected SIMD reciprocal-seed profile. */
  setAspectSize(width: number, height: number): number {
    const nativeWidth = this.logicalWidth | 0,
      nativeHeight = this.logicalHeight | 0;
    width |= 0;
    height |= 0;
    if (width < 1 || height < 1) {
      width = nativeWidth;
      height = nativeHeight;
    }
    const nativeRatio = Math.fround(
      refinedReciprocal(Math.fround(nativeHeight)) * Math.fround(nativeWidth),
    );
    const requestedRatio = Math.fround(refinedReciprocal(Math.fround(height)) * Math.fround(width));
    if (Math.abs(Math.fround(nativeRatio - requestedRatio)) > 0.001) return 0x80000008;
    this.aspectWidth = width;
    this.aspectHeight = height;
    return 0;
  }
}
