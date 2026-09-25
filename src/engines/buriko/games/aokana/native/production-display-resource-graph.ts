import type {RecordStore} from '../../../../../platform/store.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaChildWindowMetrics} from './child-windows.js';
import {AokanaChildWindows} from './child-windows.js';
import {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {AokanaBitmapLoadState} from './bitmap-load-state.js';
import {AokanaBitmapLoading} from './bitmap-loading.js';
import {AokanaBitmapRegistration} from './bitmap-registration.js';
import {AokanaBitmapCacheServices} from './bitmap-cache-services.js';
import {AokanaCompressedSurfaceEncoder} from './surface-compressed-encode.js';
import {AokanaDiskImagePixels} from './disk-image-pixels.js';
import {AokanaBitmapText} from './font-bitmap.js';
import {AokanaNativeClock} from './clock.js';
import {AokanaCpuProfile, type AokanaCpuHost} from './cpu-profile.js';
import {AokanaDataCodecWorkers} from './data-codec-workers.js';
import {AokanaCursorShapes} from './cursor-shapes.js';
import {AokanaCursorPolicy} from './cursor-policy.js';
import {
  AokanaBrowserCursorPosition,
  AokanaCursorFrameLower,
  AokanaNativeCursorMotion,
} from './cursor-motion.js';
import {AokanaDisplayAdapters, type AokanaConfiguredDisplayAdapter} from './display-adapters.js';
import {AokanaDisplayController} from './display-controller.js';
import {AokanaDisplayDamage} from './display-damage.js';
import {AokanaDisplayDevice} from './display-device.js';
import {AokanaDevicePower, type AokanaDevicePowerHost} from './device-power.js';
import {AokanaDisplayFrames} from './display-frames.js';
import {AokanaDisplayManager} from './display-manager.js';
import {AokanaDisplayMouseTrails} from './display-mouse-trails.js';
import {AokanaDisplayObjectEnvironment} from './display-object.js';
import {AokanaNativeDisplayState, type AokanaNativeRectangle} from './display-state.js';
import {AokanaDistributedAllocator} from './distributed-processing.js';
import {AokanaDroppedFiles} from './dropped-files.js';
import {AokanaEngineDialogs, AokanaNativeCursor} from './engine-dialogs.js';
import {AokanaAnsiUi} from './ansi-ui.js';
import {AokanaAnsiDialogs} from './ansi-dialogs.js';
import {AokanaEngineInitializedState} from './engine-initialized-state.js';
import {AokanaExternalMutexName} from './external-mutex-name.js';
import {AokanaFileChecksum} from './file-checksum.js';
import {AokanaFileEnumeration} from './file-enumeration.js';
import {AokanaFileSelectionService, type AokanaFileDialogHost} from './file-selection.js';
import {AokanaFolderSelectionService, type AokanaFolderDialogHost} from './folder-selection.js';
import {AokanaNativeFonts} from './fonts.js';
import {AokanaFontResources} from './font-resources.js';
import type {AokanaFontProvider} from './font-browser.js';
import {AokanaFrameMetrics} from './frame-metrics.js';
import {AokanaGroupDisplays} from './group-displays.js';
import {AokanaNativeGamepads, type AokanaNativeGamepadHost} from './gamepads.js';
import {AokanaMapDisplays} from './map-displays.js';
import {AokanaLandscapeDisplays} from './landscape-displays.js';
import {AokanaFilterDisplays} from './filter-displays.js';
import {AokanaImportedTextMaps} from './imported-text-maps.js';
import {AokanaInstallerManifestActions} from './installer-manifest-actions.js';
import {AokanaInstallerQueries} from './installer-queries.js';
import {AokanaInstallerShortcutCleanup} from './installer-shortcut-cleanup.js';
import {AokanaInternetReads, type AokanaInternetReadHost} from './internet-reads.js';
import {AokanaNativeInput} from './input.js';
import {AokanaInlineTextControl} from './inline-text-control.js';
import {AokanaKeyboardMessages} from './keyboard-messages.js';
import {AokanaLaunchSelection} from './launch-selection.js';
import {AokanaKnobDisplays} from './knob-displays.js';
import {AokanaLocalizedMessages} from './localized-messages.js';
import {AokanaMainWindowCallbackBinding} from './main-window-callbacks.js';
import {AokanaMainWindowMessageReceiver} from './main-window-messages.js';
import {AokanaMainWindowSizeEffects} from './main-window-size-effects.js';
import {AokanaMainDomInput} from './main-dom-input.js';
import type {AokanaMainWheelTranslator} from './main-mouse-input.js';
import {AokanaDiagnosticDialogs} from './modal.js';
import {AokanaFullscreenMovieState} from './movie-fullscreen-state.js';
import {AokanaMfMovieVolumePolicy} from './movie-mf-volume-policy.js';
import {AokanaMfMovieSourceCandidates} from './movie-mf-source-candidates.js';
import {AokanaMovieReferenceClock} from './movie-render-events.js';
import {AokanaMovieSourceDocument} from './movie-source-document.js';
import {AokanaMovieSources} from './movie-sources.js';
import {AokanaMovieVideoOnlySourceSelection} from './movie-video-only-source-selection.js';
import {AokanaMovieRegistry} from './movie-registry.js';
import {AokanaMovieFramePosition} from './movie-frame-position.js';
import {AokanaTraditionalMovieAudioPolicy} from './movie-traditional-audio-policy.js';
import {AokanaNativeNotifications} from './notification-queue.js';
import {AokanaNamedMutexes, type AokanaNamedMutexHost} from './named-mutexes.js';
import {AokanaModelessSettings} from './modeless-settings.js';
import {AokanaSelectionDialog} from './selection-dialog.js';
import {AokanaParticleDisplays} from './particle-displays.js';
import {AokanaParticleFrames} from './particle-frames.js';
import {AokanaParticleVariants} from './particle-images.js';
import {AokanaPathFileDirectory} from './path-file-directory.js';
import {AokanaPropertyEditors} from './property-editor.js';
import {AokanaProductKeyDialog} from './product-key-dialog.js';
import {AokanaRainDisplayState} from './display-rain.js';
import {AokanaRainDisplays} from './rain-displays.js';
import {AokanaRainFrames} from './rain-frames.js';
import {AokanaFocusedHotkeyRegistration, AokanaPrintScreenHotkeys} from './print-screen-hotkeys.js';
import {AokanaResourceFileServices} from './resource-file-services.js';
import {AokanaResourceFilePresence} from './resource-file-presence.js';
import {
  AokanaProductionResourceWorker,
  type AokanaProductionResourceWorkerInputs,
} from './production-resource-worker.js';
import {AokanaWindowMessages as AokanaWaitWindowMessages} from './procedure.js';
import {AokanaSurfaces} from './surfaces.js';
import {AokanaSurfaceEffects} from './surface-effects.js';
import {AokanaMonochromeSurfaceText} from './surface-monochrome-text.js';
import {AokanaSyntheticMouse} from './synthetic-mouse.js';
import {AokanaSpriteTargets} from './sprite-targets.js';
import {AokanaBrowserPerformanceCounter, AokanaThreadedCrtRandom} from './system-timing.js';
import {AokanaSystemTicks} from './system-ticks.js';
import {AokanaSystemProfile, type AokanaSystemProfileHost} from './system-profile.js';
import {aokanaDisplayRenderPixelBudget} from './startup-budget.js';
import {AokanaNativeText} from './text.js';
import {AokanaWindowMessages} from './window-messages.js';
import {AokanaQueuedMainPaint, AokanaQueuedWindowDispatcher} from './queued-window-dispatch.js';
import {AokanaWindowDisplayState} from './display-window-state.js';
import {AokanaWindowTitle} from './window-title.js';
import {AokanaNativeLanguage} from './group-81-language.js';
import {AokanaNativeRegistry} from './windows-registry.js';
import {AokanaSpecialFolders, type AokanaSpecialFolderProfile} from './special-folders.js';
import {AokanaShellShortcuts, type AokanaShellShortcutHost} from './shell-shortcuts.js';
import {AokanaBrowserMainWindow, type AokanaViewportScreenMapping} from './browser-main-window.js';

function validSpecialFolderProfile(value: unknown): value is AokanaSpecialFolderProfile {
  if (value === null || typeof value !== 'object') return false;
  const profile = value as Partial<AokanaSpecialFolderProfile>;
  const folder = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    const paths = value as Partial<AokanaSpecialFolderProfile['currentUser']>;
    return [paths.desktop, paths.programs, paths.documents, paths.profile].every(
      (path) => path === null || typeof path === 'string',
    );
  };
  return (
    typeof profile.shellAllocatorAvailable === 'boolean' &&
    (profile.windows === null || typeof profile.windows === 'string') &&
    (profile.programFiles === null || typeof profile.programFiles === 'string') &&
    folder(profile.currentUser) &&
    folder(profile.shellUser) &&
    typeof profile.elevated === 'boolean' &&
    typeof profile.shellTokenAvailable === 'boolean' &&
    typeof profile.debugPrivilegeAvailable === 'boolean' &&
    (profile.shellAccountName === null || typeof profile.shellAccountName === 'string')
  );
}

