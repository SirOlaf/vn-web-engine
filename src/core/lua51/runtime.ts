import {LUA51_WASM_BINARY} from './wasm-binary.js';

export type LuaValue = null | boolean | number | Uint8Array | LuaTable | LuaReference;
export type LuaTable = Map<string | number | boolean, LuaValue>;
export type LuaHostMethod = (args: readonly LuaValue[]) => readonly LuaValue[];
type Fn = (...args: number[]) => number;
interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  [name: string]: WebAssembly.ExportValue;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
let compiled: WebAssembly.Module | undefined;

/** Lua strings are bytes. Decode explicitly only for known text interfaces. */
export function luaText(value: LuaValue | undefined): string {
  if (!(value instanceof Uint8Array)) throw new Error('Expected Lua byte string');
  return decoder.decode(value);
}

/** luaL_loadfile framing; binary reopen retains the original bytes. */
export function luaFileBytes(raw: Uint8Array, text = raw): Uint8Array {
  let offset = 0;
  const header = text[0] === 35;
  if (header) {
    const newline = text.indexOf(10);
    offset = newline < 0 ? text.length : newline + 1;
  }
  if (text[offset] === 27) {
    const start = raw.indexOf(27);
    if (start < 0) throw Error('Lua binary reopen requires original file bytes');
    return raw.subarray(start);
  }
  if (!header) return text;
  const body = new Uint8Array(1 + text.length - offset);
  body[0] = 10;
  body.set(text.subarray(offset), 1);
  return body;
}

/** Nonzero Lua status from a protected load, call or resume. `value` holds the error
 * string bytes; other error values are null. `hostCause` is the host-method exception
 * the Lua error was raised from, so owners can keep host refusals distinct from
 * errors produced by Lua code.
 */
export class LuaRuntimeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly value: Uint8Array | null,
    readonly hostCause?: unknown,
  ) {
    super(message);
    this.name = 'LuaRuntimeError';
  }
}

/** Isolated Lua 5.1.5 VM. Platform effects are supplied through explicit engine methods. */
export class Lua51 {
  private readonly exports: Exports;
  private readonly state: number;
  private readonly methods = new Map<string, LuaHostMethod>();
  private readonly referenceMethods = new Map<
    string,
    (args: readonly LuaReference[]) => readonly LuaValue[]
  >();
  private depth = 0;
  private closed = false;
  private poisoned = false;
  private callbackState: number | undefined;
  /** Host-method failures raised as Lua errors during the current outer execution. */
  private hostFailures: {readonly message: string; readonly error: unknown}[] = [];
  readonly instructionLimit: number;

  constructor(instructionLimit = 2_000_000) {
    if (
      !Number.isSafeInteger(instructionLimit) ||
      instructionLimit < 1000 ||
      instructionLimit > 0x7fffffff
    )
      throw new Error('Invalid Lua instruction limit');
    this.instructionLimit = instructionLimit;
    compiled ??= new WebAssembly.Module(
      Uint8Array.from(atob(LUA51_WASM_BINARY), (c) => c.charCodeAt(0)),
    );
    const instance = new WebAssembly.Instance(compiled, {
      host: {
        interrupt: () => {
          this.poisoned = true;
          throw new Error('Lua instruction budget exceeded');
        },
        call: (state: number, pointer: number, length: number) =>
          this.dispatch(state, pointer, length),
      },
      wasi_snapshot_preview1: {
        // No host file descriptors or process control are exposed by this embedding.
        fd_write: () => 8,
        fd_read: () => 8,
        fd_close: () => 8,
        fd_seek: () => 8,
        proc_exit: () => {
          this.poisoned = true;
          throw new Error('Lua process exit');
        },
      },
      env: {emscripten_notify_memory_growth: () => {}, __syscall_dup3: () => -8},
    });
    this.exports = instance.exports as Exports;
    (this.exports['_initialize'] as (() => void) | undefined)?.();
    this.state = this.fn('lua51_new')();
    if (!this.state) throw new Error('Cannot initialize Lua 5.1');
  }

