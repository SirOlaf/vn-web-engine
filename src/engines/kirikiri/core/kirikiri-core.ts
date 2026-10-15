/**
 * The Kirikiri core: the TJS2 engine with the TVP services and native classes of one core
 * build, and the start-up sequence of the executable (`TVPInitScriptEngine`,
 * `TVPSystemInit`, `TVPExecuteStartupScript`).
 *
 * `KirikiriCore.create` prepares what the native core reads synchronously: the message tables
 * and exporter names of the executable, the hashes of plugin files. `start` runs start-up as a
 * suspendable top-level call.
 */
import {inflateZlib} from '../../../core/inflate.js';
import {sha256} from '../../../core/sha256.js';
import {PeImage} from '../../../formats/pe/image.js';
import {
  NativeLibraryLoader,
  type NativeLibraryIdentity,
  type NativeLibraryImplementation,
} from '../../../platform/native-libraries.js';
import {decodeCp932} from '../../../text/cp932.js';
import {ENGLISH_MESSAGES, readKirikiriMessages} from '../messages.js';
import {
  KIRIKIRI_CORE_REVISIONS,
  tjs2CompilerOptions,
  type KirikiriCoreRevision,
} from '../revision.js';
import {TjsEngine, type TjsHost, type TjsTextWriter} from '../tjs2/runtime/engine.js';
import {assignTjsMessage, setTjsMessages, TjsError, tjsMessage} from '../tjs2/runtime/errors.js';
import {
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_STATICMEMBER,
  type Dispatch,
  type TjsBinaryStream,
  type TvpFunctionExporter,
  type TvpStorageMedia,
} from '../tjs2/runtime/interface.js';
import type {NativeClass} from '../tjs2/runtime/native.js';
import {tjsDoRehash} from '../tjs2/runtime/custom-object.js';
import {obj} from '../tjs2/runtime/variant.js';
import {TjsVm} from '../tjs2/vm/executor.js';
import {defaultWindowsSysColor} from '../../../platform/windows-system-colors.js';
import {PageWindowsNamedMutexes} from '../../../platform/windows-named-mutex.js';
import {createAsyncTriggerClass} from './classes/async-trigger.js';
import {createDebugClass, createPluginsClass} from './classes/debug-plugins.js';
import {createScriptsClass, executeStorage, type ScriptsServices} from './classes/scripts.js';
import {createStoragesClass, type StoragesPlatform} from './classes/storages.js';
import {
  createSystemClass,
  UNMANIFESTED_WINDOWS_VERSION,
  type GraphicCacheControl,
  type KirikiriSystemPlatform,
  type SystemServices,
} from './classes/system.js';
import {createTimerClass} from './classes/timer.js';
import {
  TVP_COMPACT_LEVEL_IDLE,
  timerMessageLoop,
  TvpEventSystem,
  TvpProcessExit,
  type KirikiriMessageLoop,
} from './events.js';
import {TvpLog, type LogClock} from './log.js';
import {
  changeFileExt,
  dataPathDirectory,
  ProgramArguments,
  readConfigLines,
  readEmbeddedOptions,
  type SpecialFolders,
} from './options.js';
import {PluginManager} from './plugins.js';
import {
  ARCHIVE_DELIMITER,
  extractStorageName,
  extractStoragePath,
  FileMedia,
  StorageSystem,
  type KirikiriLocalFiles,
} from './storage.js';
import {openTextWriteStorage, readTextStorage, type TextReadOptions} from './text-stream.js';

/** Time sources of the core. */
export interface KirikiriClock extends LogClock {
  /** `TVPGetTickCount`: milliseconds. */
  tickCount(): number;
}

