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
import {setTjsMessages, TjsError, tjsMessage} from '../tjs2/runtime/errors.js';
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
import {obj} from '../tjs2/runtime/variant.js';
import {TjsVm} from '../tjs2/vm/executor.js';
import {createDebugClass, createPluginsClass} from './classes/debug-plugins.js';
import {createScriptsClass, executeStorage, type ScriptsServices} from './classes/scripts.js';
import {createStoragesClass, type StoragesPlatform} from './classes/storages.js';
import {TvpLog, type LogClock} from './log.js';
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
   * Program arguments in priority order (`-name=value`; a bare `-name` means `yes`): the
   * command line, then configuration files, then the executable's embedded options.
   */
  readonly options?: readonly string[];
  readonly clock: KirikiriClock;
  /** Every log line as the console shows it. */
  readonly output?: (line: string, important: boolean) => void;
  readonly storagesPlatform?: Partial<StoragesPlatform>;
  /** `MultiByteToWideChar(CP_ACP)`; CP932 by default. */
  readonly decodeAnsi?: (bytes: Uint8Array) => string;
  /** `TVPGetRandomBits128`. */
  readonly randomBits128?: () => Uint8Array;
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

/** Parses `-name=value` / `-name` like `TVPParseCommandLineOne`. */
function parseOption(option: string): string {
  return option.includes('=') ? option : option + '=yes';
}

export class KirikiriCore {
  readonly engine: TjsEngine;
  readonly storage: StorageSystem;
  readonly log: TvpLog;
  readonly plugins: PluginManager;
  readonly exporter: TvpFunctionExporter;
  readonly loader: NativeLibraryLoader;
  readonly #arguments: string[];
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
  ) {
    setTjsMessages(
      config.executable
        ? readKirikiriMessages(config.executable, config.uiLanguage)
        : ENGLISH_MESSAGES,
    );
    this.#arguments = (config.options ?? []).map(parseOption);
    this.#decodeAnsi = config.decodeAnsi ?? decodeCp932;

    const host: TjsHost = {
      readText: (name, mode) => this.readText(name, mode),
      openTextWrite: (name, mode) => this.openTextWrite(name, mode),
      print: (line) => this.log.add(line),
      time: () => config.clock.time(),
      randomBits128: config.randomBits128,
    };
    this.engine = new TjsEngine(host);
    this.log = new TvpLog(config.clock, this.engine.suspender, config.output ?? (() => {}));
    this.storage = new StorageSystem(
      new FileMedia(config.files),
      (line) => this.log.add(line),
      () => config.clock.tickCount(),
    );
    this.loader = new NativeLibraryLoader(config.libraries, {
      locate: (fileName) => this.#locateLibrary(fileName),
    });
    this.exporter = this.#createExporter();
    this.plugins = new PluginManager({
      loader: this.loader,
      exporter: this.exporter,
      locate: (name) => this.#locatePlugin(name),
    });
    this.#initScriptEngine();
  }

  /** Reads what the core needs synchronously, then builds the core. */
  static async create(config: KirikiriCoreConfig): Promise<KirikiriCore> {
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
    return new KirikiriCore(config, revision, exporterNames, identities);
  }

  // --- services ---------------------------------------------------------------------------

  /** `TVPGetCommandLine`. */
  getCommandLine(name: string): string | null {
    for (const arg of this.#arguments) {
      if (!arg.startsWith(name)) continue;
      const c = arg[name.length];
      if (c === '=') return arg.slice(name.length + 1);
      if (c === undefined) return 'yes';
    }
    return null;
  }

  /** `TVPSetCommandLine`: replaces an option, or inserts it with the highest priority. */
  setCommandLine(name: string, value: string): void {
    const i = this.#arguments.findIndex(
      (arg) => arg.startsWith(name) && (arg[name.length] === '=' || arg[name.length] === undefined),
    );
    if (i >= 0) this.#arguments[i] = name + '=' + value;
    else this.#arguments.unshift(name + '=' + value);
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
  #initScriptEngine(): void {
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
      ['Timer', () => null],
      ['AsyncTrigger', () => null],
      ['System', () => null],
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
    const global = this.engine.global;
    for (const [name, create] of classes) {
      const cls = create();
      if (!cls) continue;
      global.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, name, obj(cls), global);
      cls.release();
    }
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
   * Start-up: project directory, `.tpm` plugins, then `startup.tjs` as a suspendable call.
   * Resolves when the startup script has returned.
   */
  async start(): Promise<void> {
    this.#selectProjectDir();
    for (const load of this.#loadTpmPlugins()) await load();
    const services = this.#scriptsServices();
    this.log.add(tjsMessage('TVPInfoLoadingStartupScript') + 'startup.tjs', true);
    await this.engine.suspender.run(() =>
      executeStorage(services, 'startup.tjs', null, null, false),
    );
    this.log.add(tjsMessage('TVPInfoStartupScriptEnded'), true);
  }

  /** Releases plugins and objects (`TVPUninitScriptEngine`, plugin vector at exit). */
  shutdown(): void {
    this.plugins.unloadAll();
    this.engine.shutdown();
    this.log.dispose();
    this.loader.dispose();
  }
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
