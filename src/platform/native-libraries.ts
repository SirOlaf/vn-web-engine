/**
 * Loader for browser reimplementations of native libraries (plugins and the system DLLs they
 * import). Libraries compose only through contracts: a contract is the typed export surface
 * of one native library, and every implementation of that library (TypeScript, Wasm-backed,
 * or a stand-in) provides the same contract. Code that uses a library depends on its
 * contract, never on an implementation, so implementations are interchangeable.
 */

declare const contractExports: unique symbol;

/** Typed export surface of one native library. Shared by every implementation of it. */
export interface NativeContract<Exports extends object> {
  /** Native file name, lower case (`emotedriver.dll`). */
  readonly library: string;
  /** Names one export surface; a library whose exports change gets a new revision. */
  readonly revision: string;
  /** Type carrier only; absent at run time. */
  readonly [contractExports]?: Exports;
}

export type NativeContractExports<C> = C extends NativeContract<infer E> ? E : never;

export function defineNativeContract<Exports extends object>(
  library: string,
  revision: string,
): NativeContract<Exports> {
  return Object.freeze({library: library.toLowerCase(), revision}) as NativeContract<Exports>;
}

/**
 * The native file an implementation reproduces. `image` is a file shipped with the game,
 * identified by SHA-256 because native addresses and behaviour are tied to one build.
 * `system` is an operating-system library found by name (`d3d9.dll`).
 */
export type NativeLibraryIdentity =
  | {readonly kind: 'image'; readonly sha256: string}
  | {readonly kind: 'system'; readonly fileName: string};

/**
 * A library this library imports. `static` imports are linked before the importer and
 * released with it. `delay` imports are linked on first use, as the MSVC delay-load helper
 * does, and stay loaded until the loader is disposed.
 */
export interface NativeImportDeclaration {
  readonly contract: NativeContract<object>;
  readonly binding: 'static' | 'delay';
  /** File name passed to the native loader; defaults to the contract's library. */
  readonly fileName?: string;
}

export interface NativeLinkContext {
  /** Exports of a declared static import. */
  staticImport<E extends object>(contract: NativeContract<E>): E;
  /**
   * Resolver for a declared delay import. The first call loads the library; later calls
   * return the same exports. Throws `NativeDelayLoadError` when it cannot be loaded.
   */
  delayImport<E extends object>(contract: NativeContract<E>): () => E;
}

export interface NativeLibraryInstance<Exports extends object> {
  readonly exports: Exports;
  /** DLL_PROCESS_DETACH: called once when the last reference is released. */
  detach?(): void;
}

/**
 * One implementation of a contract for a set of native builds. `link` is synchronous, as
 * DllMain is; asynchronous preparation (compiling a Wasm module, fetching tables) happens
 * before the implementation is handed to the loader.
 */
export interface NativeLibraryImplementation<Exports extends object> {
  readonly contract: NativeContract<Exports>;
  readonly identities: readonly NativeLibraryIdentity[];
  readonly imports: readonly NativeImportDeclaration[];
  link(context: NativeLinkContext): NativeLibraryInstance<Exports>;
}

/**
 * Native library search. Returns the identity of the file `LoadLibrary(fileName)` would map
 * when called from `requester` (null: the game executable), or null when no file is found.
 * Hashes of game files are computed before the loader runs, so this is synchronous.
 */
export interface NativeLibraryLocator {
  locate(fileName: string, requester: NativeLibraryIdentity | null): NativeLibraryIdentity | null;
}

export type NativeLoadResult =
  | {readonly status: 'loaded'; readonly library: NativeLibraryHandle}
  /** No file was found (ERROR_MOD_NOT_FOUND). */
  | {readonly status: 'not-found'; readonly fileName: string}
  /** The file exists but no implementation reproduces this build. */
  | {
      readonly status: 'unsupported';
      readonly fileName: string;
      readonly identity: NativeLibraryIdentity;
    }
  /** A static import of the library could not be loaded. */
  | {readonly status: 'import-failed'; readonly fileName: string; readonly cause: NativeLoadResult};