export interface KirikiriCoreConfig {
  /**
   * The core executable. Its SHA-256 selects the revision; its message tables and exporter
   * names are read. Without it, `revision` must be given and built-in English messages are used.
   */
  readonly executable?: Uint8Array;
  readonly revision?: KirikiriCoreRevision;
  /** Its local name, `c:\game\nekopara_vol1.exe`. */
  readonly executablePath: string;
  /** The user's UI language (LANGID): selects message tables. */
  readonly uiLanguage: number;
  readonly files: KirikiriLocalFiles;
  /** Plugin and system library implementations the runtime registers. */
  readonly libraries: readonly NativeLibraryImplementation<object>[];
  /**
   * The command line after the executable (`-name=value`, a bare `-name` meaning `yes`).
   * Configuration files and the executable's embedded options follow it in priority.
   */
  readonly commandLine?: readonly string[];
  /** Shell folders as local Windows paths; empty when absent. */
  readonly specialFolders?: Partial<SpecialFolders>;
  /** Platform services of `System`; absent ones answer as a system without the feature. */
  readonly system?: Partial<KirikiriSystemPlatform>;
  /** The host's message loop; host timers by default. */
  readonly loop?: KirikiriMessageLoop;
  /**
   * `Application->MessageDlg` for an uncaught script error. Resolves when closed; by default
   * the error is only logged.
   */
  readonly showError?: (text: string, caption: string) => Promise<void>;
  /** Called once when the core has ended (`System.exit`, `System.terminate`, a fatal error). */
  readonly onExit?: (code: number) => void;
  readonly clock: KirikiriClock;
  /** Every log line as the console shows it. */
  readonly output?: (line: string, important: boolean) => void;
  readonly storagesPlatform?: Partial<StoragesPlatform>;
  /** `MultiByteToWideChar(CP_ACP)`; CP932 by default. */
  readonly decodeAnsi?: (bytes: Uint8Array) => string;
  /** `TVPGetRandomBits128`. */
  readonly randomBits128?: () => Uint8Array;
}

/** What `create` reads for `TVPInitProgramArgumentsAndDataPath`. */
interface PreparedOptions {
  readonly embedded: string[] | null;
  readonly config: {readonly name: string; readonly lines: string[] | null};
  readonly userConfig: {readonly name: string; readonly lines: string[] | null};
  /** Native data path, with a trailing backslash. */
  readonly nativeDataPath: string;
  /** `TVPInitTJSScript` of the executable; null without it. */
  readonly initScript: string | null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function lower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** `IncludeTrailingBackslash(ExtractFileDir(path))`. */
function localDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf('\\') + 1);
}

