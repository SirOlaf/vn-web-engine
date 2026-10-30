import type {AsbTag} from '../../formats/artemis/asb.js';
import type {
  WindowsDynamicLibrary,
  WindowsDynamicLibraryHost,
} from '../../platform/windows-dynamic-library.js';

function synchronous<T>(value: T): T {
  if (value !== null && typeof value === 'object' && 'then' in value)
    throw new Error('Artemis native library operations must complete synchronously');
  return value;
}
function ansi(value: string): Uint8Array {
  if (/[^\x00-\x7f]/.test(value)) throw new Error('Unsupported Artemis native ANSI string');
  return new TextEncoder().encode(value);
}
function cString(value: string): string {
  return value.split('\0', 1)[0]!;
}

/** 0x1401823a0's cached DLLs, char* argument/result and required Delete export. */
export class ArtemisNativeLibrary {
  private readonly modules = new Map<string, WindowsDynamicLibrary>();
  constructor(
    private readonly host: WindowsDynamicLibraryHost,
    private readonly writeResult: (name: string, bytes: Uint8Array) => void,
  ) {}
  call(module: string, method: string, parameter: string | Uint8Array): Uint8Array {
    const path = ansi(module),
      // char* parameters are native byte strings. The export owns their encoding;
      // LoadLibraryA's module-name constraint does not apply to argument bytes.
      argument = typeof parameter === 'string' ? new TextEncoder().encode(parameter) : parameter;
    ansi(method);
    let library = this.modules.get(module);
    if (!library) {
      const zero = path.indexOf(0);
      const loaded = synchronous(this.host.loadLibraryA(zero < 0 ? path : path.slice(0, zero)));
      if (loaded === null) return new Uint8Array();
      if (typeof loaded !== 'object') throw new Error('Invalid Artemis native module identity');
      library = loaded;
      this.modules.set(module, library);
    }
    const procedure = synchronous(this.host.getProcAddress(library, cString(method)));
    if (procedure === null) return new Uint8Array();
    const terminated = new Uint8Array(argument.length + 1);
    terminated.set(argument);
    const pointer = synchronous(
      this.host.invoke(procedure, [{kind: 'memory', pointer: {bytes: terminated, offset: 0}}]),
    );
    if (typeof pointer !== 'bigint') throw new Error('Artemis native export must return a pointer');
    if (pointer === 0n) return new Uint8Array();
    if (!this.host.readCString) throw new Error('Artemis native host cannot copy returned strings');
    const result = synchronous(this.host.readCString(pointer)).slice();
    const release = synchronous(this.host.getProcAddress(library, 'Delete'));
    // Native discards the copied result and leaves the pointer untouched when Delete is absent.
    if (release === null) return new Uint8Array();
    synchronous(this.host.invoke(release, [{kind: 'signed', value: pointer}]));
    return result;
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'callnative') return false;
    const p = tag.args;
    const result = this.call(
      p.get('module') ?? '',
      p.get('method') ?? '',
      tag.bytes?.get('param') ?? p.get('param') ?? '',
    );
    this.writeResult(p.get('result') ?? '', result);
    return true;
  }
  /** Native 0x140182640 releases modules in byte-key order and clears the registry. */
  reset(): void {
    const entries = [...this.modules].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.modules.clear();
    let failure: unknown;
    for (const [, library] of entries) {
      try {
        synchronous(this.host.freeLibrary(library));
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }
}