export interface AokanaProductionDisplayResourceGraphInputs {
  readonly document: Document;
  readonly parent: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly navigator: Navigator;
  readonly readViewportScreenMapping: () => AokanaViewportScreenMapping;
  /** Explicit host wheel-unit conversion; absent until a browser/device profile is selected. */
  readonly wheelTranslator?: AokanaMainWheelTranslator;
  readonly monitors: readonly AokanaNativeRectangle[];
  readonly selectedMonitor: number;
  readonly primaryMonitor: number;
  readonly clientOrigin: readonly [number, number];
  readonly adapters: readonly AokanaConfiguredDisplayAdapter[];
  readonly damageCapacity: number;
  readonly childMetrics: AokanaChildWindowMetrics;
  readonly nativeWindowTitle: Uint8Array;
  /** Selected raw caption after outer entry's optional file-version formatting. */
  readonly engineCaption?: Uint8Array | null;
  readonly preferredDialogTitle: Uint8Array | null;
  /** The selected PE group-106 CUR bytes; null only for a verified absent resource. */
  readonly cursorResource: Uint8Array | null;
  readonly performance: Pick<Performance, 'now'>;
  /** Explicit host SYSTEMTIME source for native data-codec workers. */
  readonly readSystemTime: () => Date;
  /** Explicit local SYSTEMTIME source for 80:0C; absent until selected by the host. */
  readonly readLocalTime?: (() => Date) | null;
  readonly cpuHost: AokanaCpuHost;
  /** Selected font host; the browser implementation is used when absent. */
  readonly fontProvider?: AokanaFontProvider;
  /** Explicit Win32 identity/version/memory primitives; absent in the partial graph by default. */
  readonly systemProfileHost?: AokanaSystemProfileHost | null;
  /** Explicit CreateFileW/GetDevicePowerState host, valid only with a selected system profile. */
  readonly devicePowerHost?: AokanaDevicePowerHost | null;
  /** Selected gamepad primitives; no ambient navigator polling is inferred. */
  readonly gamepadHost?: AokanaNativeGamepadHost | null;
  /** Explicit rand_s source; absent until the host supplies one. */
  readonly cryptoRandom?: Pick<Crypto, 'getRandomValues'> | null;
  /** Explicit synchronous named-mutex primitives; absent in the partial browser graph. */
  readonly namedMutexHost?: AokanaNamedMutexHost | null;
  /** Selected native file and folder picker; absent in the partial browser graph by default. */
  readonly pickerHost?: (AokanaFileDialogHost & AokanaFolderDialogHost) | null;
  /** Explicit ShellLink primitive; absent in the partial browser graph. */
  readonly shellShortcutHost?: AokanaShellShortcutHost | null;
  /** Explicit WinINet-shaped host; absent in the partial graph. */
  readonly internetReadHost?: AokanaInternetReadHost | null;
  readonly registryStore: RecordStore;
  /** Explicit mounted shell and account profile used by native folder queries. */
  readonly specialFolderProfile: AokanaSpecialFolderProfile;
  readonly readUserDefaultUiLanguage: () => number;
  readonly localizedText: Uint8Array | null;
  readonly processorCount: number;
  /** Native GetModuleFileNameW result, independent of the mutable selected resource root. */
  readonly executablePathWide: string;
  /** WinMain command-line tail, without the executable token. */
  readonly commandLineTailWide: string;
  readonly drop: {readonly mountedRoot: string; readonly nativeRoot: string};
  readonly resource: Omit<
    AokanaProductionResourceWorkerInputs,
    'text' | 'dialogs' | 'ticks' | 'allocator' | 'locks'
  >;
}