  private fn(name: string): Fn {
    return this.exports[name] as Fn;
  }
  private get current(): number {
    return this.callbackState ?? this.state;
  }
  private assertOpen(): void {
    if (this.closed || this.poisoned) throw new Error('Lua VM is closed or interrupted');
  }
  /** Host owners must not treat a resource guard/trap as a recoverable Lua error. */
  get usable(): boolean {
    return !this.closed && !this.poisoned;
  }
  private bytes(pointer: number, length: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, pointer, length).slice();
  }
  private buffer<T>(bytes: Uint8Array, use: (pointer: number) => T): T {
    const p = this.fn('malloc')(bytes.length + 1);
    if (!p) throw new Error('Lua buffer allocation failed');
    try {
      const heap = new Uint8Array(this.exports.memory.buffer);
      heap.set(bytes, p);
      heap[p + bytes.length] = 0;
      return use(p);
    } finally {
      this.fn('free')(p);
    }
  }
  private name<T>(name: string, use: (p: number) => T): T {
    if (name.includes('\0')) throw new Error('Invalid Lua name');
    return this.buffer(encoder.encode(name), use);
  }

  bind(name: string, method: LuaHostMethod): void {
    this.assertOpen();
    if (this.depth) throw new Error('Cannot change Lua bindings during execution');
    this.name(name, (p) => this.fn('lua51_bind')(this.state, p, encoder.encode(name).length));
    this.methods.set(name, method);
    this.referenceMethods.delete(name);
  }
  bindReferences(
    name: string,
    method: (args: readonly LuaReference[]) => readonly LuaValue[],
  ): void {
    this.bind(name, () => []);
    this.referenceMethods.set(name, method);
  }
  referenceGlobal(name: string): LuaReference {
    this.assertOpen();
    const L = this.current,
      top = this.fn('lua51_top')(L);
    try {
      this.name(name, (p) => this.fn('lua51_global')(L, p));
      return this.reference(-1);
    } finally {
      this.fn('lua51_settop')(L, top);
    }
  }
  private reference(index: number): LuaReference {
    return new LuaReference(
      this,
      this.fn('lua51_ref')(this.current, index),
      this.fn('lua51_type')(this.current, index),
    );
  }
  /** A coroutine owns its function/locals across host-driven asynchronous waits. */
  createThread(callback: LuaReference, withEngine = false): LuaThread {
    this.assertOpen();
    callback.assertOwner(this);
    if (callback.type !== 6) throw new Error('Lua thread entry is not a function');
    const id = this.fn('lua51_newthreadref')(this.current, callback.id, +withEngine);
    return new LuaThread(this, new LuaReference(this, id, 8), withEngine);
  }
  /** Internal thread operation. Yielded values cross the same bounded byte/table bridge. */
  resumeThread(
    ref: LuaReference,
    args: readonly LuaValue[],
    initialEngine: boolean,
    discardDoneValues = false,
    maxResults = Infinity,
  ): LuaThreadResult {
    ref.assertOwner(this);
    this.assertOpen();
    let yielded = false;
    const values: LuaValue[] = [],
      L = this.current,
      top = this.fn('lua51_top')(L);
    this.run(() => {
      for (const value of args) this.push(value);
      const status = this.fn('lua51_resumethread')(
        L,
        ref.id,
        args.length,
        +initialEngine,
        this.depth === 1 ? this.instructionLimit : 0,
      );
      if (status === 0 || status === 1) {
        yielded = status === 1;
        if (yielded || !discardDoneValues)
          for (let i = top + 1; i <= Math.min(this.fn('lua51_top')(L), top + maxResults); i++)
            values.push(this.read(i));
        return 0;
      }
      return status;
    });
    return {status: yielded ? 'yielded' : 'done', values};
  }
  /** Internal registry operations used by LuaReference; references never expose wasm pointers. */
  referenceOperation(
    ref: LuaReference,
    operation: 'read' | 'retain' | 'field' | 'release' | 'invoke' | 'invokeVoid' | 'invokeFirst',
    key?: string,
    args: readonly LuaValue[] = [],
    withEngine = false,
  ): LuaValue | LuaReference | readonly LuaValue[] | void {
    ref.assertOwner(this);
    if (operation === 'release' && (this.closed || this.poisoned)) return;
    this.assertOpen();
    const L = this.current,
      top = this.fn('lua51_top')(L);
    try {
      if (operation === 'release') {
        this.fn('lua51_unref')(L, ref.id);
        return;
      }
      if (operation === 'invoke' || operation === 'invokeVoid' || operation === 'invokeFirst') {
        let results: LuaValue[] = [];
        this.run(() => {
          for (const value of args) this.push(value);
          const status = this.fn('lua51_invokeref')(
            L,
            ref.id,
            args.length,
            +withEngine,
            this.depth === 1 ? this.instructionLimit : 0,
          );
          if (!status && operation !== 'invokeVoid')
            for (
              let i = top + 1;
              i <=
              Math.min(this.fn('lua51_top')(L), operation === 'invokeFirst' ? top + 1 : Infinity);
              i++
            )
              results.push(this.read(i));
          return status;
        });
        return operation === 'invokeFirst' ? (results[0] ?? null) : results;
      }
      if (operation === 'field') {
        if (ref.type !== 5) throw new Error('Lua reference is not a table');
        this.name(key!, (p) => this.fn('lua51_fieldref')(L, ref.id, p));
      } else this.fn('lua51_pushref')(L, ref.id);
      return operation === 'read' ? this.read(-1) : this.reference(-1);
    } finally {
      if (!this.poisoned) this.fn('lua51_settop')(L, top);
    }
  }
  execute(bytes: Uint8Array, name = 'chunk'): void {
    this.run(() =>
      this.name(name, (n) =>
        this.buffer(bytes, (p) =>
          this.fn('lua51_eval')(
            this.current,
            p,
            bytes.length,
            n,
            this.depth === 1 ? this.instructionLimit : 0,
          ),
        ),
      ),
    );
  }
  /** luaL_loadfile framing over prepared sources. Text-mode translation belongs
   * to the platform owner; binary reopen uses the original borrowed bytes.
   */
  executeFile(raw: Uint8Array, path: string, text = raw): void {
    this.execute(luaFileBytes(raw, text), `@${path}`);
  }
  compileFile(raw: Uint8Array, path: string, text = raw): void {
    this.compile(luaFileBytes(raw, text), `@${path}`);
  }
  compile(bytes: Uint8Array, name = 'chunk'): void {
    this.run(() =>
      this.name(name, (n) =>
        this.buffer(bytes, (p) => this.fn('lua51_compile')(this.current, p, bytes.length, n)),
      ),
    );
  }
  call(name: string): void {
    this.run(() =>
      this.name(name, (p) =>
        this.fn('lua51_call')(this.current, p, this.depth === 1 ? this.instructionLimit : 0),
      ),
    );
  }
  private run(action: () => number): void {
    this.assertOpen();
    const state = this.current,
      top = this.fn('lua51_top')(state);
    if (!this.depth) this.hostFailures = [];
    this.depth++;
    try {
      const status = action();
      if (status) {
        const value = this.fn('lua51_type')(state, -1) === 4 ? (this.read(-1) as Uint8Array) : null;
        throw this.errorFromValue(value, status);
      }
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
      throw error;
    } finally {
      this.depth--;
      if (!this.poisoned) this.fn('lua51_settop')(state, top);
    }
  }
  /** Preserve host attribution when a Lua coroutine returns a protected error. */
  errorFromValue(value: LuaValue | undefined, status = 2): LuaRuntimeError {
    const bytes = value instanceof Uint8Array ? value : null;
    const message = bytes ? new TextDecoder().decode(bytes) : `Lua error ${status}`;
    let cause: unknown;
    for (const failure of this.hostFailures)
      if (message === failure.message || message.endsWith(`: ${failure.message}`))
        cause = failure.error;
    return new LuaRuntimeError(message, status, bytes, cause);
  }
  getGlobal(name: string): LuaValue {
    this.assertOpen();
    const state = this.current,
      top = this.fn('lua51_top')(state);
    try {
      this.name(name, (p) => this.fn('lua51_global')(state, p));
      return this.read(-1);
    } finally {
      this.fn('lua51_settop')(state, top);
    }
  }
  setGlobal(name: string, value: LuaValue): void {
    this.assertOpen();
    const state = this.current,
      top = this.fn('lua51_top')(state);
    try {
      this.push(value);
      this.name(name, (p) => this.fn('lua51_setglobal')(state, p));
    } finally {
      this.fn('lua51_settop')(state, top);
    }
  }

  private read(
    index: number,
    seen = new Map<number, LuaTable>(),
    depth = 0,
    budget = {remaining: 100000},
  ): LuaValue {
    if (--budget.remaining < 0) throw new Error('Lua host conversion limit exceeded');
    if (depth > 64) throw new Error('Lua value nesting limit exceeded');
    const L = this.current;
    switch (this.fn('lua51_type')(L, index)) {
      case 0:
        return null;
      case 1:
        return !!this.fn('lua51_boolean')(L, index);
      case 3:
        return this.fn('lua51_number')(L, index);
      case 4:
        return this.bytes(this.fn('lua51_string')(L, index), this.fn('lua51_length')(L, index));
      case 5: {
        const id = this.fn('lua51_pointer')(L, index),
          old = seen.get(id);
        if (old) return old;
        const result: LuaTable = new Map();
        seen.set(id, result);
        const top = this.fn('lua51_top')(L),
          absolute = index > 0 ? index : top + index + 1;
        this.fn('lua51_nil')(L);
        try {
          while (this.fn('lua51_next')(L, absolute)) {
            const key = this.read(-2, seen, depth + 1, budget),
              value = this.read(-1, seen, depth + 1, budget);
            if (key instanceof Uint8Array) result.set(luaText(key), value);
            else if (typeof key === 'number' || typeof key === 'boolean') result.set(key, value);
            else throw new Error('Unsupported Lua table key');
            this.fn('lua51_settop')(L, this.fn('lua51_top')(L) - 1);
          }
          return result;
        } finally {
          this.fn('lua51_settop')(L, top);
        }
      }
      default:
        throw new Error('Unsupported Lua value at host boundary');
    }
  }
  private push(value: LuaValue, ancestors = new Set<LuaTable>()): void {
    const L = this.current;
    if (value === null) this.fn('lua51_nil')(L);
    else if (typeof value === 'boolean') this.fn('lua51_pushboolean')(L, +value);
    else if (typeof value === 'number') this.fn('lua51_pushnumber')(L, value);
    else if (value instanceof Uint8Array)
      this.buffer(value, (p) => this.fn('lua51_pushstring')(L, p, value.length));
    else if (value instanceof LuaReference) {
      value.assertOwner(this);
      this.fn('lua51_pushref')(L, value.id);
    } else {
      if (ancestors.has(value) || ancestors.size > 64)
        throw new Error('Cyclic/deep host Lua value');
      ancestors.add(value);
      this.fn('lua51_table')(L);
      const index = this.fn('lua51_top')(L);
      try {
        for (const [key, item] of value) {
          this.push(typeof key === 'string' ? encoder.encode(key) : key, ancestors);
          this.push(item, ancestors);
          this.fn('lua51_rawset')(L, index);
        }
      } finally {
        ancestors.delete(value);
      }
    }
  }
  private dispatch(state: number, pointer: number, length: number): number {
    const old = this.callbackState;
    this.callbackState = state;
    const top = this.fn('lua51_top')(state);
    try {
      const name = decoder.decode(this.bytes(pointer, length)),
        method = this.methods.get(name);
      if (!method) throw new Error(`Unsupported engine method ${name}`);
      // Skip the engine receiver. Read only the explicit method arguments.
      const referenceMethod = this.referenceMethods.get(name);
      if (referenceMethod) {
        const refs: LuaReference[] = [];
        try {
          for (let i = 2; i <= top; i++) refs.push(this.reference(i));
          const results = referenceMethod(refs);
          for (const result of results) this.push(result);
          return results.length;
        } finally {
          if (!this.poisoned) for (const ref of refs) ref.release();
        }
      }
      const args: LuaValue[] = [];
      for (let i = 2; i <= top; i++) args.push(this.read(i));
      const results = method(args);
      for (const result of results) this.push(result);
      return results.length;
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
      if (this.poisoned) throw error;
      this.fn('lua51_settop')(state, top);
      const message = error instanceof Error ? error.message : String(error);
      if (this.hostFailures.length >= 64) this.hostFailures.shift();
      this.hostFailures.push({message, error});
      this.push(encoder.encode(message));
      return -1; // C calls lua_error after returning from the JavaScript import.
    } finally {
      this.callbackState = old;
    }
  }
  close(): void {
    if (this.depth) throw new Error('Cannot close Lua during execution');
    if (!this.closed && !this.poisoned) this.fn('lua51_close')(this.state);
    this.closed = true;
  }
}

