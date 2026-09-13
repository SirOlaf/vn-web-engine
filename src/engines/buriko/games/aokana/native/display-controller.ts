import {AokanaDisplayManager} from './display-manager.js';
import {AokanaDisplayDevice} from './display-device.js';
import {AokanaDisplayAdapters} from './display-adapters.js';
import {AokanaBrowserMainWindow, aokanaWindowCenteredPosition} from './browser-main-window.js';
import {AokanaCpuProfile} from './cpu-profile.js';
import {aokanaDisplayRenderPixelBudget} from './startup-budget.js';
import {AokanaSystemTicks} from './system-ticks.js';
import {AokanaDisplayMouseTrails} from './display-mouse-trails.js';
import {AokanaLocalizedMessages} from './localized-messages.js';
import {AokanaNativeExit} from './engine-dialogs.js';
import {AokanaWindowMessages} from './window-messages.js';
import {AokanaFullscreenMovieState} from './movie-fullscreen-state.js';
import {AokanaInlineTextControl} from './inline-text-control.js';
import {AokanaNativeNotifications} from './notification-queue.js';
import {AokanaDisplayCapabilities} from './display-capabilities.js';

const retryKey = {
  bytes: new TextEncoder().encode('DIRECT3DINITIALIZINGFAILEDDOYOUWANTTOTRYAGAIN\0'),
  offset: 0,
};

/** Native B6EC0/B6A90 mode policy over the actual shared display, device and HWND owners. */
export class AokanaDisplayController {
  readonly capabilities: AokanaDisplayCapabilities;
  constructor(
    readonly manager: AokanaDisplayManager,
    readonly device: AokanaDisplayDevice,
    readonly adapters: AokanaDisplayAdapters,
    readonly host: AokanaBrowserMainWindow,
    readonly cpu: AokanaCpuProfile,
    readonly ticks: AokanaSystemTicks,
    readonly mouseTrails: AokanaDisplayMouseTrails,
    readonly localized: AokanaLocalizedMessages,
    readonly messages: AokanaWindowMessages,
    readonly fullscreenMovie: AokanaFullscreenMovieState,
    readonly inline: AokanaInlineTextControl,
    readonly notifications: AokanaNativeNotifications,
  ) {
    if (device.manager !== manager || host.manager !== manager || device.adapter !== adapters ||
        adapters.display !== manager.displayState)
      throw new Error('Aokana display controller requires the shared device, window and adapter owners');
    this.capabilities = new AokanaDisplayCapabilities(device, adapters);
  }
  get display() {
    return this.manager.displayState;
  }

  private async initializationError(key: string): Promise<0> {
    await this.mouseTrails.dialogs.show(
      this.localized.lookup({bytes: new TextEncoder().encode(key + '\0'), offset: 0}),
      new TextEncoder().encode('Error!!\0'),
      0x1010,
    );
    return 0;
  }