/** One partial production owner graph below the BP bank and GUI pump. */
export class AokanaProductionDisplayResourceGraph {
  readonly allocator: AokanaDistributedAllocator;
  readonly text: AokanaNativeText;
  readonly title: AokanaWindowTitle;
  readonly engineCaption: Uint8Array | null;
  readonly clock: AokanaNativeClock;
  readonly cpuHost: AokanaCpuHost;
  readonly readLocalTime: (() => Date) | null;
  readonly systemProfileHost: AokanaSystemProfileHost | null;
  readonly systemProfile: AokanaSystemProfile | null;
  readonly devicePowerHost: AokanaDevicePowerHost | null;
  readonly devicePower: AokanaDevicePower | null;
  readonly gamepadHost: AokanaNativeGamepadHost | null;
  readonly gamepads: AokanaNativeGamepads | null;
  readonly cryptoRandom: Pick<Crypto, 'getRandomValues'> | null;
  readonly namedMutexHost: AokanaNamedMutexHost | null;
  readonly namedMutexes: AokanaNamedMutexes | null;
  readonly pickerHost: (AokanaFileDialogHost & AokanaFolderDialogHost) | null;
  readonly shellShortcutHost: AokanaShellShortcutHost | null;
  readonly shellShortcuts: AokanaShellShortcuts | null;
  readonly internetReadHost: AokanaInternetReadHost | null;
  readonly internetReads: AokanaInternetReads | null;
  readonly fileSelection: AokanaFileSelectionService | null;
  readonly folderSelection: AokanaFolderSelectionService | null;
  readonly ticks: AokanaSystemTicks;
  readonly display: AokanaNativeDisplayState;
  readonly initialized: AokanaEngineInitializedState;
  readonly input: AokanaNativeInput;
  readonly messages: AokanaWindowMessages;
  readonly waits: AokanaWaitWindowMessages;
  readonly keyboard: AokanaKeyboardMessages;
  readonly focusedHotkeyRegistration: AokanaFocusedHotkeyRegistration;
  readonly printScreenHotkeys: AokanaPrintScreenHotkeys;
  readonly notifications: AokanaNativeNotifications;
  readonly fontProvider: AokanaFontProvider | null;
  readonly fonts: AokanaNativeFonts;
  readonly fontResources: AokanaFontResources;
  readonly compositor: AokanaBitmapCompositor;
  readonly damage: AokanaDisplayDamage;
  readonly surfaces: AokanaSurfaces;
  readonly diskImagePixels: AokanaDiskImagePixels;
  readonly monochromeText: AokanaMonochromeSurfaceText;
  readonly surfaceEffects: AokanaSurfaceEffects;
  readonly bitmapLoadState: AokanaBitmapLoadState;
  readonly bitmapLoading: AokanaBitmapLoading;
  readonly bitmapRegistration: AokanaBitmapRegistration;
  readonly bitmapCacheServices: AokanaBitmapCacheServices;
  readonly compressedSurfaceEncoder: AokanaCompressedSurfaceEncoder;
  readonly codecWorkers: AokanaDataCodecWorkers;
  readonly manager: AokanaDisplayManager;
  readonly groups: AokanaGroupDisplays;
  readonly maps: AokanaMapDisplays;
  readonly landscapes: AokanaLandscapeDisplays;
  readonly filterDisplays: AokanaFilterDisplays;
  readonly windowState: AokanaWindowDisplayState;
  readonly callbacks: AokanaMainWindowCallbackBinding;
  readonly host: AokanaBrowserMainWindow;
  readonly adapters: AokanaDisplayAdapters;
  readonly device: AokanaDisplayDevice;
  readonly cursor: AokanaNativeCursor;
  readonly cursorPolicy: AokanaCursorPolicy;
  readonly cursorPosition: AokanaBrowserCursorPosition;
  readonly cursorMotion: AokanaNativeCursorMotion;
  readonly cursorFrame: AokanaCursorFrameLower;
  readonly diagnosticDialogs: AokanaDiagnosticDialogs;
  readonly dialogs: AokanaEngineDialogs;
  readonly modelessSettings: AokanaModelessSettings;
  readonly ansiUi: AokanaAnsiUi;
  readonly ansiDialogs: AokanaAnsiDialogs;
  readonly productKeyDialog: AokanaProductKeyDialog;
  readonly selectionDialog: AokanaSelectionDialog;
  readonly registry: AokanaNativeRegistry;
  readonly folders: AokanaSpecialFolders;
  readonly localized: AokanaLocalizedMessages;
  readonly inline: AokanaInlineTextControl;
  readonly controller: AokanaDisplayController;
  readonly children: AokanaChildWindows;
  readonly properties: AokanaPropertyEditors;
  readonly fullscreenMovie: AokanaFullscreenMovieState;
  readonly mfMovieVolume: AokanaMfMovieVolumePolicy;
  readonly mfSourceCandidates: AokanaMfMovieSourceCandidates;
  readonly movieSources: AokanaMovieSources;
  readonly externalMutexName: AokanaExternalMutexName;
  readonly installerManifest: AokanaInstallerManifestActions;
  readonly installerQueries: AokanaInstallerQueries;
  readonly installerShortcutCleanup: AokanaInstallerShortcutCleanup;
  readonly traditionalMovieAudio: AokanaTraditionalMovieAudioPolicy;
  readonly movies: AokanaMovieRegistry;
  readonly movieFramePosition: AokanaMovieFramePosition;
  readonly frames: AokanaDisplayFrames;
  readonly resource: AokanaProductionResourceWorker;
  readonly fileChecksum: AokanaFileChecksum;
  readonly fileEnumeration: AokanaFileEnumeration;
  readonly resourceFileServices: AokanaResourceFileServices;
  readonly resourceFilePresence: AokanaResourceFilePresence;
  readonly pathDirectory: AokanaPathFileDirectory;
  readonly launchSelection: AokanaLaunchSelection;
  readonly particleRandom: AokanaThreadedCrtRandom;
  readonly rainState: AokanaRainDisplayState;
  readonly rain: AokanaRainDisplays;
  readonly rainFrames: AokanaRainFrames;
  readonly particleVariants: AokanaParticleVariants;
  readonly particles: AokanaParticleDisplays;
  readonly particleFrames: AokanaParticleFrames;
  readonly knobs: AokanaKnobDisplays;
  readonly spriteTargets: AokanaSpriteTargets;
  readonly syntheticMouse: AokanaSyntheticMouse;
  readonly cursorShapes: AokanaCursorShapes;
  readonly droppedFiles: AokanaDroppedFiles;
  readonly receiver: AokanaMainWindowMessageReceiver;
  readonly queuedPaint: AokanaQueuedMainPaint;
  readonly queuedDispatcher: AokanaQueuedWindowDispatcher;
  readonly sizeEffects: AokanaMainWindowSizeEffects;
  readonly domInput: AokanaMainDomInput;
  private phase: 'constructed' | 'starting' | 'running' | 'closed' = 'constructed';
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private initialRenderPixelBudget: number | null = null;
  private readonly pendingMovieDocuments = new Set<Promise<AokanaMovieSourceDocument | null>>();
  private readonly movieMilliseconds: () => number;