/** A live Lua table/function handle. Retained callback arguments must be released by their owner. */
export class LuaReference {
  private released = false;
  constructor(
    private readonly owner: Lua51,
    readonly id: number,
    readonly type: number,
  ) {}
  assertOwner(owner: Lua51): void {
    if (owner !== this.owner || this.released) throw new Error('Foreign or released Lua reference');
  }
  retain(): LuaReference {
    return this.owner.referenceOperation(this, 'retain') as LuaReference;
  }
  get(key: string): LuaReference {
    return this.owner.referenceOperation(this, 'field', key) as LuaReference;
  }
  read(): LuaValue {
    return this.owner.referenceOperation(this, 'read') as LuaValue;
  }
  invoke(args: readonly LuaValue[] = [], withEngine = false): readonly LuaValue[] {
    if (this.type !== 6) throw new Error('Lua reference is not a function');
    return this.owner.referenceOperation(
      this,
      'invoke',
      undefined,
      args,
      withEngine,
    ) as readonly LuaValue[];
  }
  invokeVoid(args: readonly LuaValue[] = [], withEngine = false): void {
    if (this.type !== 6) throw new Error('Lua reference is not a function');
    this.owner.referenceOperation(this, 'invokeVoid', undefined, args, withEngine);
  }
  invokeFirst(args: readonly LuaValue[] = [], withEngine = false): LuaValue {
    if (this.type !== 6) throw new Error('Lua reference is not a function');
    return this.owner.referenceOperation(
      this,
      'invokeFirst',
      undefined,
      args,
      withEngine,
    ) as LuaValue;
  }
  release(): void {
    if (!this.released) {
      this.owner.referenceOperation(this, 'release');
      this.released = true;
    }
  }
}

