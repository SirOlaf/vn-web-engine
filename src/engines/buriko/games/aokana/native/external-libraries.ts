import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {
  WindowsDynamicArgument,
  WindowsDynamicLibrary,
  WindowsDynamicLibraryHost,
  WindowsDynamicProcedure,
} from '../../../../../platform/windows-dynamic-library.js';
import type {AokanaProgramResources} from './program-resources.js';
import {textBytes} from './text.js';

interface LibraryEntry {
  readonly id: number;
  readonly library: WindowsDynamicLibrary;
  readonly call: WindowsDynamicProcedure;
}

const requiredExport = 'CallFunctionForEthornell';
const optionalWindowExport = 'SetWindowHandleOfEthornell';

function synchronous<T>(value: T): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof value.then === 'function'
  )
    throw new TypeError('Aokana native DLL host operation must complete synchronously');
  return value;
}

/** B7990/B7920/B78C0's global linked DLL registry and synchronous callback ABI. */
export class AokanaExternalLibraries {
  private nextId = 0;
  private entries: LibraryEntry[] = [];
  private closed = false;

  constructor(
    readonly resources: Pick<AokanaProgramResources, 'configuration'>,
    readonly host: WindowsDynamicLibraryHost,
    readonly windowIdentity: object,
  ) {}

  /** Resource-root bytes and caller name are concatenated without a separator. */
  private path(name: Uint8Array): Uint8Array {
    const root = textBytes({bytes: this.resources.configuration.primaryRoot, offset: 0});
    const file = textBytes({bytes: name, offset: 0}, true);
    if (root.length + file.length > 784)
      throw new RangeError('Aokana LoadLibraryA path exceeds native ANSI local');
    const result = new Uint8Array(root.length + file.length);
    result.set(root);
    result.set(file, root.length);
    return result;
  }

  /** Status 1 is LoadLibraryA failure; 2 is the absent required export. */
  load(name: Uint8Array, output: AokanaBpPointer | null): 0 | 1 | 2 {
    if (this.closed) throw new Error('Aokana DLL registry admission is closed');
    const library = synchronous(this.host.loadLibraryA(this.path(name)));
    if (library === null) return 1;
    if (typeof library !== 'object')
      throw new TypeError('Aokana DLL host returned an invalid module identity');
    const call = synchronous(this.host.getProcAddress(library, requiredExport));
    if (call === null) {
      synchronous(this.host.freeLibrary(library));
      return 2;
    }
    if (typeof call !== 'object')
      throw new TypeError('Aokana DLL host returned an invalid export identity');
    this.nextId = (this.nextId + 1) >>> 0;
    const entry = {id: this.nextId, library, call};
    this.entries.unshift(entry);
    pointerView(output!, 4).setUint32(0, entry.id, true);
    const setWindow = synchronous(this.host.getProcAddress(library, optionalWindowExport));
    if (setWindow !== null) {
      if (typeof setWindow !== 'object')
        throw new TypeError('Aokana DLL host returned an invalid export identity');
      const handle = synchronous(this.host.mainWindowHandle(this.windowIdentity));
      if (handle !== null && typeof handle !== 'object')
        throw new TypeError('Aokana DLL host returned an invalid window identity');
      synchronous(this.host.invoke(setWindow, [{kind: 'handle', value: handle}]));
    }
    return 0;
  }

  /** B7920 unlinks the first matching ID before FreeLibrary. */
  unload(id: number): 0 | 3 {
    if (this.closed) throw new Error('Aokana DLL registry admission is closed');
    const index = this.entries.findIndex((entry) => entry.id === id >>> 0);
    if (index < 0) return 3;
    const [entry] = this.entries.splice(index, 1);
    synchronous(this.host.freeLibrary(entry!.library));
    return 0;
  }

  /** B78C0 writes a full native return locally; EE publishes only the low DWORD. */
  call(
    id: number,
    first: bigint,
    second: WindowsDynamicArgument,
    third: WindowsDynamicArgument,
    output: AokanaBpPointer | null,
  ): 0 | 3 | 4 {
    if (this.closed) throw new Error('Aokana DLL registry admission is closed');
    const entry = this.entries.find((item) => item.id === id >>> 0);
    if (entry === undefined) return 3;
    const result = synchronous(
      this.host.invoke(entry.call, [{kind: 'signed', value: first}, second, third]),
    );
    if (typeof result !== 'bigint')
      throw new TypeError('Aokana DLL callback must return a native-width integer');
    const nativeResult = BigInt.asUintN(64, result);
    pointerView(output!, 4).setUint32(0, Number(BigInt.asUintN(32, nativeResult)), true);
    return nativeResult === 0n ? 0 : 4;
  }

  /** Final graph teardown releases any linked modules before its main HWND is destroyed. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const entries = this.entries;
    this.entries = [];
    let firstError: unknown;
    for (const entry of entries) {
      try {
        synchronous(this.host.freeLibrary(entry.library));
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