  constructor(inputs: AokanaProductionDisplayResourceGraphInputs) {
    const selected = inputs.monitors[inputs.selectedMonitor];
    if (
      selected === undefined ||
      inputs.monitors[inputs.primaryMonitor] === undefined ||
      !Number.isInteger(inputs.damageCapacity) ||
      inputs.damageCapacity <= 0 ||
      typeof inputs.readSystemTime !== 'function' ||
      (inputs.readLocalTime != null && typeof inputs.readLocalTime !== 'function') ||
      typeof inputs.executablePathWide !== 'string' ||
      inputs.executablePathWide.length === 0 ||
      typeof inputs.commandLineTailWide !== 'string' ||
      !validSpecialFolderProfile(inputs.specialFolderProfile)
    )
      throw new Error(
        'Aokana production display requires monitor, damage, launch and folder inputs',
      );
    const moviePerformance = inputs.performance;
    this.movieMilliseconds = () => moviePerformance.now();
    this.readLocalTime = inputs.readLocalTime ?? null;
    const rollback: (() => void)[] = [];
    try {
      this.allocator = new AokanaDistributedAllocator(inputs.processorCount);
      rollback.push(() => this.allocator.dispose());
      this.text = new AokanaNativeText();
      this.title = new AokanaWindowTitle(inputs.nativeWindowTitle);
      if (
        inputs.engineCaption != null &&
        (!(inputs.engineCaption instanceof Uint8Array) || inputs.engineCaption.indexOf(0) < 0)
      )
        throw new TypeError('Aokana engine caption requires selected NUL-terminated raw bytes');
      this.engineCaption = inputs.engineCaption?.slice() ?? null;
      this.clock = new AokanaNativeClock(() => inputs.performance.now());
      this.cpuHost = inputs.cpuHost;
      this.systemProfileHost = inputs.systemProfileHost ?? null;
      this.systemProfile =
        this.systemProfileHost === null ? null : new AokanaSystemProfile(this.systemProfileHost);
      this.devicePowerHost = inputs.devicePowerHost ?? null;
      if (
        this.devicePowerHost !== null &&
        (this.systemProfile === null ||
          typeof this.devicePowerHost !== 'object' ||
          typeof this.devicePowerHost.openDevice !== 'function' ||
          typeof this.devicePowerHost.queryDevicePowerState !== 'function' ||
          typeof this.devicePowerHost.closeDevice !== 'function')
      )
        throw new TypeError(
          'Aokana device-power host requires selected system and device primitives',
        );
      this.cryptoRandom = inputs.cryptoRandom ?? null;
      this.namedMutexHost = inputs.namedMutexHost ?? null;
      if (
        this.namedMutexHost !== null &&
        (typeof this.namedMutexHost !== 'object' ||
          typeof this.namedMutexHost.createOwned !== 'function' ||
          typeof this.namedMutexHost.release !== 'function' ||
          typeof this.namedMutexHost.close !== 'function')
      )
        throw new TypeError('Aokana named-mutex host requires selected synchronous primitives');
      this.namedMutexes =
        this.namedMutexHost === null ? null : new AokanaNamedMutexes(this.namedMutexHost);
      if (this.namedMutexes !== null) rollback.push(() => this.namedMutexes!.clear());
      this.pickerHost = inputs.pickerHost ?? null;
      if (
        this.pickerHost !== null &&
        (typeof this.pickerHost.selectOpenFile !== 'function' ||
          typeof this.pickerHost.selectSaveFile !== 'function' ||
          typeof this.pickerHost.selectFolder !== 'function')
      )
        throw new TypeError('Aokana picker host requires selected file and folder capabilities');
      this.shellShortcutHost = inputs.shellShortcutHost ?? null;
      if (
        this.shellShortcutHost !== null &&
        typeof this.shellShortcutHost.createShellLink !== 'function'
      )
        throw new TypeError('Aokana ShellLink host requires a selected creation primitive');
      this.internetReadHost = inputs.internetReadHost ?? null;
      if (
        this.internetReadHost !== null &&
        (typeof this.internetReadHost.read !== 'function' ||
          typeof this.internetReadHost.start !== 'function')
      )
        throw new TypeError('Aokana internet-read host requires selected read/start primitives');
      this.ticks = new AokanaSystemTicks(inputs.performance);
      this.display = new AokanaNativeDisplayState(
        selected[2] - selected[0],
        selected[3] - selected[1],
      );
      this.initialized = new AokanaEngineInitializedState();
      this.input = new AokanaNativeInput(this.display, this.clock);
      this.clock.bindSuspensionInput(this.input);
      this.messages = new AokanaWindowMessages(this.input);
      this.waits = new AokanaWaitWindowMessages();
      this.keyboard = new AokanaKeyboardMessages(this.messages);
      this.focusedHotkeyRegistration = new AokanaFocusedHotkeyRegistration(this.keyboard);
      this.printScreenHotkeys = new AokanaPrintScreenHotkeys(
        this.messages,
        this.focusedHotkeyRegistration,
      );
      this.notifications = new AokanaNativeNotifications();
      this.gamepadHost = inputs.gamepadHost ?? null;
      if (
        this.gamepadHost !== null &&
        (typeof this.gamepadHost !== 'object' ||
          typeof this.gamepadHost.open !== 'function' ||
          typeof this.gamepadHost.enumerateAttached !== 'function' ||
          typeof this.gamepadHost.close !== 'function')
      )
        throw new TypeError('Aokana gamepad host requires selected synchronous primitives');
      this.gamepads =
        this.gamepadHost === null
          ? null
          : new AokanaNativeGamepads(this.gamepadHost, this.input, this.notifications);
      if (this.gamepads !== null) rollback.push(() => this.gamepads!.shutdown());
      this.fontProvider = inputs.fontProvider ?? null;
      this.fonts = new AokanaNativeFonts(this.text, this.fontProvider ?? undefined);
      rollback.push(() => this.fonts.dispose());
      this.compositor = new AokanaBitmapCompositor();
      this.damage = new AokanaDisplayDamage(inputs.damageCapacity, {
        left: 0,
        top: 0,
        right: this.display.logicalWidth - 1,
        bottom: this.display.logicalHeight - 1,
      });
      this.surfaces = new AokanaSurfaces(this.fonts, this.compositor, this.allocator);
      this.diskImagePixels = new AokanaDiskImagePixels(this.surfaces);
      this.monochromeText = new AokanaMonochromeSurfaceText(this.surfaces);
      rollback.push(() => this.monochromeText.dispose());
      this.surfaceEffects = new AokanaSurfaceEffects(this.surfaces);
      this.bitmapLoadState = new AokanaBitmapLoadState(this.input, this.clock);
      this.manager = new AokanaDisplayManager(
        new AokanaDisplayObjectEnvironment(this.compositor, this.damage),
        this.surfaces,
        this.display,
      );
      this.groups = new AokanaGroupDisplays(this.manager);
      this.maps = new AokanaMapDisplays(this.manager);
      this.landscapes = new AokanaLandscapeDisplays(this.manager, this.input);
      this.filterDisplays = new AokanaFilterDisplays(this.manager);
      this.windowState = new AokanaWindowDisplayState(this.manager);
      rollback.push(() => this.manager.locks.script.dispose());
      rollback.push(() => this.manager.locks.engine.dispose());
      rollback.push(() => this.manager.locks.disposeEngine());
      rollback.push(() => this.manager.dispose());
      this.callbacks = new AokanaMainWindowCallbackBinding(this.display);
      this.host = new AokanaBrowserMainWindow(
        inputs.document,
        inputs.parent,
        inputs.canvas,
        this.manager,
        this.callbacks,
      );
      rollback.push(() => this.host.detachScopedWindow());
      this.host.bindViewportScreenMapping(inputs.readViewportScreenMapping);
      this.host.configureMonitorProfile(
        inputs.monitors,
        inputs.selectedMonitor,
        inputs.clientOrigin[0],
        inputs.clientOrigin[1],
      );
      // Validate the selected host geometry before borrowing it for adapter selection.
      this.host.readRestoredOuterScreenRectangle();
      this.adapters = new AokanaDisplayAdapters(
        this.display,
        inputs.adapters,
        inputs.primaryMonitor,
        () => this.host.readRestoredOuterScreenRectangle(),
      );
      this.device = new AokanaDisplayDevice(inputs.canvas, this.manager, this.clock, this.adapters);
      rollback.push(() => this.device.dispose());
      this.cursor = new AokanaNativeCursor(inputs.canvas);
      this.cursorPolicy = new AokanaCursorPolicy(this.manager, this.input, this.clock, this.cursor);
      this.cursorPosition = new AokanaBrowserCursorPosition();
      this.cursorMotion = new AokanaNativeCursorMotion(this.input, this.clock, this.cursorPosition);
      this.cursorFrame = new AokanaCursorFrameLower(this.cursorMotion, this.cursorPolicy);
      rollback.push(() => {
        this.cursorMotion.active = false;
        this.cursorPolicy.setCustom(0, 0, 0);
        this.cursor.setVisible(1);
      });
      this.diagnosticDialogs = new AokanaDiagnosticDialogs(inputs.document, inputs.parent);
      this.dialogs = new AokanaEngineDialogs(
        this.diagnosticDialogs,
        this.text,
        this.clock,
        this.input,
        this.cursor,
        this.device,
        this.display,
        inputs.preferredDialogTitle,
        this.title.bytes,
      );
      this.modelessSettings = new AokanaModelessSettings(
        inputs.document,
        inputs.parent,
        this.dialogs,
      );
      rollback.push(() => this.modelessSettings.disposeAll());
      this.selectionDialog = new AokanaSelectionDialog(this.dialogs, this.text);
      this.localized = new AokanaLocalizedMessages(
        this.text,
        new AokanaNativeLanguage(inputs.readUserDefaultUiLanguage),
        new AokanaImportedTextMaps(this.text),
      );
      this.localized.load(inputs.localizedText);
      this.fileSelection =
        this.pickerHost === null
          ? null
          : new AokanaFileSelectionService(this.dialogs, this.clock, this.host, this.pickerHost);
      this.folderSelection =
        this.pickerHost === null
          ? null
          : new AokanaFolderSelectionService(this.localized, this.host, this.pickerHost);
      this.ansiUi = new AokanaAnsiUi(this.text);
      this.ansiDialogs = new AokanaAnsiDialogs(
        inputs.document,
        inputs.parent,
        this.dialogs,
        this.ansiUi,
        this.localized.language,
      );
      this.productKeyDialog = new AokanaProductKeyDialog(
        inputs.document,
        inputs.parent,
        this.dialogs,
        this.text,
      );
      this.inline = new AokanaInlineTextControl(
        this.host,
        this.fonts,
        this.dialogs,
        this.messages,
        this.keyboard,
      );
      this.fullscreenMovie = new AokanaFullscreenMovieState();
      this.mfMovieVolume = new AokanaMfMovieVolumePolicy(this.fullscreenMovie);
      this.traditionalMovieAudio = new AokanaTraditionalMovieAudioPolicy();
      this.registry = new AokanaNativeRegistry(inputs.registryStore);
      this.controller = new AokanaDisplayController(
        this.manager,
        this.device,
        this.adapters,
        this.host,
        new AokanaCpuProfile(this.cpuHost, this.clock),
        this.ticks,
        new AokanaDisplayMouseTrails(this.registry, this.dialogs),
        this.localized,
        this.messages,
        this.fullscreenMovie,
        this.inline,
        this.notifications,
      );
      this.children = new AokanaChildWindows(
        inputs.document,
        inputs.parent,
        inputs.navigator,
        this.text,
        this.surfaces,
        this.compositor,
        new AokanaBitmapText(this.fonts, this.compositor),
        this.dialogs,
        this.messages,
        this.keyboard,
        inputs.childMetrics,
        this.title.bytes,
        inputs.canvas,
      );
      this.children.initialize();
      rollback.push(() => this.children.dispose());
      this.properties = new AokanaPropertyEditors(
        inputs.document,
        inputs.parent,
        this.text,
        this.messages,
        this.title.bytes,
      );
      rollback.push(() => this.properties.dispose());
      this.title.validateConsumers(this.dialogs, this.children, this.properties);
      this.movies = new AokanaMovieRegistry();
      this.surfaces.attachMovies(this.movies);
      this.movieFramePosition = new AokanaMovieFramePosition(this.surfaces, this.movies);
      this.frames = new AokanaDisplayFrames(
        this.manager,
        this.device,
        this.clock,
        this.ticks,
        new AokanaFrameMetrics(
          new AokanaBrowserPerformanceCounter(inputs.performance),
          this.clock,
          this.device,
        ),
        this.movies,
        this.fullscreenMovie,
        this.inline,
        this.children,
      );
      this.callbacks.bind(this.host, this.controller, this.frames);
      this.resource = new AokanaProductionResourceWorker({
        ...inputs.resource,
        text: this.text,
        dialogs: this.dialogs,
        ticks: this.ticks,
        allocator: this.allocator,
        locks: this.manager.locks,
      });
      rollback.push(() => this.resource.processing.dispose());
      this.internetReads =
        this.internetReadHost === null
          ? null
          : new AokanaInternetReads(this.resource.files, this.internetReadHost);
      this.devicePower =
        this.devicePowerHost === null
          ? null
          : new AokanaDevicePower(this.systemProfile!, this.resource.files, this.devicePowerHost);
      this.fontResources = new AokanaFontResources(this.fonts, this.resource.resources);
      rollback.push(() => {
        this.fonts.resetManager();
        this.fontResources.clear();
      });
      this.bitmapLoading = new AokanaBitmapLoading(
        this.surfaces,
        this.resource.loading,
        this.bitmapLoadState,
      );
      this.bitmapRegistration = new AokanaBitmapRegistration(this.resource.loading, this.surfaces);
      this.bitmapCacheServices = new AokanaBitmapCacheServices(
        this.bitmapLoading,
        this.bitmapRegistration,
      );
      this.compressedSurfaceEncoder = new AokanaCompressedSurfaceEncoder(
        this.surfaces,
        this.resource.processing,
        this.ticks,
      );
      this.codecWorkers = new AokanaDataCodecWorkers(inputs.readSystemTime);
      this.folders = new AokanaSpecialFolders(
        this.text,
        this.registry,
        this.resource.resources.configuration,
        inputs.specialFolderProfile,
      );
      this.resource.files.specialFolders = this.folders;
      this.shellShortcuts =
        this.shellShortcutHost === null
          ? null
          : new AokanaShellShortcuts(this.resource.files, this.folders, this.shellShortcutHost);
      this.fileChecksum = new AokanaFileChecksum(this.resource.resources);
      this.fileEnumeration = new AokanaFileEnumeration(this.resource.files);
      this.resourceFileServices = new AokanaResourceFileServices(this.resource.resources);
      this.resourceFilePresence = new AokanaResourceFilePresence(
        this.resource.resources,
        this.localized,
      );
      this.pathDirectory = new AokanaPathFileDirectory(this.resource.files);
      this.launchSelection = new AokanaLaunchSelection(
        this.resource.files,
        inputs.resource.paths,
        this.resource.resources,
        this.resource.errors,
        this.text,
        inputs.executablePathWide,
        inputs.commandLineTailWide,
      );
      this.movieSources = new AokanaMovieSources(this.resource.resources);
      this.mfSourceCandidates = new AokanaMfMovieSourceCandidates(this.resource.resources);
      this.externalMutexName = new AokanaExternalMutexName();
      this.installerManifest = new AokanaInstallerManifestActions(this.resource.resources);
      this.installerQueries = new AokanaInstallerQueries(
        this.registry,
        this.folders,
        this.resource.files,
      );
      this.installerShortcutCleanup = new AokanaInstallerShortcutCleanup(
        this.folders,
        this.resource.files,
      );
      this.particleRandom = new AokanaThreadedCrtRandom(() => this.allocator.currentActor);
      this.rainState = new AokanaRainDisplayState();
      this.rain = new AokanaRainDisplays(
        this.manager,
        this.rainState,
        this.particleRandom,
        this.ticks,
      );
      this.rainFrames = new AokanaRainFrames(this.rain, this.clock);
      this.particleVariants = new AokanaParticleVariants();
      this.particles = new AokanaParticleDisplays(
        this.manager,
        this.particleVariants,
        this.particleRandom,
        this.clock,
        this.resource.processing,
      );
      this.particleFrames = new AokanaParticleFrames(this.particles, this.clock);
      this.knobs = new AokanaKnobDisplays(this.manager, this.input, this.notifications);
      this.spriteTargets = new AokanaSpriteTargets(this.manager, this.input);
      this.cursorShapes = new AokanaCursorShapes(this.cursor, this.messages, inputs.cursorResource);
      rollback.push(() => this.cursorShapes.dispose());
      this.messages.createMainTarget();
      this.host.bindCloseControl(this.input, this.messages);
      this.droppedFiles = new AokanaDroppedFiles(
        inputs.canvas,
        this.messages,
        this.resource.files,
        inputs.resource.mounted,
        inputs.drop.mountedRoot,
        inputs.drop.nativeRoot,
      );
      rollback.push(() => this.droppedFiles.dispose());
      this.receiver = new AokanaMainWindowMessageReceiver(
        this.messages,
        this.waits,
        this.input,
        this.notifications,
        this.host,
        this.knobs,
        this.controller,
        this.cursorShapes,
        this.droppedFiles,
        {host: this.host, inline: this.inline},
      );
      this.queuedPaint = new AokanaQueuedMainPaint(
        this.messages,
        this.waits,
        this.initialized,
        this.device,
      );
      this.queuedDispatcher = new AokanaQueuedWindowDispatcher(this.messages, this.queuedPaint);
      this.syntheticMouse = new AokanaSyntheticMouse(this.input, this.messages);
      this.callbacks.bindReadyReceiver(this.host, this.receiver);
      this.messages.send('main', 1, 0, 0);
      this.sizeEffects = new AokanaMainWindowSizeEffects(this);
      this.domInput = new AokanaMainDomInput(
        this.host,
        this.input,
        this.messages,
        this.keyboard,
        inputs.wheelTranslator ?? null,
      );
      rollback.push(() => this.domInput.dispose());
      this.host.bindInputIngress(this.domInput);
    } catch (error) {
      for (const undo of rollback.reverse()) {
        try {
          undo();
        } catch {
          // Construction failure remains the error reported to the caller.
        }
      }
      // The private drop mount, if installed, lives with its caller-owned filesystem.
      throw error;
    }
  }

