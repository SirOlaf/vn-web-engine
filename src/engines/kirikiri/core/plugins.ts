/**
 * TVP plugins (krkrz `base/win32/PluginImpl.cpp`, `tTVPPluginHolder` in `StorageImpl.cpp`):
 * `Plugins.link` locates a plugin, loads it through the native library loader and calls its
 * `V2Link` with the function exporter. A located plugin without an implementation for its build
 * is reported as unsupported; the runtime decides how to surface that.
 */
import {
  NativeLibraryHandle,
  type NativeLibraryIdentity,
  type NativeLibraryLoader,
  type NativeLoadResult,
} from '../../../platform/native-libraries.js';
import {throwTjsError, TjsError} from '../tjs2/runtime/errors.js';
import {
  TVP_PLUGIN,
  type TvpFunctionExporter,
  type TvpPluginExports,
} from '../tjs2/runtime/interface.js';

/** A plugin that could not be loaded because no implementation reproduces it. */
export class UnsupportedPluginError extends TjsError {
  constructor(
    readonly pluginName: string,
    readonly result: Exclude<NativeLoadResult, {status: 'loaded'}>,
  ) {
    super(`Cannot load plugin ${pluginName} (${result.status})`);
    this.name = 'UnsupportedPluginError';
  }
}

interface LoadedPlugin {
  readonly name: string;
  readonly handle: NativeLibraryHandle;
  readonly exports: TvpPluginExports;
}

export interface PluginHostEnvironment {
  readonly loader: NativeLibraryLoader;
  readonly exporter: TvpFunctionExporter;
  /**
   * `tTVPPluginHolder`: the file `LoadLibrary` gets for a plugin name: a storage found by the
   * TVP storage system (natively extracted to a temporary file), else the executable's folder,
   * `system\` and `plugin\`. Returns the file name to load, or null; a promise when a storage
   * has to be read to identify it.
   */
  locate(name: string): string | null | Promise<string | null>;
}

/** The plugin list (`TVPPluginVector`). */
export class PluginManager {
  readonly #plugins: LoadedPlugin[] = [];
  #loading = false;

  constructor(private readonly env: PluginHostEnvironment) {}

  /** Names of the linked plugins, in link order (`Plugins.getList`). */
  get names(): string[] {
    return this.#plugins.map((p) => p.name);
  }

  /**
   * `TVPLoadPlugin`: links once per name. Returns a promise when `V2Link` waits for storage.
   */
  load(name: string): void | Promise<void> {
    if (this.#loading) throwTjsError('TVPCannnotLinkPluginWhilePluginLinking');
    if (this.#plugins.some((p) => p.name === name)) return;
    const located = this.env.locate(name);
    if (located instanceof Promise) {
      this.#loading = true;
      return located.then(
        (file) => {
          this.#loading = false;
          return this.#link(name, file);
        },
        (e: unknown) => {
          this.#loading = false;
          throw e;
        },
      );
    }
    return this.#link(name, located);
  }

  #link(name: string, file: string | null): void | Promise<void> {
    if (file === null) throwTjsError('TVPCannotLoadPlugin', name);
    const result = this.env.loader.load(file);
    if (result.status !== 'loaded') throw new UnsupportedPluginError(name, result);
    const exports = result.library.exports(TVP_PLUGIN);
    if (!exports) {
      this.env.loader.free(result.library);
      throwTjsError('TVPCannotLoadPlugin', name);
    }
    const plugin: LoadedPlugin = {name, handle: result.library, exports};
    this.#loading = true;
    let linked: number | Promise<number>;
    try {
      linked = exports.v2Link(this.env.exporter);
    } catch (e) {
      this.#loading = false;
      this.env.loader.free(result.library);
      throw e;
    }
    const finish = () => {
      this.#loading = false;
      this.#plugins.push(plugin);
    };
    if (linked instanceof Promise)
      return linked.then(finish, (e: unknown) => {
        this.#loading = false;
        this.env.loader.free(result.library);
        throw e;
      });
    finish();
  }

  /** `TVPUnloadPlugin`: false when `V2Unlink` refuses. */
  unload(name: string): boolean {
    const i = this.#plugins.findIndex((p) => p.name === name);
    if (i < 0) throwTjsError('TVPNotLoadedPlugin', name);
    const plugin = this.#plugins[i]!;
    if (plugin.exports.v2Unlink() < 0) return false;
    this.env.loader.free(plugin.handle);
    this.#plugins.splice(i, 1);
    return true;
  }

  /** `TVPDestroyPluginVector`: unlinks every plugin, last linked first, ignoring failures. */
  unloadAll(): void {
    while (this.#plugins.length) {
      const plugin = this.#plugins.pop()!;
      try {
        plugin.exports.v2Unlink();
        this.env.loader.free(plugin.handle);
      } catch {
        // as natively: errors at exit are ignored
      }
    }
  }
}

/** Identities of plugin files by local name, for a `NativeLibraryLocator`. */
export type PluginIdentities = ReadonlyMap<string, NativeLibraryIdentity>;