  /** B11F0 queries primary-adapter mode/identity/caps before any device creation.
   * Its retry deadline is the DWORD BGI elapsed clock, unlike B6A90's raw ticks. */
  async initialize(): Promise<0 | 1> {
    const capabilities = this.capabilities;
    let deadline = (Number(BigInt.asUintN(32, this.device.clock.read())) + 10000) >>> 0;
    let created = capabilities.create();
    for (;;) {
      if (!created) return this.initializationError('DIRECT3DINITIALIZINGFAILED');
      if (!capabilities.readMode(0, null))
        return this.initializationError('COULDNOTGETTHEDESKTOPRESOLUTION');
      if (!capabilities.readIdentifier(0, this.display.adapterIdentifier))
        this.display.adapterIdentifier.fill(0);
      const caps = {caps: 0, caps2: 0, pixelShaderVersion: 0},
        status = capabilities.readCapabilities(0, 1, caps);
      if ((status | 0) < 0) {
        if ((status >>> 0) !== 0x8876086a)
          return this.initializationError('COULDNOTGETTHEINFORMATIONOFDISPLAYADAPTOR');
        if (Number(BigInt.asUintN(32, this.device.clock.read())) < deadline)
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        else {
          if (await this.mouseTrails.dialogs.show(this.localized.lookup(retryKey), null, 0x124) !== 6)
            return 0;
          deadline = (Number(BigInt.asUintN(32, this.device.clock.read())) + 2000) >>> 0;
          capabilities.release();
        }
        created = capabilities.create();
        continue;
      }
      if ((caps.caps2 & 0x20000000) === 0)
        return this.initializationError('DISPLAYADAPTORDOESNOTSUPPORTREQUISITEFUNCTION');
      this.display.physicalRasterStatus = (caps.caps >>> 17) & 1;
      if ((capabilities.checkDeviceType(0, 1, 22, 22, 1) | 0) < 0 ||
          (capabilities.checkDeviceType(0, 1, 22, 22, 0) | 0) < 0)
        return this.initializationError('DISPLAYADAPTORDOESNOTSUPPORTREQUISITEPIXELFORMAT');
      if ((capabilities.checkDeviceFormat(0, 1, 22, 0x200, 3, 22) | 0) < 0)
        return this.initializationError('DISPLAYADAPTORDOESNOTSUPPORTREQUISITESURFACEFORMAT');
      this.display.pixelShaderVersion = caps.pixelShaderVersion >>> 0;
      return this.reconfigure(2, 1, 0, null, 1);
    }
  }