  /** Prepare F04B0's physical source as a bounded ISO document; no movie slot is changed. */
  async prepareMovieDocument(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
    maxBytes: number,
  ): Promise<AokanaMovieSourceDocument | null> {
    if (this.phase === 'closed' || this.closing !== null)
      throw new Error('Aokana production movie source graph is closed');
    const preparing = AokanaMovieSourceDocument.open(
      this.movieSources,
      archive,
      name,
      this.allocator,
      () => this.ticks.timeGetTime(),
      maxBytes,
    );
    this.pendingMovieDocuments.add(preparing);
    try {
      return await preparing;
    } finally {
      this.pendingMovieDocuments.delete(preparing);
    }
  }

  /** Every selected movie gets a fresh graph clock from this host performance source. */
  createMovieReferenceClock(): AokanaMovieReferenceClock {
    if (this.phase === 'closed' || this.closing !== null)
      throw new Error('Aokana production movie source graph is closed');
    return new AokanaMovieReferenceClock(this.movieMilliseconds);
  }

  /** Explicit video-only selection; this does not create a decoder or attach a surface movie. */
  async prepareVideoOnlySource(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
    maxDocumentBytes: number,
    videoTrackId: number,
  ): Promise<AokanaMovieVideoOnlySourceSelection | null> {
    return AokanaMovieVideoOnlySourceSelection.open(
      this,
      archive,
      name,
      maxDocumentBytes,
      videoTrackId,
    );
  }