export interface LuaThreadResult {
  readonly status: 'yielded' | 'done';
  readonly values: readonly LuaValue[];
}

/** Host-owned Lua coroutine; completion/errors require close() to release its registry root. */
export class LuaThread {
  private started = false;
  private busy = false;
  private terminal = false;
  private released = false;
  constructor(
    private readonly owner: Lua51,
    private readonly reference: LuaReference,
    private readonly withEngine: boolean,
  ) {}
  resume(
    args: readonly LuaValue[] = [],
    discardDoneValues = false,
    maxResults = Infinity,
  ): LuaThreadResult {
    if (this.released || this.terminal) throw new Error('Lua thread is closed or finished');
    if (this.busy) throw new Error('Lua thread is already running');
    if (maxResults !== Infinity && (!Number.isSafeInteger(maxResults) || maxResults < 0))
      throw new Error('Invalid Lua result limit');
    this.busy = true;
    try {
      const result = this.owner.resumeThread(
        this.reference,
        args,
        !this.started && this.withEngine,
        discardDoneValues,
        maxResults,
      );
      this.started = true;
      this.terminal = result.status === 'done';
      return result;
    } catch (error) {
      this.terminal = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }
  close(): void {
    if (this.busy) throw new Error('Cannot close a running Lua thread');
    if (!this.released) {
      this.reference.release();
      this.released = true;
    }
  }
}