  /** B1CE0 retains ten concrete attempts, with Sleep(200) only between failed attempts. */
  async createDevice(fullscreen: number): Promise<number> {
    for (let remaining = 10; remaining !== 0;) {
      remaining--;
      const result = this.device.create(fullscreen, this.capabilities);
      if (result === 0 || remaining === 0) return result;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Aokana display creation loop exhausted without returning its status');
  }

  /** B6EC0 saves the logical mode before applying host geometry and rebuilding the actual device. */
  async reconfigure(
    preset: number,
    format: number,
    fullscreen: number,
    position: readonly [number, number] | null,
    forceCreate: number,
  ): Promise<1> {
    const display = this.display;
    if (display.resizeInProgress !== 0) return 1;
    display.resizeInProgress = 1;
    const width = display.presetWidths[preset >>> 0],
      height = display.presetHeights[preset >>> 0];
    if (width === undefined || height === undefined)
      throw new RangeError('Aokana reconfiguration reads beyond its logical-mode tables');
    if (this.device.fullscreen !== 0) this.device.clearWindowClient();
    display.selectedSizePreset = preset >>> 0;
    display.selectedWindowParameter = format >>> 0; // C1D50.
    if ((fullscreen | 0) === 0) {
      await this.mouseTrails.transition(0);
      const clientWidth = display.useSizePreset === 0 ? display.requestedWidth : width,
        clientHeight = display.useSizePreset === 0 ? display.requestedHeight : height,
        style = display.windowStyleOption === 0 ? 0x90ca0000 : 0x90ce0000;
      this.host.applyWindowedGeometry(clientWidth, clientHeight, position, style);
      // SetWindowPos flags108/10a do not include NOACTIVATE. Actual focus events
      // are routed through the shared HWND/input owner; this does not invent foreground state.
      this.host.focus();
      for (;;) {
        const result = forceCreate === 0 ? this.device.reset(1, 0) : await this.createDevice(0);
        if (result === 0) break;
        if (forceCreate === 0) forceCreate = 1;
        else if (await this.mouseTrails.dialogs.show(this.localized.lookup(retryKey), null, 0x124) !== 6)
          throw new AokanaNativeExit(0x7fffffff, 'Aokana display initialization retry declined');
      }
      if (display.windowMoveImmediate === 0) {
        this.adapters.readMonitorOrigin();
        const centered = aokanaWindowCenteredPosition(display);
        display.pendingWindowPosition[0] = centered[0];
        display.pendingWindowPosition[1] = centered[1];
        display.windowPositionPending = 1;
      } else {
        if (position === null) {
          this.adapters.readMonitorOrigin();
          this.host.center();
        }
        this.messages.invalidateAll();
      }
    } else {
      this.adapters.queryDesktopMode();
      const origin = this.adapters.readMonitorOrigin(),
        desktopWidth = display.desktopWidth,
        desktopHeight = display.desktopHeight;
      await this.mouseTrails.transition(1);
      this.host.applyFullscreenGeometry(origin[0], origin[1], desktopWidth, desktopHeight);
      this.device.clearWindowClient();
      const result = forceCreate === 0 ? this.device.reset(1, 1) : await this.createDevice(1);
      if (result !== 0) {
        display.resizeInProgress = 0;
        return this.reconfigure(preset, format, 0, null, 0);
      }
    }
    const budget = aokanaDisplayRenderPixelBudget(this.cpu, display);
    this.manager.configureDescriptor(width, height, format, budget);
    this.device.attachTexture();
    this.manager.redraw.request(1);
    display.resizeInProgress = 0;
    return 1;
  }

  /** B6D90's two actual stored globals; the caller supplies the saved native EDX value. */
  noteGeometryChange(preference: number): void {
    this.display.geometryPreference = preference >>> 0;
    this.display.geometryChanged = 1;
  }
  /** B6C40 only sets the pending request. */
  requestModeToggle(): void {
    this.display.modeChangePending = 1;
  }

  /** B6CF0 changes only the main window style, without SetWindowPos or redraw. */
  applyWindowStyle(): number {
    if (!this.messages.hasTarget('main')) return 0x80000003;
    this.host.applyWindowStyle(this.display.windowStyleOption === 0 ? 0x90ca0000 : 0x90ce0000);
    return 0;
  }
  /** B6CC0 stores the raw option and applies it immediately only in windowed mode. */
  setWindowStyle(value: number): void {
    this.display.windowStyleOption = value >>> 0;
    if (this.device.fullscreen === 0) this.applyWindowStyle();
  }

  private scheduleRedraw(): void {
    const delay = Math.floor(1000 / this.device.refreshRate);
    this.display.delayedRedrawDeadline = (this.ticks.getTickCount() + 1 + delay) >>> 0;
  }

  /** B6A90 runs after the main HWND pump; all deadlines here use raw GetTickCount. */
  async poll(): Promise<void> {
    const display = this.display;
    if (display.deviceChangePending !== 0 && this.ticks.getTickCount() >= (display.deviceChangeDeadline >>> 0)) {
      if (display.forcedDeviceChange !== 0) {
        const rectangle = this.adapters.readWindowRectangle();
        await this.reconfigure(
          display.selectedSizePreset, display.selectedWindowParameter, this.device.fullscreen,
          [rectangle[0], rectangle[1]], 1,
        );
        // Assembly reads the raw clock before clearing the forced flag.
        const delay = Math.floor(1000 / this.device.refreshRate),
          now = this.ticks.getTickCount();
        display.forcedDeviceChange = 0;
        display.delayedRedrawDeadline = (now + 1 + delay) >>> 0;
      } else if (this.device.fullscreen === 1 && this.capabilities.isPresent() && this.adapters.desktopSizeChanged()) {
        await this.reconfigure(
          display.selectedSizePreset, display.selectedWindowParameter, this.device.fullscreen, null, 0,
        );
        this.scheduleRedraw();
      }
      display.deviceChangePending = 0;
      display.deviceChangeDeadline = 0;
    }
    if (display.modeChangePending !== 0) {
      if (this.messages.input.foreground && this.fullscreenMovie.presentationFlag === 0 &&
          !this.fullscreenMovie.suppressesOrdinaryDisplay() && this.inline.target === null) {
        const result = await this.reconfigure(
          display.selectedSizePreset, display.selectedWindowParameter,
          Number(this.device.fullscreen === 0), null, 0,
        );
        if (result) this.notifications.push(1, this.device.fullscreen, 0);
      }
      display.modeChangePending = 0;
    }
    if (display.delayedRedrawDeadline !== 0 && this.ticks.getTickCount() >= (display.delayedRedrawDeadline >>> 0)) {
      this.manager.redraw.request(1);
      display.delayedRedrawDeadline = 0;
    }
  }
}