  /** C3A90's selected CPU record and initial renderer budget, before B11F0 device setup. */
  prepareRenderPixelBudget(): number {
    if (this.phase !== 'constructed')
      throw new Error('Aokana initial renderer budget requires pre-device startup');
    if (this.device.isPresent() || this.manager.environment.displayContext !== null)
      throw new Error('Aokana initial renderer budget requires an unconfigured display');
    if (this.initialRenderPixelBudget !== null) return this.initialRenderPixelBudget;
    const cpu = this.controller.cpu;
    if (
      this.controller.manager !== this.manager ||
      this.controller.display !== this.display ||
      cpu.host !== this.cpuHost ||
      cpu.clock !== this.clock
    )
      throw new Error('Aokana initial renderer budget requires the shared CPU and display owners');
    if (!cpu.initialize()) throw new Error('Aokana CPU profile initialization did not complete');
    const budget = aokanaDisplayRenderPixelBudget(cpu, this.display);
    this.manager.setRenderPixelBudget(budget);
    this.initialRenderPixelBudget = budget;
    return budget;
  }

  start(options: {automatic?: boolean} = {}): Promise<void> {
    if (this.phase !== 'constructed' || this.closing !== null)
      return Promise.reject(new Error('Aokana production display/resource graph is already used'));
    this.phase = 'starting';
    const starting = this.resource.start(this.host, options).then(
      () => {
        this.phase = 'running';
      },
      async (error: unknown) => {
        this.phase = 'constructed';
        if (this.closing === null) {
          try {
            await this.shutdown();
          } catch {
            // Startup failure is the primary error.
          }
        }
        throw error;
      },
    );
    this.starting = starting;
    return starting;
  }