export class KirikiriCore {
  readonly engine: TjsEngine;
  readonly storage: StorageSystem;
  readonly log: TvpLog;
  readonly plugins: PluginManager;
  readonly exporter: TvpFunctionExporter;
  readonly loader: NativeLibraryLoader;
  readonly events: TvpEventSystem;
  readonly #arguments: ProgramArguments;
  readonly #nativeDataPath: string;
  readonly #specialFolders: SpecialFolders;
  readonly #platform: KirikiriSystemPlatform;
  readonly #loop: KirikiriMessageLoop;
  #title: string;
  readonly #systemFlags = {
    exitOnWindowClose: true,
    exitOnNoWindowStartup: true,
    drawThreadNum: 1,
  };
  #graphicCacheLimit = 0n;
  /** `TVPGraphicCacheSystemLimit`: 0 until the graphics loader keeps a cache. */
  readonly #graphicCacheSystemLimit = 0n;
  #exitCode: number | null = null;
  #uninitialized = false;
  #defaultReadEncoding = 'UTF-8';
  #scriptTextEncoding = 'UTF-8';
  #logLocation = '';
  #projectDir = '';
  readonly #decodeAnsi: (bytes: Uint8Array) => string;

  private constructor(
    readonly config: KirikiriCoreConfig,
    readonly revision: KirikiriCoreRevision,
    readonly exporterNames: ReadonlySet<string>,
    private readonly libraryIdentities: Map<string, NativeLibraryIdentity>,
    options: PreparedOptions,
  ) {
    setTjsMessages(
      config.executable
        ? readKirikiriMessages(config.executable, config.uiLanguage)
        : ENGLISH_MESSAGES,
    );
    this.#decodeAnsi = config.decodeAnsi ?? decodeCp932;
    this.#specialFolders = {
      personal: config.specialFolders?.personal ?? '',
      appData: config.specialFolders?.appData ?? '',
      savedGames: config.specialFolders?.savedGames ?? '',
    };
    this.#platform = systemPlatform(config.system);
    this.#loop = config.loop ?? timerMessageLoop();
    this.#title = tjsMessage('TVPKirikiri');

    const host: TjsHost = {
      readText: (name, mode) => this.readText(name, mode),
      openTextWrite: (name, mode) => this.openTextWrite(name, mode),
      print: (line) => this.log.add(line),
      time: () => config.clock.time(),
      randomBits128: config.randomBits128,
    };
    this.engine = new TjsEngine(host);
    this.log = new TvpLog(config.clock, this.engine.suspender, config.output ?? (() => {}));
    // TVPInitProgramArgumentsAndDataPath
    if (options.embedded)
      this.log.add(tjsMessage('TVPInfoLoadingExecutableEmbeddedOptionsSucceeded'), true);
    this.#logConfigFile(options.config);
    this.#logConfigFile(options.userConfig);
    this.#arguments = ProgramArguments.build(
      config.commandLine ?? [],
      options.userConfig.lines,
      options.config.lines,
      options.embedded,
    );
    this.#nativeDataPath = options.nativeDataPath;
    this.storage = new StorageSystem(
      new FileMedia(config.files),
      (line) => this.log.add(line),
      () => config.clock.tickCount(),
    );
    this.loader = new NativeLibraryLoader(config.libraries, {
      locate: (fileName) => this.#locateLibrary(fileName),
    });
    this.#logLocation = this.storage.normalize(this.#nativeDataPath);
    this.log.add(tjsMessage('TVPInfoDataPath', this.dataPath), true);
    this.events = new TvpEventSystem(
      {
        engine: this.engine,
        log: this.log,
        loop: this.#loop,
        tickCount: () => config.clock.tickCount(),
        continuousFrequency: () => Number(this.getCommandLine('-contfreq') ?? 0) | 0,
        showError: (text, caption) => this.#showError(text, caption),
        title: () => this.#title,
        terminate: (code) => this.terminate(code),
        exit: (code) => this.exit(code),
        uninitialized: () => this.#uninitialized,
      },
      () => tjsDoRehash(),
    );
    this.exporter = this.#createExporter();
    this.plugins = new PluginManager({
      loader: this.loader,
      exporter: this.exporter,
      locate: (name) => this.#locatePlugin(name),
    });
    this.#initScriptEngine(options.initScript);
  }

  /** Reads what the core needs synchronously, then builds the core. */
  static async create(config: KirikiriCoreConfig): Promise<KirikiriCore> {
    const decodeAnsi = config.decodeAnsi ?? decodeCp932;
    let revision = config.revision;
    let exporterNames = new Set<string>();
    if (config.executable) {
      const exeHash = hex(await sha256(config.executable));
      revision = KIRIKIRI_CORE_REVISIONS.get(exeHash);
      if (!revision) throw new Error(`Unsupported Kirikiri core build ${exeHash}`);
      exporterNames = await readExporterNames(config.executable, revision);
    }
    if (!revision) throw new Error('A Kirikiri core needs its executable or a revision');
    const identities = new Map<string, NativeLibraryIdentity>();
    const exeDir = localDirectory(config.executablePath);
    for (const dir of [exeDir, exeDir + 'system\\', exeDir + 'plugin\\']) {
      for (const file of config.files.list(dir)) {
        if (!/\.(dll|tpm)$/i.test(file)) continue;
        const local = dir + file;
        const source = await config.files.open(local);
        const bytes = await source.read(0, source.size);
        identities.set(lower(local), {kind: 'image', sha256: hex(await sha256(bytes))});
      }
    }
    const options = await prepareOptions(config, decodeAnsi, revision);
    return new KirikiriCore(config, revision, exporterNames, identities, options);
  }

  #logConfigFile(file: {name: string; lines: string[] | null}): void {
    if (file.lines)
      this.log.add(tjsMessage('TVPInfoLoadingConfigurationFileSucceeded', file.name), true);
    else
      this.log.add(
        tjsMessage(
          'TVPInfoLoadingConfigurationFileFailed',
          file.name,
          tjsMessage('TVPFileNotFound'),
        ),
        true,
      );
  }

  // --- services ---------------------------------------------------------------------------

  /** `TVPGetCommandLine`. */
  getCommandLine(name: string): string | null {
    return this.#arguments.get(name);
  }

  /** `TVPSetCommandLine`: replaces an option, or inserts it with the highest priority. */
  setCommandLine(name: string, value: string): void {
    this.#arguments.set(name, value);
  }

  /** `TVPDataPath`: the data folder as a storage name. */
  get dataPath(): string {
    return this.storage.normalize(this.#nativeDataPath);
  }

  /** The exit code once the core has ended, else null. */
  get exitCode(): number | null {
    return this.#exitCode;
  }

  /** `TVPGetPersonalPath`/`TVPGetAppDataPath`: a shell folder as a storage name. */
  #folderPath(path: string, fallback: string | null): string {
    if (!path) return fallback ?? '';
    const name = this.storage.normalize(path);
    return name.endsWith('/') ? name : name + '/';
  }

  /** `TVPGetAppPath`: the executable's folder as a storage name. */
  get appPath(): string {
    return extractStoragePath(this.storage.normalize(this.config.executablePath));
  }

  #textOptions(encoding: string): TextReadOptions {
    return {encoding, decodeAnsi: this.#decodeAnsi};
  }

  /** `TVPCreateTextStreamForRead` with the default read encoding. */
  readText(name: string, mode: string): string | Promise<string> {
    return readTextStorage(
      (n, flags) => this.storage.createStream(n, flags),
      name,
      mode,
      this.#textOptions(this.#defaultReadEncoding),
    );
  }

  /** `TVPCreateTextStreamForWrite`. */
  openTextWrite(name: string, mode: string): TjsTextWriter {
    return openTextWriteStorage((n, flags) => this.storage.createStream(n, flags), name, mode);
  }

  // --- libraries --------------------------------------------------------------------------

  #locateLibrary(fileName: string): NativeLibraryIdentity | null {
    const key = lower(fileName);
    const exact = this.libraryIdentities.get(key);
    if (exact) return exact;
    if (!fileName.includes('\\')) {
      // LoadLibrary search: the executable's folder, then the system.
      const local = this.libraryIdentities.get(
        lower(localDirectory(this.config.executablePath) + fileName),
      );
      if (local) return local;
      return {kind: 'system', fileName: key};
    }
    return null;
  }

  /** `tTVPPluginHolder`: storage first, then the executable's folder, `system\`, `plugin\`. */
  #locatePlugin(name: string): string | null | Promise<string | null> {
    const place = this.storage.getPlacedPath(name);
    if (place) {
      const local = this.storage.getLocallyAccessibleName(place);
      if (local) return local;
      // Natively extracted to a temporary file; here identified by its contents.
      const opened = this.storage.createStream(place, 0);
      return Promise.resolve(opened).then(async (stream: TjsBinaryStream) => {
        await stream.prefetch(0, stream.getSize());
        stream.seek(0, 0);
        const bytes = stream.read(stream.getSize());
        stream.destruct();
        const temp = 'temp:\\' + extractStorageName(place);
        this.libraryIdentities.set(lower(temp), {kind: 'image', sha256: hex(await sha256(bytes))});
        return temp;
      });
    }
    const exeDir = localDirectory(this.config.executablePath);
    for (const dir of [exeDir, exeDir + 'system\\', exeDir + 'plugin\\'])
      if (this.config.files.exists(dir + name)) return dir + name;
    return null;
  }

  #createExporter(): TvpFunctionExporter {
    const storage = this.storage;
    return {
      has: (signature) => this.exporterNames.has(signature),
      suspend: (promise, then) => this.engine.suspender.suspend(promise, then),
      TVPGetScriptDispatch: () => {
        this.engine.global.addRef();
        return this.engine.global;
      },
      TJSCreateArrayObject: () => this.engine.createArray(),
      TJSCreateDictionaryObject: () => this.engine.createDictionary(),
      TVPAddLog: (message) => this.log.add(message),
      TVPAddImportantLog: (message) => this.log.add(message, true),
      TVPGetCommandLine: (name) => this.getCommandLine(name),
      TVPSetCommandLine: (name, value) => this.setCommandLine(name, value),
      TVPGetAppPath: () => this.appPath,
      TVPRegisterStorageMedia: (media: TvpStorageMedia) => storage.registerMedia(media),
      TVPUnregisterStorageMedia: (media: TvpStorageMedia) => storage.unregisterMedia(media),
      TVPSetCurrentDirectory: (name) => storage.setCurrentDirectory(name),
      TVPNormalizeStorageName: (name) => storage.normalize(name),
      TVPExtractStorageName: extractStorageName,
      TVPExtractStoragePath: extractStoragePath,
      TVPAddAutoPath: (name) => storage.addAutoPath(name),
      TVPRemoveAutoPath: (name) => storage.removeAutoPath(name),
      TVPClearStorageCaches: () => storage.clearStorageCaches(),
      TVPIsExistentStorage: (name) => storage.isExistentStorage(name),
      TVPCreateStream: (name, flags) => storage.createStream(name, flags),
    };
  }

  // --- script engine --------------------------------------------------------------------------

  #scriptsServices(): ScriptsServices {
    return {
      engine: this.engine,
      storage: this.storage,
      scriptTextOptions: () => this.#textOptions(this.#scriptTextEncoding),
      setScriptTextEncoding: (encoding) => {
        this.#scriptTextEncoding = encoding;
      },
      dump: () => {
        throw new TjsError('Scripts.dump: the TJS2 VM is not available');
      },
      stackTrace: () => '',
    };
  }

  /**
   * `TVPInitScriptEngine`: options that configure TJS, then the core classes in the order the
   * reference build registers them (0x407010). Classes this core does not provide yet are
   * skipped; their position in the order is kept by the list.
   */
  #initScriptEngine(initScript: string | null): void {
    const readEncoding = this.getCommandLine('-readencoding');
    if (readEncoding !== null) this.#defaultReadEncoding = readEncoding;
    // `-unaryaster=compat` and `-evalcontext=global` change how scripts compile and run.
    this.engine.executor = new TjsVm(this.engine, {
      compiler: tjs2CompilerOptions(this.revision, {
        uiLanguage: this.config.uiLanguage,
        executable: this.config.executable,
        unaryAsteriskIgnoresPropAccess: this.getCommandLine('-unaryaster') === 'compat',
        evalOperatorIsOnGlobal: this.getCommandLine('-evalcontext') === 'global',
      }),
    });
    if (initScript !== null)
      this.engine.runScript(
        {text: initScript, name: '', lineOffset: 0, mode: 'statements'},
        null,
        null,
      );
    const platform: StoragesPlatform = {
      searchCD: this.config.storagesPlatform?.searchCD ?? (() => ''),
      selectFile: this.config.storagesPlatform?.selectFile ?? (() => false),
    };
    const classes: [string, () => NativeClass | null][] = [
      [
        'Debug',
        () =>
          createDebugClass({
            log: this.log,
            logLocation: () => this.#logLocation,
            setLogLocation: (location) => {
              this.#logLocation = this.storage.normalize(location);
            },
          }),
      ],
      ['Font', () => null],
      ['Layer', () => null],
      [
        'Timer',
        () =>
          createTimerClass(
            this.engine,
            this.events,
            this.#loop,
            () => this.config.clock.tickCount(),
            (name) => this.getCommandLine(name),
          ),
      ],
      ['AsyncTrigger', () => createAsyncTriggerClass(this.engine, this.events)],
      ['System', () => createSystemClass(this.#systemServices())],
      ['Storages', () => createStoragesClass(this.storage, platform, this.engine.suspender)],
      ['Plugins', () => createPluginsClass(this.engine, this.plugins)],
      ['VideoOverlay', () => null],
      ['Clipboard', () => null],
      ['Scripts', () => createScriptsClass(this.#scriptsServices())],
      ['Rect', () => null],
      ['Bitmap', () => null],
      ['ImageFunction', () => null],
      ['BitmapLayerTreeOwner', () => null],
      ['WaveSoundBuffer', () => null],
      ['Window', () => null],
    ];
    // TVPTJSGCCallback: the VM's stack is compacted at idle.
    this.events.addCompactEventHook({
      onCompact: (level) => {
        if (level >= TVP_COMPACT_LEVEL_IDLE) this.engine.executor?.doGarbageCollection();
      },
    });
    const global = this.engine.global;
    for (const [name, create] of classes) {
      const cls = create();
      if (!cls) continue;
      global.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, name, obj(cls), global);
      cls.release();
    }
  }

  #systemServices(): SystemServices {
    const exeName = this.storage.normalize(this.config.executablePath);
    const graphicCache: GraphicCacheControl = {
      limit: () => this.#graphicCacheLimit,
      // TVPSetGraphicCacheLimit: 0 disables, -1 selects the system limit, larger values are
      // clamped to it.
      setLimit: (limit) => {
        const system = this.#graphicCacheSystemLimit;
        this.#graphicCacheLimit =
          limit === 0n ? 0n : limit === 0xffffffffffffffffn || limit > system ? system : limit;
      },
      clear: () => {},
      touch: () => {},
    };
    return {
      events: this.events,
      suspender: this.engine.suspender,
      platform: this.#platform,
      graphicCache,
      getArgument: (name) => this.getCommandLine(name),
      setArgument: (name, value) => this.setCommandLine(name, value),
      appPath: () => this.appPath,
      personalPath: () =>
        this.#folderPath(
          this.#specialFolders.personal || this.#specialFolders.appData,
          this.appPath,
        ),
      appDataPath: () => this.#folderPath(this.#specialFolders.appData, this.appPath),
      savedGamesPath: () => this.#specialFolders.savedGames,
      dataPath: () => this.dataPath,
      exeName: () => exeName,
      versionString: () => this.revision.fileVersion,
      versionInformation: () =>
        tjsMessage(
          'TVPVersionInformation',
          this.revision.fileVersion,
          this.revision.tjsVersion.join('.'),
        )
          .split('%DATE%')
          .join(this.revision.compileDate)
          .split('%TIME%')
          .join(this.revision.compileTime),
      title: () => this.#title,
      setTitle: (title) => {
        this.#title = title;
        this.#platform.setApplicationTitle(title);
      },
      tickCount: () => this.config.clock.tickCount(),
      randomBits128: () => this.#randomBits128(),
      assignMessage: (id, message) => assignTjsMessage(id, message),
      terminate: (code) => this.terminate(code),
      exit: (code) => this.exit(code),
      dumpHeap: () => this.log.add('The process has 0 heaps.'),
      flags: this.#systemFlags,
    };
  }

  #randomBits128(): Uint8Array {
    if (this.config.randomBits128) return this.config.randomBits128();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  async #showError(text: string, caption: string): Promise<void> {
    await this.config.showError?.(text, caption);
  }

  /** `TVPTerminateAsync`: ends after the current top-level call. */
  terminate(code: number): void {
    if (this.#exitCode !== null) return;
    this.#exitCode = code;
    this.events.stop();
    void this.events
      .runTopLevel(() => 0)
      .then(
        () => this.#finish(code),
        () => this.#finish(code),
      );
  }

  /** `TVPTerminateSync`: uninitializes the core and ends the process; never returns. */
  exit(code: number): never {
    if (this.#exitCode === null) {
      this.#exitCode = code;
      this.#finish(code);
    }
    throw new TvpProcessExit(code);
  }

  #finish(code: number): void {
    if (this.#uninitialized) return;
    this.#uninitialized = true;
    this.events.stop();
    this.config.onExit?.(code);
  }

  /** Registers a core class under its name (later subsystems add theirs here). */
  registerClass(name: string, cls: Dispatch, flags = 0): void {
    const global = this.engine.global;
    global.propSet(
      TJS_MEMBERENSURE | TJS_IGNOREPROP | (flags & TJS_STATICMEMBER),
      name,
      obj(cls),
      global,
    );
    cls.release();
  }

  // --- start-up -------------------------------------------------------------------------------

  /** The project directory chosen at start-up (`TVPProjectDir`). */
  get projectDir(): string {
    return this.#projectDir;
  }

  /**
   * `TVPBeforeSystemInit`'s project selection under `forcedataxp3(1)`: `data.xp3` beside the
   * executable, which must exist.
   */
  #selectProjectDir(): void {
    const local = localDirectory(this.config.executablePath) + 'data.xp3';
    if (!this.config.files.exists(local)) throw new TjsError('Aborted');
    this.#projectDir = this.storage.normalize(local + ARCHIVE_DELIMITER);
    this.storage.setCurrentDirectory(this.#projectDir);
    this.log.add(tjsMessage('TVPInfoSelectedProjectDirectory', this.#projectDir), true);
  }

  /** `TVPLoadPluigins`: every `*.tpm` beside the executable, in `system\`, in `plugin\`, by name. */
  #loadTpmPlugins(): (() => void | Promise<void>)[] {
    const exeDir = localDirectory(this.config.executablePath);
    const found: {path: string; name: string}[] = [];
    for (const dir of [exeDir, exeDir + 'system\\', exeDir + 'plugin\\'])
      for (const file of this.config.files.list(dir))
        if (/\.tpm$/i.test(file)) found.push({path: dir, name: file});
    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return found.map((p) => () => {
      this.log.add(`(info) Loading ${p.name}`, true);
      return this.plugins.load(p.path + p.name);
    });
  }

  /**
   * Start-up: project directory, `.tpm` plugins, then `startup.tjs` as a suspendable call
   * (`TVPInitializeStartupScript`). Errors in it go to `System.exceptionHandler` or are shown.
   * Resolves when the startup script has returned and events are being delivered, or when the
   * core has ended (`exitCode`).
   */
  async start(): Promise<void> {
    this.#selectProjectDir();
    // Natively the archive index is read synchronously on first use; it is fetched up front.
    await this.storage.openArchive(this.#projectDir.slice(0, -ARCHIVE_DELIMITER.length));
    for (const load of this.#loadTpmPlugins()) await load();
    const services = this.#scriptsServices();
    try {
      await this.events.runTopLevel(() =>
        this.events.guardedCall(
          'startup',
          () => {
            this.log.add(tjsMessage('TVPInfoLoadingStartupScript') + 'startup.tjs', true);
            return executeStorage(services, 'startup.tjs', null, null, false);
          },
          () => this.log.add(tjsMessage('TVPInfoStartupScriptEnded'), true),
        ),
      );
    } catch (error) {
      if (error instanceof TvpProcessExit) return;
      throw error;
    }
    if (this.#exitCode !== null) return;
    // Without a window the application ends (`TVPTerminateOnNoWindowStartup`).
    if (this.#systemFlags.exitOnNoWindowStartup && this.windowCount() === 0) {
      this.terminate(0);
      return;
    }
    this.events.start();
  }

  /** `TVPGetWindowCount`. */
  windowCount(): number {
    return 0;
  }

  /** Releases plugins and objects (`TVPUninitScriptEngine`, plugin vector at exit). */
  shutdown(): void {
    this.events.dispose();
    this.plugins.unloadAll();
    this.engine.shutdown();
    this.log.dispose();
    this.loader.dispose();
  }
}

/**
 * The sources of `TVPInitProgramArgumentsAndDataPath`: embedded options, `<exe>.cf`, the data
 * path they and the command line give, and `<datapath>\<exe>.cfu`.
 */
async function prepareOptions(
  config: KirikiriCoreConfig,
  decodeAnsi: (bytes: Uint8Array) => string,
  revision: KirikiriCoreRevision,
): Promise<PreparedOptions> {
  const readLines = async (name: string) => {
    if (!config.files.exists(name)) return {name, lines: null};
    const source = await config.files.open(name);
    return {name, lines: readConfigLines(await source.read(0, source.size), decodeAnsi)};
  };
  const embedded = config.executable ? readEmbeddedOptions(config.executable, decodeAnsi) : null;
  const exe = config.executablePath;
  const cf = await readLines(changeFileExt(exe, '.cf'));
  const datapath =
    ProgramArguments.build(config.commandLine ?? [], cf.lines, embedded).get('-datapath') ?? '';
  const folders: SpecialFolders = {
    personal: config.specialFolders?.personal ?? '',
    appData: config.specialFolders?.appData ?? '',
    savedGames: config.specialFolders?.savedGames ?? '',
  };
  // NT 6 and later, as GetVersionEx reports it.
  const version = config.system?.version ?? UNMANIFESTED_WINDOWS_VERSION;
  const vista = version.platformId === 2 && version.major >= 6;
  const nativeDataPath = dataPathDirectory(datapath, exe, folders, vista);
  const exeFile = exe.slice(exe.lastIndexOf('\\') + 1);
  const cfu = await readLines(nativeDataPath + changeFileExt(exeFile, '.cfu'));
  const initScript = config.executable ? readInitScript(config.executable, revision) : null;
  return {embedded, config: cf, userConfig: cfu, nativeDataPath, initScript};
}

/** `TVPInitTJSScript`: a narrow string, converted as ASCII. */
function readInitScript(executable: Uint8Array, revision: KirikiriCoreRevision): string {
  const image = PeImage.parse(executable);
  const offset = image.fileOffset(revision.initScriptAddress - Number(image.imageBase), 1);
  const end = executable.indexOf(0, offset);
  return new TextDecoder('latin1').decode(executable.subarray(offset, end));
}

/** `System`'s platform with defaults for services the host does not provide. */
function systemPlatform(given: Partial<KirikiriSystemPlatform> = {}): KirikiriSystemPlatform {
  const mutexes = new PageWindowsNamedMutexes();
  return {
    informationBox: async () => {},
    shellExecute: () => false,
    system: () => -1,
    asyncKeyState: () => false,
    readRegValue: async () => null,
    createMutex: (name) => mutexes.create(name).lastError,
    sysColor: defaultWindowsSysColor,
    touchDevice: () => 0x100 | 0x200,
    screen: () => ({
      width: 1920,
      height: 1080,
      desktopLeft: 0,
      desktopTop: 0,
      desktopWidth: 1920,
      desktopHeight: 1040,
    }),
    setApplicationTitle: () => {},
    showVersion: async () => {},
    processorCount: 1,
    version: UNMANIFESTED_WINDOWS_VERSION,
    ...given,
  };
}

/** The exporter's function names from the executable. */
async function readExporterNames(
  executable: Uint8Array,
  revision: KirikiriCoreRevision,
): Promise<Set<string>> {
  const {address, compressedSize, size, count} = revision.exporterNames;
  const image = PeImage.parse(executable);
  const offset = image.fileOffset(address - Number(image.imageBase), compressedSize);
  const raw = await inflateZlib(executable.subarray(offset, offset + compressedSize), size);
  const names = new TextDecoder('latin1')
    .decode(raw)
    .split('\0')
    .filter((n) => n);
  if (names.length !== count)
    throw new Error(`Exporter table holds ${names.length} names, expected ${count}`);
  return new Set(names);
}