export class NativeDelayLoadError extends Error {
  constructor(
    readonly importer: string,
    readonly result: Exclude<NativeLoadResult, {status: 'loaded'}>,
  ) {
    super(`${importer}: delay-loaded ${result.fileName} is unavailable (${result.status})`);
  }
}

export function nativeIdentityKey(identity: NativeLibraryIdentity): string {
  return identity.kind === 'image'
    ? `image:${identity.sha256.toLowerCase()}`
    : `system:${identity.fileName.toLowerCase()}`;
}

/** A loaded library. Exports are reachable only through the contract it provides. */
export class NativeLibraryHandle {
  constructor(
    readonly identity: NativeLibraryIdentity,
    readonly contract: NativeContract<object>,
    private readonly provided: object,
  ) {}

  /** The exports when this library provides `contract`, otherwise null (GetProcAddress failure). */
  exports<E extends object>(contract: NativeContract<E>): E | null {
    return sameContract(this.contract, contract) ? (this.provided as E) : null;
  }
}

interface LoadedModule {
  readonly key: string;
  readonly identity: NativeLibraryIdentity;
  readonly implementation: NativeLibraryImplementation<object>;
  instance: NativeLibraryInstance<object> | null;
  references: number;
  readonly staticDependencies: LoadedModule[];
}

/**
 * Process-wide library table. Each identity is linked once and reference counted, like
 * LoadLibrary/FreeLibrary. At most one implementation may be registered per identity; the
 * runtime wiring chooses which one (for example TypeScript or Wasm) by what it registers.
 */
export class NativeLibraryLoader {
  private readonly implementations = new Map<string, NativeLibraryImplementation<object>>();
  private readonly modules = new Map<string, LoadedModule>();
  private readonly linking = new Set<string>();
  private readonly delayLoaded: LoadedModule[] = [];
  private readonly handles = new WeakMap<NativeLibraryHandle, LoadedModule>();
  private disposed = false;

  constructor(
    implementations: readonly NativeLibraryImplementation<object>[],
    private readonly locator: NativeLibraryLocator,
  ) {
    for (const implementation of implementations) {
      for (const identity of implementation.identities) {
        const key = nativeIdentityKey(identity);
        if (this.implementations.has(key))
          throw new Error(`Two native library implementations registered for ${key}`);
        this.implementations.set(key, implementation);
      }
    }
  }

  /** LoadLibrary. `requester` is the identity of the calling library (null: the executable). */
  load(fileName: string, requester: NativeLibraryIdentity | null = null): NativeLoadResult {
    if (this.disposed) throw new Error('Native library loader is disposed');
    const result = this.acquire(fileName, requester);
    if (result.status !== 'loaded') return result;
    const {module} = result;
    const library = new NativeLibraryHandle(
      module.identity,
      module.implementation.contract,
      module.instance!.exports,
    );
    this.handles.set(library, module);
    return {status: 'loaded', library};
  }

  /** FreeLibrary. */
  free(library: NativeLibraryHandle): void {
    if (this.disposed) return;
    const module = this.handles.get(library);
    if (module === undefined) throw new Error('Native library handle was already freed');
    this.handles.delete(library);
    this.release(module);
  }

