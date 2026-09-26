import type {RecordStore} from '../../../platform/store.js';
import {BURIKO_ENGINE_1685, type BurikoEngineVersion} from './engine-version.js';
import {
  BrowserRasterTextPresentation,
  type BrowserTextMode,
} from '../../../text/browser-raster-text-presentation.js';
import type {WindowsGdiImageCodecHost} from '../../../platform/windows-gdi-image.js';
import {
  BROWSER_WINDOWS_WINDOW_TRANSITION_PROFILE,
  type WindowsWindowTransitionProfile,
} from '../../../platform/windows-window-transitions.js';
import {
  BrowserWindowsDisplayEnumerationHost,
  type WindowsDisplayEnumerationHost,
} from '../../../platform/windows-display-enumeration.js';
import {
  BrowserWindowsCharacterTranslationHost,
  type WindowsCharacterTranslationHost,
} from '../../../platform/windows-character-translation.js';
import {BrowserGdiImageCodec} from '../../../graphics/browser-gdi-image.js';
import {BrowserWindowsSystemProfileHost} from '../../../platform/browser-windows-system-profile.js';
import {BrowserWindowsProcessHost} from '../../../platform/browser-windows-process.js';
import {BrowserWindowsDynamicLibraryHost} from '../../../platform/windows-dynamic-library.js';
import {BrowserWindowsNamedMutexHost} from '../../../platform/windows-named-mutex.js';
import {BrowserWindowsLogicalDriveHost} from '../../../platform/windows-drives.js';
import {BrowserWindowsDevicePowerHost} from '../../../platform/windows-device-power.js';
import {BrowserWindowsShellLinkHost} from '../../../platform/windows-shell-link.js';
import {BrowserWindowsDesktopWallpaperHost} from '../../../platform/windows-desktop-wallpaper.js';
import {BrowserWindowsDialogPicker} from '../../../platform/windows-picker.js';
import {BrowserWindowsTemporaryFileHost} from '../../../platform/windows-temporary-file.js';
import {
  BrowserWindowsDirectoryNamespaceHost,
  type WindowsDirectoryNamespaceHost,
} from '../../../platform/windows-directory-namespace.js';
import {
  BrowserWindowsNamedFileMappingHost,
  type WindowsNamedFileMappingHost,
} from '../../../platform/windows-named-file-mapping.js';
import {BrowserCdAudioMediaHost} from '../../../audio/cd-media.js';
import {
  BrowserWindowsPlaySoundHost,
  type WindowsPlaySoundHost,
} from '../../../platform/windows-sound.js';
import {
  BrowserWindowsInstallerDialogHost,
  type WindowsInstallerDialogHost,
} from '../../../platform/windows-installer-dialogs.js';
import {
  BrowserWindowsTaskbarProgressHost,
  type WindowsTaskbarProgressHost,
} from '../../../platform/windows-taskbar-progress.js';
import {
  BrowserWindowsFileAssociationHost,
  type WindowsFileAssociationHost,
} from '../../../platform/windows-file-associations.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoChildWindowMetrics} from './child-windows.js';
import {BurikoChildWindows} from './child-windows.js';
import {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {BurikoBitmapLoadState} from './bitmap-load-state.js';
import {BurikoBitmapLoading} from './bitmap-loading.js';
import {BurikoBitmapRegistration} from './bitmap-registration.js';
import {BurikoBitmapCacheServices} from './bitmap-cache-services.js';
import {BurikoCompressedSurfaceEncoder} from './surface-compressed-encode.js';
import {BurikoDiskImagePixels} from './disk-image-pixels.js';
import {BurikoDiskImageService} from './disk-image-service.js';
import {BurikoBitmapText} from './font-bitmap.js';
import {BurikoBmvRegistry} from './bmv-registry.js';
import {BurikoBmvService} from './bmv-service.js';
import {BurikoBmvWorkerPump} from './bmv-worker-pump.js';
import {BurikoNativeClock} from './clock.js';
import {BurikoCpuProfile, type BurikoCpuHost} from './cpu-profile.js';
import {BurikoCdAudio, type BurikoCdMediaHost} from './cd-audio.js';
import {BurikoDataCodecWorkers} from './data-codec-workers.js';
import {BurikoCursorShapes} from './cursor-shapes.js';
import {BurikoCursorPolicy} from './cursor-policy.js';
import {
  BurikoBrowserCursorPosition,
  BurikoCursorFrameLower,
  BurikoNativeCursorMotion,
} from './cursor-motion.js';
import {BurikoDisplayAdapters, type BurikoConfiguredDisplayAdapter} from './display-adapters.js';
import {BurikoDisplayController} from './display-controller.js';
import {BurikoDisplayDamage} from './display-damage.js';
import {BurikoDisplayDevice} from './display-device.js';
import {BurikoDevicePower, type BurikoDevicePowerHost} from './device-power.js';
import {BurikoDeviceEnumerationRefresh} from './device-enumeration-refresh.js';
import {BurikoDisplayFrames} from './display-frames.js';
import {BurikoDisplayManager} from './display-manager.js';
import {BurikoDisplayMouseTrails} from './display-mouse-trails.js';
import {BurikoDisplayObjectEnvironment} from './display-object.js';
import {BurikoNativeDisplayState, type BurikoNativeRectangle} from './display-state.js';
import {BurikoDistributedAllocator, BurikoDistributedProcessing} from './distributed-processing.js';
import {BurikoDroppedFiles} from './dropped-files.js';
import {BurikoEngineDialogs, BurikoNativeCursor} from './engine-dialogs.js';
import {BurikoAnsiUi} from './ansi-ui.js';
import {BurikoAnsiDialogs} from './ansi-dialogs.js';
import {BurikoEngineInitializedState} from './engine-initialized-state.js';
import {BurikoExternalMutexName} from './external-mutex-name.js';
import {BurikoExternalProcessWindow} from './external-process-window.js';
import {BurikoExternalLibraries} from './external-libraries.js';
import type {WindowsDynamicLibraryHost} from '../../../platform/windows-dynamic-library.js';
import {
  BurikoExternalProcesses,
  type BurikoExternalProcessHost,
  type BurikoShellExecuteHost,
} from './external-process.js';
import {BurikoSecondaryMediaDiscovery, type BurikoLogicalDriveHost} from './secondary-media.js';
import {BurikoFileChecksum} from './file-checksum.js';
import {BurikoFileEnumeration} from './file-enumeration.js';
import {BurikoFileSelectionService, type BurikoFileDialogHost} from './file-selection.js';
import {BurikoFolderSelectionService, type BurikoFolderDialogHost} from './folder-selection.js';
import {BurikoNativeFonts} from './fonts.js';
import {BurikoFontResources} from './font-resources.js';
import {BurikoBrowserFonts, type BurikoFontProvider} from './font-browser.js';
import {BurikoFrameMetrics} from './frame-metrics.js';
import {BurikoGroupDisplays} from './group-displays.js';
import {BurikoGuiMessagePump} from './gui-message-pump.js';
import {BurikoNativeGamepads, type BurikoNativeGamepadHost} from './gamepads.js';
import {BurikoBrowserGamepads} from './browser-gamepads.js';
import {BurikoMapDisplays} from './map-displays.js';
import {BurikoLandscapeDisplays} from './landscape-displays.js';
import {BurikoFilterDisplays} from './filter-displays.js';
import {BurikoImportedTextMaps} from './imported-text-maps.js';
import {BurikoInstallerManifestActions} from './installer-manifest-actions.js';
import {BurikoInstallerDialogs} from './installer-dialogs.js';
import {BurikoInstallerQueries} from './installer-queries.js';
import {BurikoFileAssociations} from './file-associations.js';
import {BurikoInstallerShortcutCleanup} from './installer-shortcut-cleanup.js';
import {
  BURIKO_INTERNET_USER_AGENT,
  BurikoBrowserInternetReadHost,
  BurikoInternetReads,
  type BurikoInternetReadHost,
} from './internet-reads.js';
import {BurikoNativeInput} from './input.js';
import {BurikoInlineTextControl} from './inline-text-control.js';
import {BurikoKeyboardMessages} from './keyboard-messages.js';
import {BurikoLaunchSelection} from './launch-selection.js';
import {BurikoLegacy169FlashSurfaces} from './legacy-169-flash.js';
import {BrowserWindowsFlashHost, type WindowsFlashHost} from '../../../platform/windows-flash.js';
import {BurikoKnobDisplays} from './knob-displays.js';
import {BurikoLocalizedMessages} from './localized-messages.js';
import {BurikoMainWindowCallbackBinding} from './main-window-callbacks.js';
import {BurikoMainWindowMessageReceiver} from './main-window-messages.js';
import {BurikoMainWindowNonclientMotion} from './main-window-nonclient-motion.js';
import {BurikoMainWindowSizeEffects} from './main-window-size-effects.js';
import {BurikoMainWindowShowState} from './main-window-show-state.js';
import {BurikoMainWindowTransitions} from './main-window-transitions.js';
import {BurikoMainDomInput} from './main-dom-input.js';
import {BurikoBrowserTouchWindow} from './main-touch-input.js';
import {BurikoNativeTouch} from './touch-input.js';
import {BurikoBrowserTemporaryFileHost} from './temporary-directory-probe.js';
import type {BurikoMainWheelTranslator} from './main-mouse-input.js';
import {BurikoDiagnosticDialogs} from './modal.js';
import {BurikoFullscreenMovieState} from './movie-fullscreen-state.js';
import {BurikoMfMovieVolumePolicy} from './movie-mf-volume-policy.js';
import {BurikoMfMovieSourceCandidates} from './movie-mf-source-candidates.js';
import {BurikoMfMovieDocuments} from './movie-mf-document.js';
import {BurikoBrowserMfMovieSession} from './movie-mf-browser-session.js';
import {BurikoMovieReferenceClock} from './movie-render-events.js';
import {BurikoMovieSourceDocument} from './movie-source-document.js';
import {BurikoMovieSources} from './movie-sources.js';
import {BurikoMovieVideoOnlySourceSelection} from './movie-video-only-source-selection.js';
import {BurikoMovieRegistry} from './movie-registry.js';
import {BurikoMovieFramePosition} from './movie-frame-position.js';
import {BurikoMovieImageConfiguration} from './movie-image.js';
import {BurikoBrowserSurfaceMovieFactory} from './movie-browser-surface.js';
import {BurikoTraditionalMovieAudioPolicy} from './movie-traditional-audio-policy.js';
import {BurikoBrowserTraditionalMovieSession} from './movie-traditional-browser-graph.js';
import {BurikoNativeNotifications} from './notification-queue.js';
import {BurikoNamedMutexes, type BurikoNamedMutexHost} from './named-mutexes.js';
import {BurikoModelessSettings} from './modeless-settings.js';
import {BurikoSelectionDialog} from './selection-dialog.js';
import {BurikoParticleDisplays} from './particle-displays.js';
import {BurikoParticleFrames} from './particle-frames.js';
import {BurikoParticleVariants} from './particle-images.js';
import {BurikoPathFileDirectory} from './path-file-directory.js';
import {BurikoPlaySound} from './play-sound.js';
import {BurikoPropertyEditors} from './property-editor.js';
import {BurikoProductKeyDialog} from './product-key-dialog.js';
import {BurikoRainDisplayState} from './display-rain.js';
import {BurikoRainDisplays} from './rain-displays.js';
import {BurikoRainFrames} from './rain-frames.js';
import {BurikoFocusedHotkeyRegistration, BurikoPrintScreenHotkeys} from './print-screen-hotkeys.js';
import {BurikoResourceFileServices} from './resource-file-services.js';
import {BurikoResourceFilePresence} from './resource-file-presence.js';
import {
  BurikoProductionResourceWorker,
  type BurikoProductionResourceWorkerInputs,
} from './production-resource-worker.js';
import {BurikoWindowMessages as BurikoWaitWindowMessages} from './procedure.js';
import {BurikoSurfaces} from './surfaces.js';
import {BurikoSurfaceEffects} from './surface-effects.js';
import {BurikoMonochromeSurfaceText} from './surface-monochrome-text.js';
import {BurikoSyntheticMouse} from './synthetic-mouse.js';
import {BurikoSpriteTargets} from './sprite-targets.js';
import {BurikoBrowserPerformanceCounter, BurikoThreadedCrtRandom} from './system-timing.js';
import {BurikoSystemTicks} from './system-ticks.js';
import {BurikoSystemProfile, type BurikoSystemProfileHost} from './system-profile.js';
import {burikoDisplayRenderPixelBudget} from './startup-budget.js';
import {BurikoNativeText} from './text.js';
import {BurikoWindowMessages} from './window-messages.js';
import {
  BurikoQueuedMainPaint,
  BurikoQueuedMainSize,
  BurikoQueuedMainActivation,
  BurikoQueuedWindowDispatcher,
} from './queued-window-dispatch.js';
import {BurikoWindowDisplayState} from './display-window-state.js';
import {BurikoWallpaper, type BurikoDesktopWallpaperHost} from './wallpaper.js';
import {BurikoWindowTitle} from './window-title.js';
import {BurikoNativeLanguage} from './group-81-language.js';
import {BurikoNativeRegistry} from './windows-registry.js';
import {BurikoSpecialFolders, type BurikoSpecialFolderProfile} from './special-folders.js';
import {BurikoShellShortcuts, type BurikoShellShortcutHost} from './shell-shortcuts.js';
import {BurikoBrowserMainWindow, type BurikoViewportScreenMapping} from './browser-main-window.js';

function validSpecialFolderProfile(value: unknown): value is BurikoSpecialFolderProfile {
  if (value === null || typeof value !== 'object') return false;
  const profile = value as Partial<BurikoSpecialFolderProfile>;
  const folder = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    const paths = value as Partial<BurikoSpecialFolderProfile['currentUser']>;
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

export interface BurikoProductionDisplayResourceGraphInputs {
  readonly document: Document;
  readonly parent: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly displayHost?: import('../../../platform/window-display.js').WindowDisplayHost;
  /** Retain the logical device while suppressing all main-canvas presentation. */
  readonly presentationMode?: 'canvas' | 'none';
  readonly navigator: Navigator;
  readonly readViewportScreenMapping: () => BurikoViewportScreenMapping;
  /** Explicit host wheel-unit conversion; absent until a browser/device profile is selected. */
  readonly wheelTranslator?: BurikoMainWheelTranslator;
  /** Selected digitizer capability and browser compatibility-mouse policy. */
  readonly touchProfile?: {
    readonly available: boolean;
    readonly compatibilityMouse: 'owned';
  } | null;
  readonly monitors: readonly BurikoNativeRectangle[];
  readonly selectedMonitor: number;
  readonly primaryMonitor: number;
  readonly clientOrigin: readonly [number, number];
  readonly adapters: readonly BurikoConfiguredDisplayAdapter[];
  /** Selected monitor and D3D-adapter snapshot for delayed WM_DEVICECHANGE refresh. */
  readonly displayEnumerationHost?: WindowsDisplayEnumerationHost;
  /** Selected TranslateMessage layout bridge; browser default consumes exact DOM key evidence. */
  readonly characterTranslationHost?: WindowsCharacterTranslationHost;
  readonly damageCapacity: number;
  readonly childMetrics: BurikoChildWindowMetrics;
  readonly childWindowCoordinates?: import('../../../platform/browser-window-coordinates.js').WindowCoordinatesHost;
  readonly childWindowParent?: HTMLElement;
  readonly nativeWindowTitle: Uint8Array;
  /** Native product identifier recovered from the selected executable. */
  readonly productIdentity?: Uint8Array;
  readonly engineVersion?: BurikoEngineVersion;
  readonly windowsFlashHost?: WindowsFlashHost;
  /** Selected OS process/token/window/mutex primitives; no browser launch is inferred. */
  readonly externalProcessHost?: BurikoExternalProcessHost | null;
  /** Synchronous shell impersonation/execute primitives on that same selected host. */
  readonly shellExecuteHost?: BurikoShellExecuteHost | null;
  /** Selected synchronous native LoadLibraryA/export/call/FreeLibrary bridge. */
  readonly dynamicLibraryHost?: WindowsDynamicLibraryHost | null;
  /** Selected logical-drive enumeration, sharing the resource worker's drive-type host. */
  readonly logicalDriveHost?: BurikoLogicalDriveHost | null;
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
  readonly cpuHost: BurikoCpuHost;
  /** Selected font host; the browser implementation is used when absent. */
  readonly fontProvider?: BurikoFontProvider;
  /** Explicit Win32 identity/version/memory primitives; absent in the partial graph by default. */
  readonly systemProfileHost?: BurikoSystemProfileHost | null;
  /** Explicit CreateFileW/GetDevicePowerState host, valid only with a selected system profile. */
  readonly devicePowerHost?: BurikoDevicePowerHost | null;
  /** Selected gamepad primitives; no ambient navigator polling is inferred. */
  readonly gamepadHost?: BurikoNativeGamepadHost | null;
  /** Explicit rand_s source; absent until the host supplies one. */
  readonly cryptoRandom?: Pick<Crypto, 'getRandomValues'> | null;
  /** Explicit synchronous named-mutex primitives; absent in the partial browser graph. */
  readonly namedMutexHost?: BurikoNamedMutexHost | null;
  /** Selected native file and folder picker; absent in the partial browser graph by default. */
  readonly pickerHost?: (BurikoFileDialogHost & BurikoFolderDialogHost) | null;
  readonly namedFileMappingHost?: WindowsNamedFileMappingHost | null;
  readonly directoryNamespaceHost?: WindowsDirectoryNamespaceHost | null;
  /** Explicit ShellLink primitive; absent in the partial browser graph. */
  readonly shellShortcutHost?: BurikoShellShortcutHost | null;
  /** Explicit WinINet-shaped host; absent in the partial graph. */
  readonly internetReadHost?: BurikoInternetReadHost | null;
  /** Explicit removable CD medium owner; absent unless the application selects a disc. */
  readonly cdMediaHost?: BurikoCdMediaHost | null;
  /** Immediate PlaySoundW host; the browser profile reports synchronous failure. */
  readonly playSoundHost?: WindowsPlaySoundHost;
  /** Structured modal form host for installer selection. */
  readonly installerDialogHost?: WindowsInstallerDialogHost;
  readonly taskbarProgressHost?: WindowsTaskbarProgressHost;
  /** Selected disk codec profile for BMP, JPEG, GIF, TIFF and PNG. */
  readonly imageCodecHost?: WindowsGdiImageCodecHost;
  /** Maximum ISO source bytes materialized for browser surface movies. Defaults to 32-bit source limit. */
  readonly surfaceMovieDocumentByteBudget?: number;
  /** Maximum direct/archive bytes materialized by the browser MF session. */
  readonly mfMovieDocumentByteBudget?: number;
  /** Selected Win32 size/activation event order for scoped minimize and restore. */
  readonly windowTransitionProfile?: WindowsWindowTransitionProfile;
  readonly restoreContainer?: HTMLElement;
  readonly registryStore: RecordStore;
  /** Explicit HKCR-shaped registration host; defaults to the process-local browser profile. */
  readonly fileAssociationHost?: WindowsFileAssociationHost | null;
  /** Selected desktop wallpaper effect; absent in the browser graph by default. */
  readonly desktopWallpaperHost?: BurikoDesktopWallpaperHost | null;
  /** Explicit mounted shell and account profile used by native folder queries. */
  readonly specialFolderProfile: BurikoSpecialFolderProfile;
  readonly readUserDefaultUiLanguage: () => number;
  readonly localizedText: Uint8Array | null;
  readonly processorCount: number;
  /** Native GetModuleFileNameW result, independent of the mutable selected resource root. */
  readonly executablePathWide: string;
  /** WinMain command-line tail, without the executable token. */
  readonly commandLineTailWide: string;
  readonly drop: {readonly mountedRoot: string; readonly nativeRoot: string};
  readonly resource: Omit<
    BurikoProductionResourceWorkerInputs,
    'text' | 'dialogs' | 'ticks' | 'allocator' | 'locks'
  >;
}

/** One partial production owner graph below the BP bank and GUI pump. */
export class BurikoProductionDisplayResourceGraph {
  readonly allocator: BurikoDistributedAllocator;
  readonly text: BurikoNativeText;
  readonly title: BurikoWindowTitle;
  readonly productIdentity: Uint8Array;
  readonly engineVersion: BurikoEngineVersion;
  readonly engineCaption: Uint8Array | null;
  readonly clock: BurikoNativeClock;
  readonly threadSleep: (milliseconds: number) => Promise<void>;
  readonly cpuHost: BurikoCpuHost;
  readonly readLocalTime: (() => Date) | null;
  readonly systemProfileHost: BurikoSystemProfileHost | null;
  readonly systemProfile: BurikoSystemProfile | null;
  readonly legacy169Flash: BurikoLegacy169FlashSurfaces | null;
  readonly devicePowerHost: BurikoDevicePowerHost | null;
  readonly devicePower: BurikoDevicePower | null;
  readonly gamepadHost: BurikoNativeGamepadHost | null;
  readonly gamepads: BurikoNativeGamepads | null;
  readonly cryptoRandom: Pick<Crypto, 'getRandomValues'> | null;
  readonly namedMutexHost: BurikoNamedMutexHost | null;
  readonly namedMutexes: BurikoNamedMutexes | null;
  readonly pickerHost: (BurikoFileDialogHost & BurikoFolderDialogHost) | null;
  readonly namedFileMappingHost: WindowsNamedFileMappingHost | null;
  readonly directoryNamespaceHost: WindowsDirectoryNamespaceHost | null;
  readonly shellShortcutHost: BurikoShellShortcutHost | null;
  readonly shellShortcuts: BurikoShellShortcuts | null;
  readonly internetReadHost: BurikoInternetReadHost | null;
  readonly internetReads: BurikoInternetReads | null;
  readonly cdMediaHost: BurikoCdMediaHost | null;
  readonly cdAudio: BurikoCdAudio | null;
  readonly playSoundHost: WindowsPlaySoundHost;
  readonly playSound: BurikoPlaySound;
  readonly installerDialogHost: WindowsInstallerDialogHost;
  readonly taskbarProgressHost: WindowsTaskbarProgressHost;
  readonly installerDialogs: BurikoInstallerDialogs;
  readonly fileSelection: BurikoFileSelectionService | null;
  readonly folderSelection: BurikoFolderSelectionService | null;
  readonly ticks: BurikoSystemTicks;
  readonly display: BurikoNativeDisplayState;
  readonly initialized: BurikoEngineInitializedState;
  readonly input: BurikoNativeInput;
  readonly messages: BurikoWindowMessages;
  readonly waits: BurikoWaitWindowMessages;
  readonly keyboard: BurikoKeyboardMessages;
  readonly focusedHotkeyRegistration: BurikoFocusedHotkeyRegistration;
  readonly printScreenHotkeys: BurikoPrintScreenHotkeys;
  readonly notifications: BurikoNativeNotifications;
  readonly fontProvider: BurikoFontProvider | null;
  readonly fonts: BurikoNativeFonts;
  readonly fontResources: BurikoFontResources;
  readonly compositor: BurikoBitmapCompositor;
  readonly damage: BurikoDisplayDamage;
  readonly surfaces: BurikoSurfaces;
  readonly diskImagePixels: BurikoDiskImagePixels;
  readonly diskImageService: BurikoDiskImageService;
  readonly monochromeText: BurikoMonochromeSurfaceText;
  readonly surfaceEffects: BurikoSurfaceEffects;
  readonly bitmapLoadState: BurikoBitmapLoadState;
  readonly bitmapLoading: BurikoBitmapLoading;
  readonly bitmapRegistration: BurikoBitmapRegistration;
  readonly bitmapCacheServices: BurikoBitmapCacheServices;
  readonly compressedSurfaceEncoder: BurikoCompressedSurfaceEncoder;
  readonly codecWorkers: BurikoDataCodecWorkers;
  readonly manager: BurikoDisplayManager;
  readonly groups: BurikoGroupDisplays;
  readonly maps: BurikoMapDisplays;
  readonly landscapes: BurikoLandscapeDisplays;
  readonly filterDisplays: BurikoFilterDisplays;
  readonly windowState: BurikoWindowDisplayState;
  readonly callbacks: BurikoMainWindowCallbackBinding;
  readonly host: BurikoBrowserMainWindow;
  readonly adapters: BurikoDisplayAdapters;
  readonly device: BurikoDisplayDevice;
  readonly textPresentation = new BrowserRasterTextPresentation();
  readonly cursor: BurikoNativeCursor;
  readonly cursorPolicy: BurikoCursorPolicy;
  readonly cursorPosition: BurikoBrowserCursorPosition;
  readonly cursorMotion: BurikoNativeCursorMotion;
  readonly cursorFrame: BurikoCursorFrameLower;
  readonly diagnosticDialogs: BurikoDiagnosticDialogs;
  readonly dialogs: BurikoEngineDialogs;
  readonly modelessSettings: BurikoModelessSettings;
  readonly ansiUi: BurikoAnsiUi;
  readonly ansiDialogs: BurikoAnsiDialogs;
  readonly productKeyDialog: BurikoProductKeyDialog;
  readonly selectionDialog: BurikoSelectionDialog;
  readonly registry: BurikoNativeRegistry;
  readonly fileAssociationHost: WindowsFileAssociationHost;
  readonly fileAssociations: BurikoFileAssociations;
  readonly desktopWallpaperHost: BurikoDesktopWallpaperHost | null;
  readonly wallpaper: BurikoWallpaper | null;
  readonly folders: BurikoSpecialFolders;
  readonly localized: BurikoLocalizedMessages;
  readonly inline: BurikoInlineTextControl;
  readonly controller: BurikoDisplayController;
  readonly children: BurikoChildWindows;
  readonly properties: BurikoPropertyEditors;
  readonly fullscreenMovie: BurikoFullscreenMovieState;
  readonly mfMovieVolume: BurikoMfMovieVolumePolicy;
  readonly mfSourceCandidates: BurikoMfMovieSourceCandidates;
  readonly mfMovieDocuments: BurikoMfMovieDocuments;
  readonly mfMovieSession: BurikoBrowserMfMovieSession;
  readonly traditionalMovieSession: BurikoBrowserTraditionalMovieSession;
  readonly movieSources: BurikoMovieSources;
  readonly externalMutexName: BurikoExternalMutexName;
  readonly installerManifest: BurikoInstallerManifestActions;
  readonly installerQueries: BurikoInstallerQueries;
  readonly installerShortcutCleanup: BurikoInstallerShortcutCleanup;
  readonly traditionalMovieAudio: BurikoTraditionalMovieAudioPolicy;
  readonly movies: BurikoMovieRegistry;
  readonly movieFramePosition: BurikoMovieFramePosition;
  readonly movieImageConfiguration: BurikoMovieImageConfiguration;
  readonly surfaceMovieFactory: BurikoBrowserSurfaceMovieFactory;
  readonly frames: BurikoDisplayFrames;
  readonly deviceEnumeration: BurikoDeviceEnumerationRefresh;
  readonly resource: BurikoProductionResourceWorker;
  readonly bmvRegistry: BurikoBmvRegistry;
  readonly bmvAsyncProcessing: BurikoDistributedProcessing;
  readonly bmvService: BurikoBmvService;
  readonly bmvPump: BurikoBmvWorkerPump;
  readonly fileChecksum: BurikoFileChecksum;
  readonly fileEnumeration: BurikoFileEnumeration;
  readonly resourceFileServices: BurikoResourceFileServices;
  readonly resourceFilePresence: BurikoResourceFilePresence;
  readonly pathDirectory: BurikoPathFileDirectory;
  readonly launchSelection: BurikoLaunchSelection;
  readonly particleRandom: BurikoThreadedCrtRandom;
  readonly rainState: BurikoRainDisplayState;
  readonly rain: BurikoRainDisplays;
  readonly rainFrames: BurikoRainFrames;
  readonly particleVariants: BurikoParticleVariants;
  readonly particles: BurikoParticleDisplays;
  readonly particleFrames: BurikoParticleFrames;
  readonly knobs: BurikoKnobDisplays;
  readonly spriteTargets: BurikoSpriteTargets;
  readonly syntheticMouse: BurikoSyntheticMouse;
  readonly cursorShapes: BurikoCursorShapes;
  readonly droppedFiles: BurikoDroppedFiles;
  readonly receiver: BurikoMainWindowMessageReceiver;
  readonly nonclientMotion: BurikoMainWindowNonclientMotion;
  readonly queuedPaint: BurikoQueuedMainPaint;
  readonly queuedSize: BurikoQueuedMainSize;
  readonly queuedActivation: BurikoQueuedMainActivation;
  readonly queuedDispatcher: BurikoQueuedWindowDispatcher;
  readonly guiPump: BurikoGuiMessagePump;
  readonly showState: BurikoMainWindowShowState;
  readonly windowTransitions: BurikoMainWindowTransitions | null;
  readonly externalProcessWindow: BurikoExternalProcessWindow;
  readonly externalProcessHost: BurikoExternalProcessHost | null;
  readonly shellExecuteHost: BurikoShellExecuteHost | null;
  readonly externalProcesses: BurikoExternalProcesses | null;
  readonly dynamicLibraryHost: WindowsDynamicLibraryHost | null;
  readonly externalLibraries: BurikoExternalLibraries | null;
  readonly logicalDriveHost: BurikoLogicalDriveHost | null;
  readonly secondaryMedia: BurikoSecondaryMediaDiscovery | null;
  readonly sizeEffects: BurikoMainWindowSizeEffects;
  readonly domInput: BurikoMainDomInput;
  readonly touchWindow: BurikoBrowserTouchWindow | null;
  readonly touch: BurikoNativeTouch | null;
  private phase: 'constructed' | 'starting' | 'running' | 'closed' = 'constructed';
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private initialRenderPixelBudget: number | null = null;
  private displayInitialization: Promise<0 | 1> | null = null;
  private initializedDisplay = false;
  private readonly pendingMovieDocuments = new Set<Promise<BurikoMovieSourceDocument | null>>();
  private movieSourceResetting = false;
  private movieSourceGeneration = 0;
  private readonly movieMilliseconds: () => number;

  constructor(inputs: BurikoProductionDisplayResourceGraphInputs) {
    const selected = inputs.monitors[inputs.selectedMonitor];
    if (
      selected === undefined ||
      inputs.monitors[inputs.primaryMonitor] === undefined ||
      !Number.isInteger(inputs.damageCapacity) ||
      inputs.damageCapacity <= 0 ||
      typeof inputs.readSystemTime !== 'function' ||
      (inputs.touchProfile != null &&
        (typeof inputs.touchProfile.available !== 'boolean' ||
          inputs.touchProfile.compatibilityMouse !== 'owned')) ||
      (inputs.readLocalTime != null && typeof inputs.readLocalTime !== 'function') ||
      typeof inputs.executablePathWide !== 'string' ||
      inputs.executablePathWide.length === 0 ||
      typeof inputs.commandLineTailWide !== 'string' ||
      (inputs.surfaceMovieDocumentByteBudget !== undefined &&
        (!Number.isSafeInteger(inputs.surfaceMovieDocumentByteBudget) ||
          inputs.surfaceMovieDocumentByteBudget < 1 ||
          inputs.surfaceMovieDocumentByteBudget > 0xffffffff)) ||
      (inputs.mfMovieDocumentByteBudget !== undefined &&
        (!Number.isSafeInteger(inputs.mfMovieDocumentByteBudget) ||
          inputs.mfMovieDocumentByteBudget < 1 ||
          inputs.mfMovieDocumentByteBudget > 0xffffffff)) ||
      !validSpecialFolderProfile(inputs.specialFolderProfile)
    )
      throw new Error(
        'Buriko production display requires monitor, damage, launch and folder inputs',
      );
    const moviePerformance = inputs.performance;
    this.productIdentity = inputs.productIdentity?.slice() ?? Uint8Array.of(0);
    this.engineVersion = inputs.engineVersion ?? BURIKO_ENGINE_1685;
    this.movieMilliseconds = () => moviePerformance.now();
    this.readLocalTime =
      inputs.readLocalTime === undefined ? () => new Date() : inputs.readLocalTime;
    const rollback: (() => void)[] = [];
    try {
      rollback.push(() => this.textPresentation.dispose());
      this.allocator = new BurikoDistributedAllocator(inputs.processorCount);
      rollback.push(() => this.allocator.dispose());
      this.text = new BurikoNativeText();
      this.title = new BurikoWindowTitle(inputs.nativeWindowTitle);
      this.directoryNamespaceHost =
        inputs.directoryNamespaceHost === undefined
          ? new BrowserWindowsDirectoryNamespaceHost()
          : inputs.directoryNamespaceHost;
      if (
        this.directoryNamespaceHost !== null &&
        (typeof this.directoryNamespaceHost.fold !== 'function' ||
          typeof this.directoryNamespaceHost.list !== 'function')
      )
        throw new TypeError(
          'Buriko directory namespace host requires selected list/fold primitives',
        );
      if (
        inputs.engineCaption != null &&
        (!(inputs.engineCaption instanceof Uint8Array) || inputs.engineCaption.indexOf(0) < 0)
      )
        throw new TypeError('Buriko engine caption requires selected NUL-terminated raw bytes');
      this.engineCaption =
        inputs.engineCaption?.slice() ??
        new TextEncoder().encode(BURIKO_INTERNET_USER_AGENT + '\0');
      this.clock = new BurikoNativeClock(() => inputs.performance.now());
      this.threadSleep = inputs.resource.sleep;
      this.cpuHost = inputs.cpuHost;
      this.systemProfileHost =
        inputs.systemProfileHost === undefined
          ? new BrowserWindowsSystemProfileHost()
          : inputs.systemProfileHost;
      this.systemProfile =
        this.systemProfileHost === null ? null : new BurikoSystemProfile(this.systemProfileHost);
      this.devicePowerHost =
        inputs.devicePowerHost === undefined
          ? this.systemProfile === null
            ? null
            : new BrowserWindowsDevicePowerHost()
          : inputs.devicePowerHost;
      if (
        this.devicePowerHost !== null &&
        (this.systemProfile === null ||
          typeof this.devicePowerHost !== 'object' ||
          typeof this.devicePowerHost.openDevice !== 'function' ||
          typeof this.devicePowerHost.queryDevicePowerState !== 'function' ||
          typeof this.devicePowerHost.closeDevice !== 'function')
      )
        throw new TypeError(
          'Buriko device-power host requires selected system and device primitives',
        );
      this.cryptoRandom =
        inputs.cryptoRandom === undefined
          ? (inputs.document.defaultView?.crypto ?? globalThis.crypto ?? null)
          : inputs.cryptoRandom;
      this.namedMutexHost =
        inputs.namedMutexHost === undefined
          ? new BrowserWindowsNamedMutexHost()
          : inputs.namedMutexHost;
      if (
        this.namedMutexHost !== null &&
        (typeof this.namedMutexHost !== 'object' ||
          typeof this.namedMutexHost.createOwned !== 'function' ||
          typeof this.namedMutexHost.release !== 'function' ||
          typeof this.namedMutexHost.close !== 'function')
      )
        throw new TypeError('Buriko named-mutex host requires selected synchronous primitives');
      this.namedMutexes =
        this.namedMutexHost === null ? null : new BurikoNamedMutexes(this.namedMutexHost);
      if (this.namedMutexes !== null) rollback.push(() => this.namedMutexes!.clear());
      this.pickerHost =
        inputs.pickerHost === undefined
          ? new BrowserWindowsDialogPicker({
              document: inputs.document,
              parent: inputs.parent,
              files: inputs.resource.mounted,
              mounts: inputs.resource.paths.mountSnapshot(),
              decodeAnsi: (bytes) => this.text.decodeCp932(bytes),
              encodeAnsi: (value) => this.text.encodeWide(value, 0),
              isWritable: (path) => inputs.resource.mounted.volume(path)?.writable === true,
            })
          : inputs.pickerHost;
      if (
        this.pickerHost !== null &&
        (typeof this.pickerHost.selectOpenFile !== 'function' ||
          typeof this.pickerHost.selectSaveFile !== 'function' ||
          typeof this.pickerHost.selectFolder !== 'function')
      )
        throw new TypeError('Buriko picker host requires selected file and folder capabilities');
      this.shellShortcutHost =
        inputs.shellShortcutHost === undefined
          ? new BrowserWindowsShellLinkHost()
          : inputs.shellShortcutHost;
      if (
        this.shellShortcutHost !== null &&
        typeof this.shellShortcutHost.createShellLink !== 'function'
      )
        throw new TypeError('Buriko ShellLink host requires a selected creation primitive');
      this.internetReadHost =
        inputs.internetReadHost === undefined
          ? new BurikoBrowserInternetReadHost()
          : inputs.internetReadHost;
      if (
        this.internetReadHost !== null &&
        (typeof this.internetReadHost.read !== 'function' ||
          typeof this.internetReadHost.start !== 'function')
      )
        throw new TypeError('Buriko internet-read host requires selected read/start primitives');
      this.cdMediaHost =
        inputs.cdMediaHost === undefined ? new BrowserCdAudioMediaHost() : inputs.cdMediaHost;
      if (this.cdMediaHost !== null && typeof this.cdMediaHost.open !== 'function')
        throw new TypeError('Buriko CD host requires a selected medium-open primitive');
      this.cdAudio =
        this.cdMediaHost === null
          ? null
          : new BurikoCdAudio(this.cdMediaHost, (token) =>
              this.messages.postCdSuccessfulNotification(token),
            );
      if (this.cdAudio !== null) rollback.push(() => this.cdAudio!.dispose());
      this.ticks = new BurikoSystemTicks(inputs.performance);
      this.display = new BurikoNativeDisplayState(
        selected[2] - selected[0],
        selected[3] - selected[1],
      );
      this.initialized = new BurikoEngineInitializedState();
      this.input = new BurikoNativeInput(this.display, this.clock);
      this.clock.bindSuspensionInput(this.input);
      this.messages = new BurikoWindowMessages(this.input);
      this.waits = new BurikoWaitWindowMessages();
      this.keyboard = new BurikoKeyboardMessages(this.messages);
      this.focusedHotkeyRegistration = new BurikoFocusedHotkeyRegistration(this.keyboard);
      this.printScreenHotkeys = new BurikoPrintScreenHotkeys(
        this.messages,
        this.focusedHotkeyRegistration,
      );
      this.notifications = new BurikoNativeNotifications();
      this.gamepadHost =
        inputs.gamepadHost === undefined
          ? new BurikoBrowserGamepads(inputs.navigator, [])
          : inputs.gamepadHost;
      if (
        this.gamepadHost !== null &&
        (typeof this.gamepadHost !== 'object' ||
          typeof this.gamepadHost.open !== 'function' ||
          typeof this.gamepadHost.enumerateAttached !== 'function' ||
          typeof this.gamepadHost.close !== 'function')
      )
        throw new TypeError('Buriko gamepad host requires selected synchronous primitives');
      this.gamepads =
        this.gamepadHost === null
          ? null
          : new BurikoNativeGamepads(this.gamepadHost, this.input, this.notifications);
      if (this.gamepads !== null) rollback.push(() => this.gamepads!.shutdown());
      this.fontProvider = inputs.fontProvider ?? new BurikoBrowserFonts();
      this.fonts = new BurikoNativeFonts(this.text, this.fontProvider);
      rollback.push(() => this.fonts.dispose());
      this.compositor = new BurikoBitmapCompositor(
        this.engineVersion.bpAbi.compatibility,
        this.engineVersion.bpAbi.revision,
      );
      this.damage = new BurikoDisplayDamage(inputs.damageCapacity, {
        left: 0,
        top: 0,
        right: this.display.logicalWidth - 1,
        bottom: this.display.logicalHeight - 1,
      });
      this.surfaces = new BurikoSurfaces(this.fonts, this.compositor, this.allocator);
      this.diskImagePixels = new BurikoDiskImagePixels(this.surfaces);
      this.monochromeText = new BurikoMonochromeSurfaceText(this.surfaces);
      rollback.push(() => this.monochromeText.dispose());
      this.surfaceEffects = new BurikoSurfaceEffects(this.surfaces);
      this.bitmapLoadState = new BurikoBitmapLoadState(this.input, this.clock);
      this.manager = new BurikoDisplayManager(
        new BurikoDisplayObjectEnvironment(this.compositor, this.damage),
        this.surfaces,
        this.display,
      );
      this.groups = new BurikoGroupDisplays(this.manager);
      this.maps = new BurikoMapDisplays(this.manager);
      this.landscapes = new BurikoLandscapeDisplays(this.manager, this.input);
      this.filterDisplays = new BurikoFilterDisplays(this.manager);
      this.windowState = new BurikoWindowDisplayState(this.manager);
      rollback.push(() => this.manager.locks.script.dispose());
      rollback.push(() => this.manager.locks.engine.dispose());
      rollback.push(() => this.manager.locks.disposeEngine());
      rollback.push(() => this.manager.dispose());
      this.callbacks = new BurikoMainWindowCallbackBinding(this.display);
      this.host = new BurikoBrowserMainWindow(
        inputs.document,
        inputs.parent,
        inputs.canvas,
        this.manager,
        this.callbacks,
        inputs.presentationMode ?? 'canvas',
        inputs.displayHost ?? null,
        inputs.childWindowParent ?? inputs.parent,
        inputs.presentationMode === 'none' ? null : this.textPresentation,
      );
      rollback.push(() => this.host.detachScopedWindow());
      this.host.bindViewportScreenMapping(inputs.readViewportScreenMapping);
      this.host.configureMonitorProfile(
        inputs.monitors,
        inputs.selectedMonitor,
        inputs.clientOrigin[0],
        inputs.clientOrigin[1],
      );
      const selectedTouchProfile =
        inputs.touchProfile === undefined
          ? {
              available:
                inputs.navigator.maxTouchPoints > 0 &&
                typeof inputs.document.defaultView?.PointerEvent === 'function',
              compatibilityMouse: 'owned' as const,
            }
          : inputs.touchProfile;
      this.touchWindow =
        selectedTouchProfile == null
          ? null
          : new BurikoBrowserTouchWindow(this.host, selectedTouchProfile.available);
      this.touch =
        this.touchWindow === null
          ? null
          : new BurikoNativeTouch(
              this.input,
              this.clock,
              this.touchWindow,
              this.engineVersion.bpAbi.revision,
            );
      // Validate the selected host geometry before borrowing it for adapter selection.
      this.host.readRestoredOuterScreenRectangle();
      this.adapters = new BurikoDisplayAdapters(
        this.display,
        inputs.adapters,
        inputs.primaryMonitor,
        () => this.host.readRestoredOuterScreenRectangle(),
      );
      this.device = new BurikoDisplayDevice(
        inputs.canvas,
        this.manager,
        this.clock,
        this.adapters,
        inputs.presentationMode ?? 'canvas',
        inputs.presentationMode === 'none' ? null : this.textPresentation,
      );
      rollback.push(() => this.device.dispose());
      this.cursor = new BurikoNativeCursor(inputs.canvas);
      this.cursorPolicy = new BurikoCursorPolicy(this.manager, this.input, this.clock, this.cursor);
      this.cursorPosition = new BurikoBrowserCursorPosition();
      this.cursorMotion = new BurikoNativeCursorMotion(
        this.input,
        this.clock,
        this.cursorPosition,
        this.engineVersion.bpAbi.revision,
      );
      this.cursorFrame = new BurikoCursorFrameLower(this.cursorMotion, this.cursorPolicy);
      rollback.push(() => {
        this.cursorMotion.active = false;
        this.cursorPolicy.setCustom(0, 0, 0);
        this.cursor.setVisible(1);
      });
      this.diagnosticDialogs = new BurikoDiagnosticDialogs(inputs.document, inputs.parent);
      this.dialogs = new BurikoEngineDialogs(
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
      this.modelessSettings = new BurikoModelessSettings(
        inputs.document,
        inputs.parent,
        this.dialogs,
      );
      rollback.push(() => this.modelessSettings.disposeAll());
      this.selectionDialog = new BurikoSelectionDialog(this.dialogs, this.text);
      this.localized = new BurikoLocalizedMessages(
        this.text,
        new BurikoNativeLanguage(inputs.readUserDefaultUiLanguage),
        new BurikoImportedTextMaps(this.text),
      );
      this.localized.load(inputs.localizedText);
      this.fileSelection =
        this.pickerHost === null
          ? null
          : new BurikoFileSelectionService(this.dialogs, this.clock, this.host, this.pickerHost);
      this.folderSelection =
        this.pickerHost === null
          ? null
          : new BurikoFolderSelectionService(this.localized, this.host, this.pickerHost);
      this.ansiUi = new BurikoAnsiUi(this.text);
      this.ansiDialogs = new BurikoAnsiDialogs(
        inputs.document,
        inputs.parent,
        this.dialogs,
        this.ansiUi,
        this.localized.language,
      );
      this.productKeyDialog = new BurikoProductKeyDialog(
        inputs.document,
        inputs.parent,
        this.dialogs,
        this.text,
      );
      this.inline = new BurikoInlineTextControl(
        this.host,
        this.fonts,
        this.dialogs,
        this.messages,
        this.keyboard,
      );
      this.fullscreenMovie = new BurikoFullscreenMovieState();
      this.movieImageConfiguration = new BurikoMovieImageConfiguration();
      this.surfaceMovieFactory = new BurikoBrowserSurfaceMovieFactory(
        this,
        inputs.document,
        this.movieImageConfiguration,
        inputs.surfaceMovieDocumentByteBudget ?? 0xffffffff,
      );
      this.mfMovieVolume = new BurikoMfMovieVolumePolicy(this.fullscreenMovie);
      this.traditionalMovieAudio = new BurikoTraditionalMovieAudioPolicy();
      this.registry = new BurikoNativeRegistry(inputs.registryStore);
      this.fileAssociationHost =
        inputs.fileAssociationHost ?? new BrowserWindowsFileAssociationHost();
      for (const operation of [
        'createKey',
        'setValue',
        'postMessageA',
        'shellChangeNotify',
      ] as const)
        if (typeof this.fileAssociationHost[operation] !== 'function')
          throw new TypeError(`Buriko file-association host lacks ${operation}`);
      this.fileAssociations = new BurikoFileAssociations(this.fileAssociationHost, this.text);
      this.desktopWallpaperHost =
        inputs.desktopWallpaperHost === undefined
          ? new BrowserWindowsDesktopWallpaperHost()
          : inputs.desktopWallpaperHost;
      if (
        this.desktopWallpaperHost !== null &&
        typeof this.desktopWallpaperHost.setWallpaper !== 'function'
      )
        throw new TypeError('Buriko desktop wallpaper host requires a selected effect primitive');
      this.wallpaper =
        this.desktopWallpaperHost === null
          ? null
          : new BurikoWallpaper(this.registry, this.desktopWallpaperHost, this.text);
      this.controller = new BurikoDisplayController(
        this.manager,
        this.device,
        this.adapters,
        this.host,
        new BurikoCpuProfile(this.cpuHost, this.clock),
        this.ticks,
        new BurikoDisplayMouseTrails(this.registry, this.dialogs),
        this.localized,
        this.messages,
        this.fullscreenMovie,
        this.inline,
        this.notifications,
      );
      this.children = new BurikoChildWindows(
        inputs.document,
        inputs.childWindowParent ?? inputs.parent,
        inputs.navigator,
        this.text,
        this.surfaces,
        this.compositor,
        new BurikoBitmapText(this.fonts, this.compositor),
        this.dialogs,
        this.messages,
        this.keyboard,
        inputs.childMetrics,
        this.title.bytes,
        inputs.canvas,
        inputs.presentationMode ?? 'canvas',
        inputs.childWindowCoordinates ?? null,
        inputs.presentationMode === 'none' ? null : this.textPresentation,
      );
      this.children.initialize();
      rollback.push(() => this.children.dispose());
      this.properties = new BurikoPropertyEditors(
        inputs.document,
        inputs.parent,
        this.text,
        this.messages,
        this.title.bytes,
      );
      rollback.push(() => this.properties.dispose());
      this.title.validateConsumers(this.dialogs, this.children, this.properties);
      this.movies = new BurikoMovieRegistry();
      this.surfaces.attachMovies(this.movies);
      this.movieFramePosition = new BurikoMovieFramePosition(this.surfaces, this.movies);
      this.frames = new BurikoDisplayFrames(
        this.manager,
        this.device,
        this.clock,
        this.ticks,
        new BurikoFrameMetrics(
          new BurikoBrowserPerformanceCounter(inputs.performance),
          this.clock,
          this.device,
        ),
        this.movies,
        this.fullscreenMovie,
        this.inline,
        this.children,
      );
      const displayEnumerationHost =
        inputs.displayEnumerationHost ??
        new BrowserWindowsDisplayEnumerationHost(inputs.monitors, inputs.adapters.length);
      if (
        typeof displayEnumerationHost.enumerateMonitors !== 'function' ||
        typeof displayEnumerationHost.adapterCount !== 'function'
      )
        throw new TypeError(
          'Buriko display enumeration requires selected monitor and adapter primitives',
        );
      this.deviceEnumeration = new BurikoDeviceEnumerationRefresh(
        this.clock,
        this.display,
        this.frames,
        this.gamepads,
        displayEnumerationHost,
      );
      this.callbacks.bind(this.host, this.controller, this.frames);
      const browserDriveHost = new BrowserWindowsLogicalDriveHost();
      const sharedDriveHost = inputs.resource.driveHost ?? browserDriveHost;
      this.resource = new BurikoProductionResourceWorker({
        ...inputs.resource,
        abi: this.engineVersion.bpAbi,
        driveHost: sharedDriveHost,
        driveGeometryHost:
          inputs.resource.driveGeometryHost ??
          (inputs.resource.driveHost === undefined ? browserDriveHost : undefined),
        temporaryFileHost:
          inputs.resource.temporaryFileHost === undefined
            ? new BurikoBrowserTemporaryFileHost(
                new BrowserWindowsTemporaryFileHost(this.cryptoRandom),
              )
            : inputs.resource.temporaryFileHost,
        text: this.text,
        dialogs: this.dialogs,
        ticks: this.ticks,
        allocator: this.allocator,
        locks: this.manager.locks,
      });
      rollback.push(() => this.resource.processing.dispose());
      this.legacy169Flash =
        this.engineVersion.bpAbi.compatibility === '1.69'
          ? new BurikoLegacy169FlashSurfaces(
              this.surfaces,
              this.resource.files,
              this.text,
              this.notifications,
              inputs.windowsFlashHost ?? new BrowserWindowsFlashHost(),
              this.systemProfileHost,
              () => inputs.performance.now(),
            )
          : null;
      this.diskImageService = new BurikoDiskImageService(
        this.diskImagePixels,
        this.resource.files,
        this.text,
        inputs.imageCodecHost ?? new BrowserGdiImageCodec(),
      );
      this.playSoundHost = inputs.playSoundHost ?? new BrowserWindowsPlaySoundHost();
      if (
        this.playSoundHost.executableModule === null ||
        typeof this.playSoundHost.executableModule !== 'object' ||
        typeof this.playSoundHost.playSoundW !== 'function'
      )
        throw new TypeError('Buriko PlaySoundW requires a selected synchronous host');
      this.playSound = new BurikoPlaySound(this.resource.resources, this.playSoundHost);
      this.installerDialogHost =
        inputs.installerDialogHost ??
        new BrowserWindowsInstallerDialogHost(inputs.document, inputs.parent);
      if (
        typeof this.installerDialogHost.chooseDestination !== 'function' ||
        typeof this.installerDialogHost.chooseComponent !== 'function' ||
        typeof this.installerDialogHost.runProgress !== 'function'
      )
        throw new TypeError('Buriko installer dialogs require a selected modal host');
      this.taskbarProgressHost =
        inputs.taskbarProgressHost ?? new BrowserWindowsTaskbarProgressHost();
      if (typeof this.taskbarProgressHost.createTaskbarList3 !== 'function')
        throw new TypeError('Buriko installer progress requires a selected taskbar host');
      this.installerDialogs = new BurikoInstallerDialogs(
        this.installerDialogHost,
        this.dialogs,
        this.folderSelection,
        this.resource.files,
        this.localized.language,
      );
      this.bmvRegistry = new BurikoBmvRegistry(this.allocator);
      rollback.push(() => this.bmvRegistry.clear());
      this.bmvAsyncProcessing = new BurikoDistributedProcessing(
        this.allocator,
        this.resource.processing.capacity,
      );
      rollback.push(() => this.bmvAsyncProcessing.dispose());
      this.bmvService = new BurikoBmvService(
        this.bmvRegistry,
        this.surfaces,
        this.resource.loading.ranges,
        this.resource.processing,
        this.bmvAsyncProcessing,
      );
      this.bmvPump = new BurikoBmvWorkerPump(this.bmvService);
      this.internetReads =
        this.internetReadHost === null
          ? null
          : new BurikoInternetReads(this.resource.files, this.internetReadHost);
      this.devicePower =
        this.devicePowerHost === null
          ? null
          : new BurikoDevicePower(this.systemProfile!, this.resource.files, this.devicePowerHost);
      this.fontResources = new BurikoFontResources(this.fonts, this.resource.resources);
      rollback.push(() => {
        this.fonts.resetManager();
        this.fontResources.clear();
      });
      // Native engine startup (0x1400c3900) calls BGI_FontResource_Reset(0),
      // registering the two built-in font names before any script callback.
      this.fontResources.reset(false, (this.localized.language.value & 0x3ff) === 0x11);
      this.bitmapLoading = new BurikoBitmapLoading(
        this.surfaces,
        this.resource.loading,
        this.bitmapLoadState,
      );
      this.bitmapRegistration = new BurikoBitmapRegistration(this.resource.loading, this.surfaces);
      this.bitmapCacheServices = new BurikoBitmapCacheServices(
        this.bitmapLoading,
        this.bitmapRegistration,
      );
      this.compressedSurfaceEncoder = new BurikoCompressedSurfaceEncoder(
        this.surfaces,
        this.resource.processing,
        this.ticks,
      );
      this.codecWorkers = new BurikoDataCodecWorkers(inputs.readSystemTime);
      this.folders = new BurikoSpecialFolders(
        this.text,
        this.registry,
        this.resource.resources.configuration,
        inputs.specialFolderProfile,
      );
      this.resource.files.specialFolders = this.folders;
      this.shellShortcuts =
        this.shellShortcutHost === null
          ? null
          : new BurikoShellShortcuts(this.resource.files, this.folders, this.shellShortcutHost);
      this.fileChecksum = new BurikoFileChecksum(this.resource.resources);
      this.fileEnumeration = new BurikoFileEnumeration(
        this.resource.files,
        this.directoryNamespaceHost,
      );
      this.resourceFileServices = new BurikoResourceFileServices(this.resource.resources);
      this.resourceFilePresence = new BurikoResourceFilePresence(
        this.resource.resources,
        this.localized,
      );
      this.pathDirectory = new BurikoPathFileDirectory(this.resource.files);
      this.launchSelection = new BurikoLaunchSelection(
        this.resource.files,
        inputs.resource.paths,
        this.resource.resources,
        this.resource.errors,
        this.text,
        inputs.executablePathWide,
        inputs.commandLineTailWide,
      );
      this.movieSources = new BurikoMovieSources(this.resource.resources);
      this.mfSourceCandidates = new BurikoMfMovieSourceCandidates(this.resource.resources);
      this.mfMovieDocuments = new BurikoMfMovieDocuments(
        this.mfSourceCandidates,
        this.resource.files,
        inputs.mfMovieDocumentByteBudget ?? 0xffffffff,
      );
      this.mfMovieSession = new BurikoBrowserMfMovieSession(
        this.mfMovieDocuments,
        inputs.document,
        this.host,
        this.fullscreenMovie,
        this.mfMovieVolume,
      );
      this.traditionalMovieSession = new BurikoBrowserTraditionalMovieSession(
        this.resource.resources,
        this.mfMovieDocuments,
        inputs.document,
        this.device,
        this.movieImageConfiguration,
        this.fullscreenMovie,
        this.traditionalMovieAudio,
      );
      this.externalMutexName = new BurikoExternalMutexName();
      this.installerManifest = new BurikoInstallerManifestActions(this.resource.resources);
      this.installerQueries = new BurikoInstallerQueries(
        this.registry,
        this.folders,
        this.resource.files,
      );
      this.installerShortcutCleanup = new BurikoInstallerShortcutCleanup(
        this.folders,
        this.resource.files,
      );
      this.particleRandom = new BurikoThreadedCrtRandom(() => this.allocator.currentActor);
      this.rainState = new BurikoRainDisplayState();
      this.rain = new BurikoRainDisplays(
        this.manager,
        this.rainState,
        this.particleRandom,
        this.ticks,
      );
      this.rainFrames = new BurikoRainFrames(this.rain, this.clock);
      this.particleVariants = new BurikoParticleVariants();
      this.particles = new BurikoParticleDisplays(
        this.manager,
        this.particleVariants,
        this.particleRandom,
        this.clock,
        this.resource.processing,
      );
      this.particleFrames = new BurikoParticleFrames(this.particles, this.clock);
      this.knobs = new BurikoKnobDisplays(this.manager, this.input, this.notifications);
      this.spriteTargets = new BurikoSpriteTargets(this.manager, this.input);
      this.cursorShapes = new BurikoCursorShapes(this.cursor, this.messages, inputs.cursorResource);
      rollback.push(() => this.cursorShapes.dispose());
      this.messages.createMainTarget();
      this.host.bindCloseMenu(this.input, this.messages);
      this.droppedFiles = new BurikoDroppedFiles(
        inputs.canvas,
        this.messages,
        this.resource.files,
        inputs.resource.mounted,
        inputs.drop.mountedRoot,
        inputs.drop.nativeRoot,
      );
      rollback.push(() => this.droppedFiles.dispose());
      this.nonclientMotion = new BurikoMainWindowNonclientMotion(
        this.host,
        this.input,
        this.controller,
      );
      this.namedFileMappingHost =
        inputs.namedFileMappingHost === undefined
          ? new BrowserWindowsNamedFileMappingHost()
          : inputs.namedFileMappingHost;
      if (
        this.namedFileMappingHost !== null &&
        typeof this.namedFileMappingHost.read !== 'function'
      )
        throw new TypeError('Buriko named file mapping requires a selected read primitive');
      this.receiver = new BurikoMainWindowMessageReceiver(
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
        this.touch,
        this.cdAudio,
        this.deviceEnumeration,
        this.nonclientMotion,
        this.namedFileMappingHost,
      );
      this.sizeEffects = new BurikoMainWindowSizeEffects(this);
      this.queuedPaint = new BurikoQueuedMainPaint(
        this.messages,
        this.waits,
        this.initialized,
        this.device,
        this.frames,
      );
      this.queuedSize = new BurikoQueuedMainSize(
        this.messages,
        this.waits,
        this.initialized,
        this.host,
        this.input,
        this.sizeEffects,
      );
      this.queuedActivation = new BurikoQueuedMainActivation(
        this.messages,
        this.waits,
        this.initialized,
        this.host,
        this.input,
        this.clock,
        this.movies,
      );
      this.queuedDispatcher = new BurikoQueuedWindowDispatcher(
        this.messages,
        this.queuedPaint,
        this.queuedSize,
        this.queuedActivation,
      );
      this.guiPump = new BurikoGuiMessagePump(
        this.messages,
        this.queuedDispatcher,
        inputs.characterTranslationHost ?? new BrowserWindowsCharacterTranslationHost(),
      );
      const restoreContainer = inputs.restoreContainer ?? inputs.document.body;
      if (
        restoreContainer != null &&
        restoreContainer !== this.host.parent &&
        (typeof this.host.parent.contains !== 'function' ||
          !this.host.parent.contains(restoreContainer))
      ) {
        this.windowTransitions = new BurikoMainWindowTransitions(
          this.host,
          this.input,
          this.queuedDispatcher,
          inputs.windowTransitionProfile ?? BROWSER_WINDOWS_WINDOW_TRANSITION_PROFILE,
          restoreContainer,
        );
        rollback.push(() => this.windowTransitions?.dispose());
      } else if (
        inputs.windowTransitionProfile !== undefined ||
        inputs.restoreContainer !== undefined
      )
        throw new Error(
          'Buriko scoped restore requires a visible container outside the main window',
        );
      else this.windowTransitions = null;
      this.showState = new BurikoMainWindowShowState(
        this.host,
        this.input,
        this.messages,
        this.queuedDispatcher,
      );
      this.externalProcessWindow = new BurikoExternalProcessWindow(
        this.showState,
        this.queuedDispatcher,
        this.guiPump,
      );
      const browserProcessHost = new BrowserWindowsProcessHost();
      this.externalProcessHost =
        inputs.externalProcessHost === undefined
          ? this.systemProfile === null
            ? null
            : browserProcessHost
          : inputs.externalProcessHost;
      if (this.externalProcessHost !== null) {
        if (this.systemProfile === null)
          throw new TypeError('Buriko external-process host requires the selected system profile');
        for (const operation of [
          'isUserAdministrator',
          'readShellWindowProcessId',
          'openProcess',
          'openProcessToken',
          'duplicateTokenEx',
          'createProcessWithTokenW',
          'createProcessW',
          'waitForInputIdle',
          'waitForSingleObject',
          'readExitCodeProcess',
          'openMutexA',
          'sleep',
          'closeHandle',
        ] as const)
          if (typeof this.externalProcessHost[operation] !== 'function')
            throw new TypeError(`Buriko external-process host lacks ${operation}`);
      }
      this.shellExecuteHost =
        inputs.shellExecuteHost === undefined
          ? this.externalProcessHost === browserProcessHost
            ? browserProcessHost
            : null
          : inputs.shellExecuteHost;
      if (this.shellExecuteHost !== null) {
        if (!Object.is(this.shellExecuteHost, this.externalProcessHost))
          throw new TypeError('Buriko shell execute requires the selected process host');
        for (const operation of [
          'impersonateLoggedOnUser',
          'shellExecuteW',
          'revertToSelf',
        ] as const)
          if (typeof this.shellExecuteHost[operation] !== 'function')
            throw new TypeError(`Buriko shell-execute host lacks ${operation}`);
      }
      this.externalProcesses =
        this.externalProcessHost === null
          ? null
          : new BurikoExternalProcesses(
              this.resource.resources,
              this.systemProfile!,
              this.localized,
              this.externalProcessHost,
              this.externalProcessWindow,
              this.externalMutexName,
              this.shellExecuteHost,
            );
      this.dynamicLibraryHost =
        inputs.dynamicLibraryHost === undefined
          ? new BrowserWindowsDynamicLibraryHost()
          : inputs.dynamicLibraryHost;
      if (this.dynamicLibraryHost !== null) {
        for (const operation of [
          'loadLibraryA',
          'getProcAddress',
          'invoke',
          'freeLibrary',
          'mainWindowHandle',
        ] as const)
          if (typeof this.dynamicLibraryHost[operation] !== 'function')
            throw new TypeError(`Buriko dynamic-library host lacks ${operation}`);
      }
      this.externalLibraries =
        this.dynamicLibraryHost === null
          ? null
          : new BurikoExternalLibraries(
              this.resource.resources,
              this.dynamicLibraryHost,
              this.host,
            );
      if (this.externalLibraries !== null) rollback.push(() => this.externalLibraries!.dispose());
      this.logicalDriveHost =
        inputs.logicalDriveHost === undefined
          ? inputs.resource.driveHost === undefined
            ? browserDriveHost
            : null
          : inputs.logicalDriveHost;
      if (this.logicalDriveHost !== null) {
        if (
          !Object.is(this.logicalDriveHost, this.resource.driveHost) ||
          typeof this.logicalDriveHost.readLogicalDriveStrings !== 'function'
        )
          throw new TypeError('Buriko logical-drive discovery requires the shared drive host');
      }
      this.secondaryMedia =
        this.logicalDriveHost === null
          ? null
          : new BurikoSecondaryMediaDiscovery(
              this.resource.resources,
              this.localized,
              this.logicalDriveHost,
              {sleep: inputs.resource.sleep},
              this.externalProcessWindow,
            );
      this.syntheticMouse = new BurikoSyntheticMouse(this.input, this.messages);
      this.callbacks.bindReadyReceiver(this.host, this.receiver);
      this.messages.send('main', 1, 0, 0);
      this.domInput = new BurikoMainDomInput(
        this.host,
        this.input,
        this.messages,
        this.keyboard,
        inputs.wheelTranslator ?? null,
        this.touch,
        this.touchWindow,
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

  /** Switch browser presentation without changing the native frame or text rasterization. */
  setTextMode(mode: BrowserTextMode): void {
    this.textPresentation.setTextMode(mode);
  }

  /** Prepare F04B0's physical source as a bounded ISO document; no movie slot is changed. */
  async prepareMovieDocument(
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer,
    maxBytes: number,
  ): Promise<BurikoMovieSourceDocument | null> {
    if (this.phase === 'closed' || this.closing !== null || this.movieSourceResetting)
      throw new Error('Buriko production movie source graph is closed');
    const generation = this.movieSourceGeneration;
    const preparing = BurikoMovieSourceDocument.open(
      this.movieSources,
      archive,
      name,
      this.allocator,
      () => this.ticks.timeGetTime(),
      maxBytes,
    );
    this.pendingMovieDocuments.add(preparing);
    try {
      const document = await preparing;
      if (generation !== this.movieSourceGeneration || this.movieSourceResetting)
        throw new Error('Buriko movie source prepared across a program reset');
      return document;
    } finally {
      this.pendingMovieDocuments.delete(preparing);
    }
  }

  /** Close source admission before ECB90 reuses movie/surface slots, then join accepted reads. */
  async beginMovieSourceReset(): Promise<() => void> {
    if (this.phase === 'closed' || this.closing !== null || this.movieSourceResetting)
      throw new Error('Buriko movie source reset requires an open idle graph');
    this.movieSourceResetting = true;
    this.movieSourceGeneration++;
    let releaseSurfaceMovies: () => void;
    let releaseMfMovie: () => void;
    let releaseTraditionalMovie: () => void;
    try {
      const resets = await Promise.allSettled([
        this.surfaceMovieFactory.beginReset(),
        this.mfMovieSession.beginReset(),
        this.traditionalMovieSession.beginReset(),
      ]);
      const failed = resets.find((result) => result.status === 'rejected');
      if (failed !== undefined) {
        for (const result of resets) if (result.status === 'fulfilled') result.value();
        throw failed.reason;
      }
      releaseSurfaceMovies = (resets[0] as PromiseFulfilledResult<() => void>).value;
      releaseMfMovie = (resets[1] as PromiseFulfilledResult<() => void>).value;
      releaseTraditionalMovie = (resets[2] as PromiseFulfilledResult<() => void>).value;
      await Promise.allSettled([...this.pendingMovieDocuments]);
    } catch (error) {
      if (this.closing === null) this.movieSourceResetting = false;
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTraditionalMovie();
      releaseMfMovie();
      releaseSurfaceMovies();
      if (this.closing === null && this.phase !== 'closed') this.movieSourceResetting = false;
    };
  }

  /** Every selected movie gets a fresh graph clock from this host performance source. */
  createMovieReferenceClock(): BurikoMovieReferenceClock {
    if (this.phase === 'closed' || this.closing !== null || this.movieSourceResetting)
      throw new Error('Buriko production movie source graph is closed');
    return new BurikoMovieReferenceClock(this.movieMilliseconds);
  }

  /** Explicit video-only selection; this does not create a decoder or attach a surface movie. */
  async prepareVideoOnlySource(
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer,
    maxDocumentBytes: number,
    videoTrackId: number,
  ): Promise<BurikoMovieVideoOnlySourceSelection | null> {
    return BurikoMovieVideoOnlySourceSelection.open(
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
      throw new Error('Buriko initial renderer budget requires pre-device startup');
    if (this.device.isPresent() || this.manager.environment.displayContext !== null)
      throw new Error('Buriko initial renderer budget requires an unconfigured display');
    if (this.initialRenderPixelBudget !== null) return this.initialRenderPixelBudget;
    const cpu = this.controller.cpu;
    if (
      this.controller.manager !== this.manager ||
      this.controller.display !== this.display ||
      cpu.host !== this.cpuHost ||
      cpu.clock !== this.clock
    )
      throw new Error('Buriko initial renderer budget requires the shared CPU and display owners');
    if (!cpu.initialize()) throw new Error('Buriko CPU profile initialization did not complete');
    const budget = burikoDisplayRenderPixelBudget(cpu, this.display);
    this.manager.setRenderPixelBudget(budget);
    this.manager.initializeObjectRenderer();
    this.initialRenderPixelBudget = budget;
    return budget;
  }

  get objectRendererReady(): boolean {
    return this.initialRenderPixelBudget !== null;
  }

  /** B11F0 startup leg over the selected CPU budget, HWND, adapter and device.
   * C3900's later grouped success and engine-initialized publication remain with its caller. */
  initializeDisplayForEngineStartup(): Promise<0 | 1> {
    if (this.phase !== 'constructed' || this.closing !== null)
      return Promise.reject(new Error('Buriko display startup requires the pre-worker graph'));
    if (this.displayInitialization !== null) return this.displayInitialization;
    this.prepareRenderPixelBudget();
    const work = this.controller.initialize().then((result) => {
      this.initializedDisplay = result === 1;
      return result;
    });
    this.displayInitialization = work;
    return work;
  }

  get displayReadyForScriptGeometry(): boolean {
    return this.initializedDisplay && this.closing === null && this.phase !== 'closed';
  }

  start(options: {automatic?: boolean} = {}): Promise<void> {
    if (this.phase !== 'constructed' || this.closing !== null)
      return Promise.reject(new Error('Buriko production display/resource graph is already used'));
    if (this.displayInitialization !== null && !this.initializedDisplay)
      return Promise.reject(new Error('Buriko display startup has not completed successfully'));
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
    const pickerJoining =
      this.pickerHost instanceof BrowserWindowsDialogPicker
        ? this.pickerHost.closeAndJoin()
        : Promise.resolve();
    const processJoining = this.externalProcesses?.closeAndJoin() ?? Promise.resolve();
    const mediaJoining = this.secondaryMedia?.closeAndJoin() ?? Promise.resolve();
    const bmvJoining = this.bmvPump.closeAndDrain();
    const transitionJoining = this.windowTransitions?.closeAndJoin() ?? Promise.resolve();
    const surfaceMovieJoining = Promise.all([
      this.surfaceMovieFactory.closeAndJoin(),
      this.legacy169Flash?.closeAndJoin(),
    ]).then(() => undefined);
    const mfMovieJoining = this.mfMovieSession.closeAndJoin();
    const traditionalMovieJoining = this.traditionalMovieSession.closeAndJoin();
    this.movieSourceResetting = true;
    this.movieSourceGeneration++;
    this.initialized.clearAtTeardownIngress();
    this.domInput.dispose();
    if (this.closing !== null) return this.closing;
    if (this.phase === 'closed') return Promise.resolve();
    if (this.phase === 'starting') {
      const starting = this.starting!;
      this.closing = starting.then(
        () =>
          this.finishShutdown(
            true,
            codecJoining,
            internetJoining,
            pickerJoining,
            processJoining,
            mediaJoining,
            bmvJoining,
            transitionJoining,
            surfaceMovieJoining,
            mfMovieJoining,
            traditionalMovieJoining,
          ),
        () =>
          this.finishShutdown(
            false,
            codecJoining,
            internetJoining,
            pickerJoining,
            processJoining,
            mediaJoining,
            bmvJoining,
            transitionJoining,
            surfaceMovieJoining,
            mfMovieJoining,
            traditionalMovieJoining,
          ),
      );
      return this.closing;
    }
    this.closing = this.finishShutdown(
      this.phase === 'running',
      codecJoining,
      internetJoining,
      pickerJoining,
      processJoining,
      mediaJoining,
      bmvJoining,
      transitionJoining,
      surfaceMovieJoining,
      mfMovieJoining,
      traditionalMovieJoining,
    );
    return this.closing;
  }

  private async finishShutdown(
    running: boolean,
    codecJoining: Promise<void>,
    internetJoining: Promise<void>,
    pickerJoining: Promise<void>,
    processJoining: Promise<void>,
    mediaJoining: Promise<void>,
    bmvJoining: Promise<void>,
    transitionJoining: Promise<void>,
    surfaceMovieJoining: Promise<void>,
    mfMovieJoining: Promise<void>,
    traditionalMovieJoining: Promise<void>,
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
    if (this.displayInitialization !== null)
      await attempt(async () => {
        await this.displayInitialization;
      });
    await attempt(() => codecJoining);
    await attempt(() => pickerJoining);
    // Accepted external and media callbacks may still drain the real GUI FIFO.
    await attempt(() => processJoining);
    await attempt(() => mediaJoining);
    await attempt(() => transitionJoining);
    await attempt(() => surfaceMovieJoining);
    await attempt(() => mfMovieJoining);
    await attempt(() => traditionalMovieJoining);
    await attempt(() => this.queuedDispatcher.closeAndJoin());
    await attempt(() => this.windowTransitions?.dispose());
    await attempt(() => this.externalLibraries?.dispose());
    // Source preparation may be in an awaited physical file read when teardown enters.
    // Close admission above, then join those borrows before resource/allocator disposal.
    await Promise.allSettled([...this.pendingMovieDocuments]);
    await attempt(() => this.modelessSettings.disposeAll());
    await attempt(() => this.gamepads?.shutdown());
    await attempt(() => internetJoining);
    await attempt(() => bmvJoining);
    await attempt(() => this.cdAudio?.dispose());
    if (this.internetReads !== null && !this.internetReads.quiesced)
      throw new Error('Buriko graph shutdown retained internet-read BP borrowers');
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
    await attempt(() => this.bmvRegistry.clear());
    await attempt(() => this.monochromeText.dispose());
    await attempt(() => this.device.dispose());
    await attempt(() => this.textPresentation.dispose());
    await attempt(() => this.manager.dispose());
    await attempt(() => {
      this.fonts.resetManager();
      this.fontResources.clear();
    });
    await attempt(() => this.fonts.dispose());
    await attempt(() => this.bmvAsyncProcessing.dispose());
    await attempt(() => this.resource.processing.dispose());
    await attempt(() => this.manager.locks.disposeEngine());
    await attempt(() => this.manager.locks.engine.dispose());
    await attempt(() => this.manager.locks.script.dispose());
    await attempt(() => this.allocator.dispose());
    if (failed) throw firstError;
  }
}