  /** Host owner shutdown after its caller quiesces direct resource/audio/script producers.
   * The absent BP/pump aggregate must enforce that admission boundary before calling this. */
  shutdown(): Promise<void> {
    // Codec workers may still borrow BP memory; close admission at ingress.
    const codecJoining = this.codecWorkers.closeAndJoin();
    const internetJoining = this.internetReads?.closeAndJoin() ?? Promise.resolve();
    const queuedJoining = this.queuedDispatcher.closeAndJoin();
    this.initialized.clearAtTeardownIngress();
    this.domInput.dispose();
    if (this.closing !== null) return this.closing;
    if (this.phase === 'closed') return Promise.resolve();
    if (this.phase === 'starting') {
      const starting = this.starting!;
      this.closing = starting.then(
        () => this.finishShutdown(true, codecJoining, internetJoining, queuedJoining),
        () => this.finishShutdown(false, codecJoining, internetJoining, queuedJoining),
      );
      return this.closing;
    }
    this.closing = this.finishShutdown(
      this.phase === 'running',
      codecJoining,
      internetJoining,
      queuedJoining,
    );
    return this.closing;
  }

  private async finishShutdown(
    running: boolean,
    codecJoining: Promise<void>,
    internetJoining: Promise<void>,
    queuedJoining: Promise<void>,
  ): Promise<void> {
    this.phase = 'closed';
    let firstError: unknown;
    let failed = false;
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    };
    await attempt(() => codecJoining);
    await attempt(() => queuedJoining);
    // Source preparation may be in an awaited physical file read when teardown enters.
    // Close admission above, then join those borrows before resource/allocator disposal.
    await Promise.allSettled([...this.pendingMovieDocuments]);
    await attempt(() => this.modelessSettings.disposeAll());
    await attempt(() => this.gamepads?.shutdown());
    await attempt(() => internetJoining);
    if (this.internetReads !== null && !this.internetReads.quiesced)
      throw new Error('Aokana graph shutdown retained internet-read BP borrowers');
    // Shutdown is one-shot; a failed host close remains on the owner for explicit retry.
    await attempt(() => this.namedMutexes?.clear());
    // The worker may still borrow the actual window during channel teardown.
    if (running) await attempt(() => this.resource.shutdown());
    await attempt(() => {
      this.cursorMotion.active = false;
      this.cursorPolicy.setCustom(0, 0, 0);
      this.cursor.setVisible(1);
    });
    await attempt(() => {
      if (this.messages.mainTarget() !== null) {
        // Host disposal is an explicit destroy, independent of script Close policy.
        this.messages.send('main', 2, 0, 0);
      }
    });
    await attempt(() => this.properties.dispose());
    await attempt(() => this.children.dispose());
    await attempt(() => {
      this.inline.close();
    });
    await attempt(() => this.droppedFiles.dispose());
    await attempt(() => this.cursorShapes.dispose());
    await attempt(() => this.knobs.dispose());
    await attempt(() => this.spriteTargets.clear());
    await attempt(() => this.movies.clear());
    await attempt(() => this.movies.joinAllRetirements());
    await attempt(() => this.particles.clearRefreshScheduleForProgram());
    await attempt(() => this.windowState.textLayout.customGlyphs.clear());
    await attempt(() => this.windowState.textLayout.clearOverlayFrames());
    await attempt(() => this.monochromeText.dispose());
    await attempt(() => this.device.dispose());
    await attempt(() => this.manager.dispose());
    await attempt(() => {
      this.fonts.resetManager();
      this.fontResources.clear();
    });
    await attempt(() => this.fonts.dispose());
    await attempt(() => this.resource.processing.dispose());
    await attempt(() => this.manager.locks.disposeEngine());
    await attempt(() => this.manager.locks.engine.dispose());
    await attempt(() => this.manager.locks.script.dispose());
    await attempt(() => this.allocator.dispose());
    if (failed) throw firstError;
  }
}