  /** Process exit: detaches every library still loaded, dependents first. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const order = [...this.modules.values()].reverse();
    this.modules.clear();
    this.delayLoaded.length = 0;
    let firstError: unknown;
    for (const module of order) {
      try {
        this.detach(module);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private acquire(
    fileName: string,
    requester: NativeLibraryIdentity | null,
  ): Exclude<NativeLoadResult, {status: 'loaded'}> | {status: 'loaded'; module: LoadedModule} {
    const identity = this.locator.locate(fileName, requester);
    if (identity === null) return {status: 'not-found', fileName};
    const key = nativeIdentityKey(identity);
    const existing = this.modules.get(key);
    if (existing !== undefined) {
      existing.references++;
      return {status: 'loaded', module: existing};
    }
    const implementation = this.implementations.get(key);
    if (implementation === undefined) return {status: 'unsupported', fileName, identity};
    if (this.linking.has(key)) throw new Error(`Circular static import of ${fileName}`);

    this.linking.add(key);
    const module: LoadedModule = {
      key,
      identity,
      implementation,
      instance: null,
      references: 1,
      staticDependencies: [],
    };
    try {
      for (const declaration of implementation.imports) {
        if (declaration.binding !== 'static') continue;
        const dependency = this.acquire(
          declaration.fileName ?? declaration.contract.library,
          identity,
        );
        if (dependency.status !== 'loaded') {
          this.releaseAll(module.staticDependencies);
          return {status: 'import-failed', fileName, cause: dependency};
        }
        module.staticDependencies.push(dependency.module);
        if (!provides(dependency.module, declaration.contract)) {
          const {identity: found} = dependency.module;
          this.releaseAll(module.staticDependencies);
          return {
            status: 'import-failed',
            fileName,
            cause: {status: 'unsupported', fileName: declaration.contract.library, identity: found},
          };
        }
      }
      try {
        module.instance = implementation.link(this.linkContext(module));
      } catch (error) {
        this.releaseAll(module.staticDependencies);
        throw error;
      }
    } finally {
      this.linking.delete(key);
    }
    this.modules.set(key, module);
    return {status: 'loaded', module};
  }

  private linkContext(module: LoadedModule): NativeLinkContext {
    const declarations = module.implementation.imports;
    const declared = (contract: NativeContract<object>, binding: 'static' | 'delay') => {
      const declaration = declarations.find(
        (item) => item.binding === binding && sameContract(item.contract, contract),
      );
      if (declaration === undefined)
        throw new Error(
          `${module.implementation.contract.library} uses undeclared ${binding} import ${contract.library}`,
        );
      return declaration;
    };
    return {
      staticImport: <E extends object>(contract: NativeContract<E>): E => {
        declared(contract, 'static');
        const dependency = module.staticDependencies.find((item) => provides(item, contract));
        return dependency!.instance!.exports as E;
      },
      delayImport: <E extends object>(contract: NativeContract<E>): (() => E) => {
        const declaration = declared(contract, 'delay');
        let exports: E | null = null;
        return () => {
          if (exports !== null) return exports;
          if (this.disposed) throw new Error('Native library loader is disposed');
          const fileName = declaration.fileName ?? contract.library;
          const result = this.acquire(fileName, module.identity);
          if (result.status !== 'loaded')
            throw new NativeDelayLoadError(module.implementation.contract.library, result);
          if (!provides(result.module, contract)) {
            this.release(result.module);
            throw new NativeDelayLoadError(module.implementation.contract.library, {
              status: 'unsupported',
              fileName,
              identity: result.module.identity,
            });
          }
          this.delayLoaded.push(result.module);
          exports = result.module.instance!.exports as E;
          return exports;
        };
      },
    };
  }

  private release(module: LoadedModule): void {
    if (--module.references > 0) return;
    this.modules.delete(module.key);
    try {
      this.detach(module);
    } finally {
      this.releaseAll(module.staticDependencies);
    }
  }

  private releaseAll(modules: LoadedModule[]): void {
    const list = modules.splice(0).reverse();
    for (const item of list) this.release(item);
  }

  private detach(module: LoadedModule): void {
    const instance = module.instance;
    module.instance = null;
    instance?.detach?.();
  }
}

function sameContract(a: NativeContract<object>, b: NativeContract<object>): boolean {
  return a.library === b.library && a.revision === b.revision;
}

function provides(module: LoadedModule, contract: NativeContract<object>): boolean {
  return sameContract(module.implementation.contract, contract);
}
