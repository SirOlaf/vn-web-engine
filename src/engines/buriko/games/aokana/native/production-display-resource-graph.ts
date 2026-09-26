import type {RecordStore} from '../../../../../platform/store.js';
import {
  BrowserRasterTextPresentation,
  type BrowserTextMode,
} from '../../../../../text/browser-raster-text-presentation.js';
import type {WindowsGdiImageCodecHost} from '../../../../../platform/windows-gdi-image.js';
import {
  BROWSER_WINDOWS_WINDOW_TRANSITION_PROFILE,
  type WindowsWindowTransitionProfile,
} from '../../../../../platform/windows-window-transitions.js';
import {
  BrowserWindowsDisplayEnumerationHost,
  type WindowsDisplayEnumerationHost,
} from '../../../../../platform/windows-display-enumeration.js';
import {
  BrowserWindowsCharacterTranslationHost,
  type WindowsCharacterTranslationHost,
} from '../../../../../platform/windows-character-translation.js';
import {BrowserGdiImageCodec} from '../../../../../graphics/browser-gdi-image.js';
import {BrowserWindowsSystemProfileHost} from '../../../../../platform/browser-windows-system-profile.js';
import {BrowserWindowsProcessHost} from '../../../../../platform/browser-windows-process.js';
import {BrowserWindowsDynamicLibraryHost} from '../../../../../platform/windows-dynamic-library.js';
import {BrowserWindowsNamedMutexHost} from '../../../../../platform/windows-named-mutex.js';
import {BrowserWindowsLogicalDriveHost} from '../../../../../platform/windows-drives.js';
import {BrowserWindowsDevicePowerHost} from '../../../../../platform/windows-device-power.js';
import {BrowserWindowsShellLinkHost} from '../../../../../platform/windows-shell-link.js';
import {BrowserWindowsDesktopWallpaperHost} from '../../../../../platform/windows-desktop-wallpaper.js';
import {BrowserWindowsDialogPicker} from '../../../../../platform/windows-picker.js';
import {BrowserWindowsTemporaryFileHost} from '../../../../../platform/windows-temporary-file.js';
import {
  BrowserWindowsDirectoryNamespaceHost,
  type WindowsDirectoryNamespaceHost,
} from '../../../../../platform/windows-directory-namespace.js';
import {
  BrowserWindowsNamedFileMappingHost,
  type WindowsNamedFileMappingHost,
} from '../../../../../platform/windows-named-file-mapping.js';
import {BrowserCdAudioMediaHost} from '../../../../../audio/cd-media.js';
import {
  BrowserWindowsPlaySoundHost,
  type WindowsPlaySoundHost,
} from '../../../../../platform/windows-sound.js';
import {
  BrowserWindowsInstallerDialogHost,
  type WindowsInstallerDialogHost,
} from '../../../../../platform/windows-installer-dialogs.js';
import {
  BrowserWindowsTaskbarProgressHost,
  type WindowsTaskbarProgressHost,
} from '../../../../../platform/windows-taskbar-progress.js';
import {
  BrowserWindowsFileAssociationHost,
  type WindowsFileAssociationHost,
} from '../../../../../platform/windows-file-associations.js';
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
import {AokanaDiskImageService} from './disk-image-service.js';
import {AokanaBitmapText} from './font-bitmap.js';
import {AokanaBmvRegistry} from './bmv-registry.js';
import {AokanaBmvService} from './bmv-service.js';
import {AokanaBmvWorkerPump} from './bmv-worker-pump.js';
import {AokanaNativeClock} from './clock.js';
import {AokanaCpuProfile, type AokanaCpuHost} from './cpu-profile.js';
import {AokanaCdAudio, type AokanaCdMediaHost} from './cd-audio.js';
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
import {AokanaDeviceEnumerationRefresh} from './device-enumeration-refresh.js';
import {AokanaDisplayFrames} from './display-frames.js';
import {AokanaDisplayManager} from './display-manager.js';
import {AokanaDisplayMouseTrails} from './display-mouse-trails.js';
import {AokanaDisplayObjectEnvironment} from './display-object.js';
import {AokanaNativeDisplayState, type AokanaNativeRectangle} from './display-state.js';
import {AokanaDistributedAllocator, AokanaDistributedProcessing} from './distributed-processing.js';
import {AokanaDroppedFiles} from './dropped-files.js';
import {AokanaEngineDialogs, AokanaNativeCursor} from './engine-dialogs.js';
import {AokanaAnsiUi} from './ansi-ui.js';
import {AokanaAnsiDialogs} from './ansi-dialogs.js';
import {AokanaEngineInitializedState} from './engine-initialized-state.js';
import {AokanaExternalMutexName} from './external-mutex-name.js';
import {AokanaExternalProcessWindow} from './external-process-window.js';
import {AokanaExternalLibraries} from './external-libraries.js';
import type {WindowsDynamicLibraryHost} from '../../../../../platform/windows-dynamic-library.js';
import {
  AokanaExternalProcesses,
  type AokanaExternalProcessHost,
  type AokanaShellExecuteHost,
} from './external-process.js';
import {AokanaSecondaryMediaDiscovery, type AokanaLogicalDriveHost} from './secondary-media.js';
import {AokanaFileChecksum} from './file-checksum.js';
import {AokanaFileEnumeration} from './file-enumeration.js';
import {AokanaFileSelectionService, type AokanaFileDialogHost} from './file-selection.js';
import {AokanaFolderSelectionService, type AokanaFolderDialogHost} from './folder-selection.js';
import {AokanaNativeFonts} from './fonts.js';
import {AokanaFontResources} from './font-resources.js';
import {AokanaBrowserFonts, type AokanaFontProvider} from './font-browser.js';
import {AokanaFrameMetrics} from './frame-metrics.js';
import {AokanaGroupDisplays} from './group-displays.js';
import {AokanaGuiMessagePump} from './gui-message-pump.js';
import {AokanaNativeGamepads, type AokanaNativeGamepadHost} from './gamepads.js';
import {AokanaBrowserGamepads} from './browser-gamepads.js';
import {AokanaMapDisplays} from './map-displays.js';
import {AokanaLandscapeDisplays} from './landscape-displays.js';
import {AokanaFilterDisplays} from './filter-displays.js';
import {AokanaImportedTextMaps} from './imported-text-maps.js';
import {AokanaInstallerManifestActions} from './installer-manifest-actions.js';
import {AokanaInstallerDialogs} from './installer-dialogs.js';
import {AokanaInstallerQueries} from './installer-queries.js';
import {AokanaFileAssociations} from './file-associations.js';
import {AokanaInstallerShortcutCleanup} from './installer-shortcut-cleanup.js';
import {
  AOKANA_INTERNET_USER_AGENT,
  AokanaBrowserInternetReadHost,
  AokanaInternetReads,
  type AokanaInternetReadHost,
} from './internet-reads.js';
import {AokanaNativeInput} from './input.js';
import {AokanaInlineTextControl} from './inline-text-control.js';
import {AokanaKeyboardMessages} from './keyboard-messages.js';
import {AokanaLaunchSelection} from './launch-selection.js';
import {AokanaKnobDisplays} from './knob-displays.js';
import {AokanaLocalizedMessages} from './localized-messages.js';
import {AokanaMainWindowCallbackBinding} from './main-window-callbacks.js';
import {AokanaMainWindowMessageReceiver} from './main-window-messages.js';
import {AokanaMainWindowNonclientMotion} from './main-window-nonclient-motion.js';
import {AokanaMainWindowSizeEffects} from './main-window-size-effects.js';
import {AokanaMainWindowShowState} from './main-window-show-state.js';
import {AokanaMainWindowTransitions} from './main-window-transitions.js';
import {AokanaMainDomInput} from './main-dom-input.js';
import {AokanaBrowserTouchWindow} from './main-touch-input.js';
import {AokanaNativeTouch} from './touch-input.js';
import {AokanaBrowserTemporaryFileHost} from './temporary-directory-probe.js';
import type {AokanaMainWheelTranslator} from './main-mouse-input.js';
import {AokanaDiagnosticDialogs} from './modal.js';
import {AokanaFullscreenMovieState} from './movie-fullscreen-state.js';
import {AokanaMfMovieVolumePolicy} from './movie-mf-volume-policy.js';
import {AokanaMfMovieSourceCandidates} from './movie-mf-source-candidates.js';
import {AokanaMfMovieDocuments} from './movie-mf-document.js';
import {AokanaBrowserMfMovieSession} from './movie-mf-browser-session.js';
import {AokanaMovieReferenceClock} from './movie-render-events.js';
import {AokanaMovieSourceDocument} from './movie-source-document.js';
import {AokanaMovieSources} from './movie-sources.js';
import {AokanaMovieVideoOnlySourceSelection} from './movie-video-only-source-selection.js';
import {AokanaMovieRegistry} from './movie-registry.js';
import {AokanaMovieFramePosition} from './movie-frame-position.js';
import {AokanaMovieImageConfiguration} from './movie-image.js';
import {AokanaBrowserSurfaceMovieFactory} from './movie-browser-surface.js';
import {AokanaTraditionalMovieAudioPolicy} from './movie-traditional-audio-policy.js';
import {AokanaBrowserTraditionalMovieSession} from './movie-traditional-browser-graph.js';
import {AokanaNativeNotifications} from './notification-queue.js';
import {AokanaNamedMutexes, type AokanaNamedMutexHost} from './named-mutexes.js';
import {AokanaModelessSettings} from './modeless-settings.js';
import {AokanaSelectionDialog} from './selection-dialog.js';
import {AokanaParticleDisplays} from './particle-displays.js';
import {AokanaParticleFrames} from './particle-frames.js';
import {AokanaParticleVariants} from './particle-images.js';
import {AokanaPathFileDirectory} from './path-file-directory.js';
import {AokanaPlaySound} from './play-sound.js';
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
import {
  AokanaQueuedMainPaint,
  AokanaQueuedMainSize,
  AokanaQueuedMainActivation,
  AokanaQueuedWindowDispatcher,
} from './queued-window-dispatch.js';
import {AokanaWindowDisplayState} from './display-window-state.js';
import {AokanaWallpaper, type AokanaDesktopWallpaperHost} from './wallpaper.js';
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
  readonly displayHost?: import('../../../../../platform/window-display.js').WindowDisplayHost;
  /** Retain the logical device while suppressing all main-canvas presentation. */
  readonly presentationMode?: 'canvas' | 'none';
  readonly navigator: Navigator;
  readonly readViewportScreenMapping: () => AokanaViewportScreenMapping;
  /** Explicit host wheel-unit conversion; absent until a browser/device profile is selected. */
  readonly wheelTranslator?: AokanaMainWheelTranslator;
  /** Selected digitizer capability and browser compatibility-mouse policy. */
  readonly touchProfile?: {
    readonly available: boolean;
    readonly compatibilityMouse: 'owned';
  } | null;
  readonly monitors: readonly AokanaNativeRectangle[];
  readonly selectedMonitor: number;
  readonly primaryMonitor: number;
  readonly clientOrigin: readonly [number, number];
  readonly adapters: readonly AokanaConfiguredDisplayAdapter[];
  /** Selected monitor and D3D-adapter snapshot for delayed WM_DEVICECHANGE refresh. */
  readonly displayEnumerationHost?: WindowsDisplayEnumerationHost;
  /** Selected TranslateMessage layout bridge; browser default consumes exact DOM key evidence. */
  readonly characterTranslationHost?: WindowsCharacterTranslationHost;
  readonly damageCapacity: number;
  readonly childMetrics: AokanaChildWindowMetrics;
  readonly childWindowCoordinates?: import('../../../../../platform/browser-window-coordinates.js').WindowCoordinatesHost;
  readonly childWindowParent?: HTMLElement;
  readonly nativeWindowTitle: Uint8Array;
  /** Selected OS process/token/window/mutex primitives; no browser launch is inferred. */
  readonly externalProcessHost?: AokanaExternalProcessHost | null;
  /** Synchronous shell impersonation/execute primitives on that same selected host. */
  readonly shellExecuteHost?: AokanaShellExecuteHost | null;
  /** Selected synchronous native LoadLibraryA/export/call/FreeLibrary bridge. */
  readonly dynamicLibraryHost?: WindowsDynamicLibraryHost | null;
  /** Selected logical-drive enumeration, sharing the resource worker's drive-type host. */
  readonly logicalDriveHost?: AokanaLogicalDriveHost | null;
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
  readonly namedFileMappingHost?: WindowsNamedFileMappingHost | null;
  readonly directoryNamespaceHost?: WindowsDirectoryNamespaceHost | null;
  /** Explicit ShellLink primitive; absent in the partial browser graph. */
  readonly shellShortcutHost?: AokanaShellShortcutHost | null;
  /** Explicit WinINet-shaped host; absent in the partial graph. */
  readonly internetReadHost?: AokanaInternetReadHost | null;
  /** Explicit removable CD medium owner; absent unless the application selects a disc. */
  readonly cdMediaHost?: AokanaCdMediaHost | null;
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
  readonly desktopWallpaperHost?: AokanaDesktopWallpaperHost | null;
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
  readonly threadSleep: (milliseconds: number) => Promise<void>;
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
  readonly namedFileMappingHost: WindowsNamedFileMappingHost | null;
  readonly directoryNamespaceHost: WindowsDirectoryNamespaceHost | null;
  readonly shellShortcutHost: AokanaShellShortcutHost | null;
  readonly shellShortcuts: AokanaShellShortcuts | null;
  readonly internetReadHost: AokanaInternetReadHost | null;
  readonly internetReads: AokanaInternetReads | null;
  readonly cdMediaHost: AokanaCdMediaHost | null;
  readonly cdAudio: AokanaCdAudio | null;
  readonly playSoundHost: WindowsPlaySoundHost;
  readonly playSound: AokanaPlaySound;
  readonly installerDialogHost: WindowsInstallerDialogHost;
  readonly taskbarProgressHost: WindowsTaskbarProgressHost;
  readonly installerDialogs: AokanaInstallerDialogs;
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
  readonly diskImageService: AokanaDiskImageService;
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
  readonly textPresentation = new BrowserRasterTextPresentation();
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
  readonly fileAssociationHost: WindowsFileAssociationHost;
  readonly fileAssociations: AokanaFileAssociations;
  readonly desktopWallpaperHost: AokanaDesktopWallpaperHost | null;
  readonly wallpaper: AokanaWallpaper | null;
  readonly folders: AokanaSpecialFolders;
  readonly localized: AokanaLocalizedMessages;
  readonly inline: AokanaInlineTextControl;
  readonly controller: AokanaDisplayController;
  readonly children: AokanaChildWindows;
  readonly properties: AokanaPropertyEditors;
  readonly fullscreenMovie: AokanaFullscreenMovieState;
  readonly mfMovieVolume: AokanaMfMovieVolumePolicy;
  readonly mfSourceCandidates: AokanaMfMovieSourceCandidates;
  readonly mfMovieDocuments: AokanaMfMovieDocuments;
  readonly mfMovieSession: AokanaBrowserMfMovieSession;
  readonly traditionalMovieSession: AokanaBrowserTraditionalMovieSession;
  readonly movieSources: AokanaMovieSources;
  readonly externalMutexName: AokanaExternalMutexName;
  readonly installerManifest: AokanaInstallerManifestActions;
  readonly installerQueries: AokanaInstallerQueries;
  readonly installerShortcutCleanup: AokanaInstallerShortcutCleanup;
  readonly traditionalMovieAudio: AokanaTraditionalMovieAudioPolicy;
  readonly movies: AokanaMovieRegistry;
  readonly movieFramePosition: AokanaMovieFramePosition;
  readonly movieImageConfiguration: AokanaMovieImageConfiguration;
  readonly surfaceMovieFactory: AokanaBrowserSurfaceMovieFactory;
  readonly frames: AokanaDisplayFrames;
  readonly deviceEnumeration: AokanaDeviceEnumerationRefresh;
  readonly resource: AokanaProductionResourceWorker;
  readonly bmvRegistry: AokanaBmvRegistry;
  readonly bmvAsyncProcessing: AokanaDistributedProcessing;
  readonly bmvService: AokanaBmvService;
  readonly bmvPump: AokanaBmvWorkerPump;
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
  readonly nonclientMotion: AokanaMainWindowNonclientMotion;
  readonly queuedPaint: AokanaQueuedMainPaint;
  readonly queuedSize: AokanaQueuedMainSize;
  readonly queuedActivation: AokanaQueuedMainActivation;
  readonly queuedDispatcher: AokanaQueuedWindowDispatcher;
  readonly guiPump: AokanaGuiMessagePump;
  readonly showState: AokanaMainWindowShowState;
  readonly windowTransitions: AokanaMainWindowTransitions | null;
  readonly externalProcessWindow: AokanaExternalProcessWindow;
  readonly externalProcessHost: AokanaExternalProcessHost | null;
  readonly shellExecuteHost: AokanaShellExecuteHost | null;
  readonly externalProcesses: AokanaExternalProcesses | null;
  readonly dynamicLibraryHost: WindowsDynamicLibraryHost | null;
  readonly externalLibraries: AokanaExternalLibraries | null;
  readonly logicalDriveHost: AokanaLogicalDriveHost | null;
  readonly secondaryMedia: AokanaSecondaryMediaDiscovery | null;
  readonly sizeEffects: AokanaMainWindowSizeEffects;
  readonly domInput: AokanaMainDomInput;
  readonly touchWindow: AokanaBrowserTouchWindow | null;
  readonly touch: AokanaNativeTouch | null;
  private phase: 'constructed' | 'starting' | 'running' | 'closed' = 'constructed';
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private initialRenderPixelBudget: number | null = null;
  private displayInitialization: Promise<0 | 1> | null = null;
  private initializedDisplay = false;
  private readonly pendingMovieDocuments = new Set<Promise<AokanaMovieSourceDocument | null>>();
  private movieSourceResetting = false;
  private movieSourceGeneration = 0;
  private readonly movieMilliseconds: () => number;

  constructor(inputs: AokanaProductionDisplayResourceGraphInputs) {
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
        'Aokana production display requires monitor, damage, launch and folder inputs',
      );
    const moviePerformance = inputs.performance;
    this.movieMilliseconds = () => moviePerformance.now();
    this.readLocalTime =
      inputs.readLocalTime === undefined ? () => new Date() : inputs.readLocalTime;
    const rollback: (() => void)[] = [];
    try {
      rollback.push(() => this.textPresentation.dispose());
      this.allocator = new AokanaDistributedAllocator(inputs.processorCount);
      rollback.push(() => this.allocator.dispose());
      this.text = new AokanaNativeText();
      this.title = new AokanaWindowTitle(inputs.nativeWindowTitle);
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
          'Aokana directory namespace host requires selected list/fold primitives',
        );
      if (
        inputs.engineCaption != null &&
        (!(inputs.engineCaption instanceof Uint8Array) || inputs.engineCaption.indexOf(0) < 0)
      )
        throw new TypeError('Aokana engine caption requires selected NUL-terminated raw bytes');
      this.engineCaption =
        inputs.engineCaption?.slice() ??
        new TextEncoder().encode(AOKANA_INTERNET_USER_AGENT + '\0');
      this.clock = new AokanaNativeClock(() => inputs.performance.now());
      this.threadSleep = inputs.resource.sleep;
      this.cpuHost = inputs.cpuHost;
      this.systemProfileHost =
        inputs.systemProfileHost === undefined
          ? new BrowserWindowsSystemProfileHost()
          : inputs.systemProfileHost;
      this.systemProfile =
        this.systemProfileHost === null ? null : new AokanaSystemProfile(this.systemProfileHost);
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
          'Aokana device-power host requires selected system and device primitives',
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
        throw new TypeError('Aokana named-mutex host requires selected synchronous primitives');
      this.namedMutexes =
        this.namedMutexHost === null ? null : new AokanaNamedMutexes(this.namedMutexHost);
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
        throw new TypeError('Aokana picker host requires selected file and folder capabilities');
      this.shellShortcutHost =
        inputs.shellShortcutHost === undefined
          ? new BrowserWindowsShellLinkHost()
          : inputs.shellShortcutHost;
      if (
        this.shellShortcutHost !== null &&
        typeof this.shellShortcutHost.createShellLink !== 'function'
      )
        throw new TypeError('Aokana ShellLink host requires a selected creation primitive');
      this.internetReadHost =
        inputs.internetReadHost === undefined
          ? new AokanaBrowserInternetReadHost()
          : inputs.internetReadHost;
      if (
        this.internetReadHost !== null &&
        (typeof this.internetReadHost.read !== 'function' ||
          typeof this.internetReadHost.start !== 'function')
      )
        throw new TypeError('Aokana internet-read host requires selected read/start primitives');
      this.cdMediaHost =
        inputs.cdMediaHost === undefined ? new BrowserCdAudioMediaHost() : inputs.cdMediaHost;
      if (this.cdMediaHost !== null && typeof this.cdMediaHost.open !== 'function')
        throw new TypeError('Aokana CD host requires a selected medium-open primitive');
      this.cdAudio =
        this.cdMediaHost === null
          ? null
          : new AokanaCdAudio(this.cdMediaHost, (token) =>
              this.messages.postCdSuccessfulNotification(token),
            );
      if (this.cdAudio !== null) rollback.push(() => this.cdAudio!.dispose());
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
      this.gamepadHost =
        inputs.gamepadHost === undefined
          ? new AokanaBrowserGamepads(inputs.navigator, [])
          : inputs.gamepadHost;
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
      this.fontProvider = inputs.fontProvider ?? new AokanaBrowserFonts();
      this.fonts = new AokanaNativeFonts(this.text, this.fontProvider);
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
          : new AokanaBrowserTouchWindow(this.host, selectedTouchProfile.available);
      this.touch =
        this.touchWindow === null
          ? null
          : new AokanaNativeTouch(this.input, this.clock, this.touchWindow);
      // Validate the selected host geometry before borrowing it for adapter selection.
      this.host.readRestoredOuterScreenRectangle();
      this.adapters = new AokanaDisplayAdapters(
        this.display,
        inputs.adapters,
        inputs.primaryMonitor,
        () => this.host.readRestoredOuterScreenRectangle(),
      );
      this.device = new AokanaDisplayDevice(
        inputs.canvas,
        this.manager,
        this.clock,
        this.adapters,
        inputs.presentationMode ?? 'canvas',
        inputs.presentationMode === 'none' ? null : this.textPresentation,
      );
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
      this.movieImageConfiguration = new AokanaMovieImageConfiguration();
      this.surfaceMovieFactory = new AokanaBrowserSurfaceMovieFactory(
        this,
        inputs.document,
        this.movieImageConfiguration,
        inputs.surfaceMovieDocumentByteBudget ?? 0xffffffff,
      );
      this.mfMovieVolume = new AokanaMfMovieVolumePolicy(this.fullscreenMovie);
      this.traditionalMovieAudio = new AokanaTraditionalMovieAudioPolicy();
      this.registry = new AokanaNativeRegistry(inputs.registryStore);
      this.fileAssociationHost =
        inputs.fileAssociationHost ?? new BrowserWindowsFileAssociationHost();
      for (const operation of [
        'createKey',
        'setValue',
        'postMessageA',
        'shellChangeNotify',
      ] as const)
        if (typeof this.fileAssociationHost[operation] !== 'function')
          throw new TypeError(`Aokana file-association host lacks ${operation}`);
      this.fileAssociations = new AokanaFileAssociations(this.fileAssociationHost, this.text);
      this.desktopWallpaperHost =
        inputs.desktopWallpaperHost === undefined
          ? new BrowserWindowsDesktopWallpaperHost()
          : inputs.desktopWallpaperHost;
      if (
        this.desktopWallpaperHost !== null &&
        typeof this.desktopWallpaperHost.setWallpaper !== 'function'
      )
        throw new TypeError('Aokana desktop wallpaper host requires a selected effect primitive');
      this.wallpaper =
        this.desktopWallpaperHost === null
          ? null
          : new AokanaWallpaper(this.registry, this.desktopWallpaperHost, this.text);
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
        inputs.childWindowParent ?? inputs.parent,
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
        inputs.presentationMode ?? 'canvas',
        inputs.childWindowCoordinates ?? null,
        inputs.presentationMode === 'none' ? null : this.textPresentation,
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
      const displayEnumerationHost =
        inputs.displayEnumerationHost ??
        new BrowserWindowsDisplayEnumerationHost(inputs.monitors, inputs.adapters.length);
      if (
        typeof displayEnumerationHost.enumerateMonitors !== 'function' ||
        typeof displayEnumerationHost.adapterCount !== 'function'
      )
        throw new TypeError(
          'Aokana display enumeration requires selected monitor and adapter primitives',
        );
      this.deviceEnumeration = new AokanaDeviceEnumerationRefresh(
        this.clock,
        this.display,
        this.frames,
        this.gamepads,
        displayEnumerationHost,
      );
      this.callbacks.bind(this.host, this.controller, this.frames);
      const browserDriveHost = new BrowserWindowsLogicalDriveHost();
      const sharedDriveHost = inputs.resource.driveHost ?? browserDriveHost;
      this.resource = new AokanaProductionResourceWorker({
        ...inputs.resource,
        driveHost: sharedDriveHost,
        driveGeometryHost:
          inputs.resource.driveGeometryHost ??
          (inputs.resource.driveHost === undefined ? browserDriveHost : undefined),
        temporaryFileHost:
          inputs.resource.temporaryFileHost === undefined
            ? new AokanaBrowserTemporaryFileHost(
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
      this.diskImageService = new AokanaDiskImageService(
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
        throw new TypeError('Aokana PlaySoundW requires a selected synchronous host');
      this.playSound = new AokanaPlaySound(this.resource.resources, this.playSoundHost);
      this.installerDialogHost =
        inputs.installerDialogHost ??
        new BrowserWindowsInstallerDialogHost(inputs.document, inputs.parent);
      if (
        typeof this.installerDialogHost.chooseDestination !== 'function' ||
        typeof this.installerDialogHost.chooseComponent !== 'function' ||
        typeof this.installerDialogHost.runProgress !== 'function'
      )
        throw new TypeError('Aokana installer dialogs require a selected modal host');
      this.taskbarProgressHost =
        inputs.taskbarProgressHost ?? new BrowserWindowsTaskbarProgressHost();
      if (typeof this.taskbarProgressHost.createTaskbarList3 !== 'function')
        throw new TypeError('Aokana installer progress requires a selected taskbar host');
      this.installerDialogs = new AokanaInstallerDialogs(
        this.installerDialogHost,
        this.dialogs,
        this.folderSelection,
        this.resource.files,
        this.localized.language,
      );
      this.bmvRegistry = new AokanaBmvRegistry(this.allocator);
      rollback.push(() => this.bmvRegistry.clear());
      this.bmvAsyncProcessing = new AokanaDistributedProcessing(
        this.allocator,
        this.resource.processing.capacity,
      );
      rollback.push(() => this.bmvAsyncProcessing.dispose());
      this.bmvService = new AokanaBmvService(
        this.bmvRegistry,
        this.surfaces,
        this.resource.loading.ranges,
        this.resource.processing,
        this.bmvAsyncProcessing,
      );
      this.bmvPump = new AokanaBmvWorkerPump(this.bmvService);
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
      // Native engine startup (0x1400c3900) calls BGI_FontResource_Reset(0),
      // registering the two built-in font names before any script callback.
      this.fontResources.reset(false, (this.localized.language.value & 0x3ff) === 0x11);
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
      this.fileEnumeration = new AokanaFileEnumeration(
        this.resource.files,
        this.directoryNamespaceHost,
      );
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
      this.mfMovieDocuments = new AokanaMfMovieDocuments(
        this.mfSourceCandidates,
        this.resource.files,
        inputs.mfMovieDocumentByteBudget ?? 0xffffffff,
      );
      this.mfMovieSession = new AokanaBrowserMfMovieSession(
        this.mfMovieDocuments,
        inputs.document,
        this.host,
        this.fullscreenMovie,
        this.mfMovieVolume,
      );
      this.traditionalMovieSession = new AokanaBrowserTraditionalMovieSession(
        this.resource.resources,
        this.mfMovieDocuments,
        inputs.document,
        this.device,
        this.movieImageConfiguration,
        this.fullscreenMovie,
        this.traditionalMovieAudio,
      );
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
      this.host.bindCloseMenu(this.input, this.messages);
      this.droppedFiles = new AokanaDroppedFiles(
        inputs.canvas,
        this.messages,
        this.resource.files,
        inputs.resource.mounted,
        inputs.drop.mountedRoot,
        inputs.drop.nativeRoot,
      );
      rollback.push(() => this.droppedFiles.dispose());
      this.nonclientMotion = new AokanaMainWindowNonclientMotion(
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
        throw new TypeError('Aokana named file mapping requires a selected read primitive');
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
        this.touch,
        this.cdAudio,
        this.deviceEnumeration,
        this.nonclientMotion,
        this.namedFileMappingHost,
      );
      this.sizeEffects = new AokanaMainWindowSizeEffects(this);
      this.queuedPaint = new AokanaQueuedMainPaint(
        this.messages,
        this.waits,
        this.initialized,
        this.device,
        this.frames,
      );
      this.queuedSize = new AokanaQueuedMainSize(
        this.messages,
        this.waits,
        this.initialized,
        this.host,
        this.input,
        this.sizeEffects,
      );
      this.queuedActivation = new AokanaQueuedMainActivation(
        this.messages,
        this.waits,
        this.initialized,
        this.host,
        this.input,
        this.clock,
        this.movies,
      );
      this.queuedDispatcher = new AokanaQueuedWindowDispatcher(
        this.messages,
        this.queuedPaint,
        this.queuedSize,
        this.queuedActivation,
      );
      this.guiPump = new AokanaGuiMessagePump(
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
        this.windowTransitions = new AokanaMainWindowTransitions(
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
          'Aokana scoped restore requires a visible container outside the main window',
        );
      else this.windowTransitions = null;
      this.showState = new AokanaMainWindowShowState(
        this.host,
        this.input,
        this.messages,
        this.queuedDispatcher,
      );
      this.externalProcessWindow = new AokanaExternalProcessWindow(
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
          throw new TypeError('Aokana external-process host requires the selected system profile');
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
            throw new TypeError(`Aokana external-process host lacks ${operation}`);
      }
      this.shellExecuteHost =
        inputs.shellExecuteHost === undefined
          ? this.externalProcessHost === browserProcessHost
            ? browserProcessHost
            : null
          : inputs.shellExecuteHost;
      if (this.shellExecuteHost !== null) {
        if (!Object.is(this.shellExecuteHost, this.externalProcessHost))
          throw new TypeError('Aokana shell execute requires the selected process host');
        for (const operation of [
          'impersonateLoggedOnUser',
          'shellExecuteW',
          'revertToSelf',
        ] as const)
          if (typeof this.shellExecuteHost[operation] !== 'function')
            throw new TypeError(`Aokana shell-execute host lacks ${operation}`);
      }
      this.externalProcesses =
        this.externalProcessHost === null
          ? null
          : new AokanaExternalProcesses(
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
            throw new TypeError(`Aokana dynamic-library host lacks ${operation}`);
      }
      this.externalLibraries =
        this.dynamicLibraryHost === null
          ? null
          : new AokanaExternalLibraries(
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
          throw new TypeError('Aokana logical-drive discovery requires the shared drive host');
      }
      this.secondaryMedia =
        this.logicalDriveHost === null
          ? null
          : new AokanaSecondaryMediaDiscovery(
              this.resource.resources,
              this.localized,
              this.logicalDriveHost,
              {sleep: inputs.resource.sleep},
              this.externalProcessWindow,
            );
      this.syntheticMouse = new AokanaSyntheticMouse(this.input, this.messages);
      this.callbacks.bindReadyReceiver(this.host, this.receiver);
      this.messages.send('main', 1, 0, 0);
      this.domInput = new AokanaMainDomInput(
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
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer,
    maxBytes: number,
  ): Promise<AokanaMovieSourceDocument | null> {
    if (this.phase === 'closed' || this.closing !== null || this.movieSourceResetting)
      throw new Error('Aokana production movie source graph is closed');
    const generation = this.movieSourceGeneration;
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
      const document = await preparing;
      if (generation !== this.movieSourceGeneration || this.movieSourceResetting)
        throw new Error('Aokana movie source prepared across a program reset');
      return document;
    } finally {
      this.pendingMovieDocuments.delete(preparing);
    }
  }

  /** Close source admission before ECB90 reuses movie/surface slots, then join accepted reads. */
  async beginMovieSourceReset(): Promise<() => void> {
    if (this.phase === 'closed' || this.closing !== null || this.movieSourceResetting)
      throw new Error('Aokana movie source reset requires an open idle graph');
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
  createMovieReferenceClock(): AokanaMovieReferenceClock {
    if (this.phase === 'closed' || this.closing !== null || this.movieSourceResetting)
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
      return Promise.reject(new Error('Aokana display startup requires the pre-worker graph'));
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
      return Promise.reject(new Error('Aokana production display/resource graph is already used'));
    if (this.displayInitialization !== null && !this.initializedDisplay)
      return Promise.reject(new Error('Aokana display startup has not completed successfully'));
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
    const surfaceMovieJoining = this.surfaceMovieFactory.closeAndJoin();
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
