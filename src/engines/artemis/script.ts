import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisNativeTagNames, artemisUnknownTagMessage} from './native-tags.js';
import {parseAsb} from '../../formats/artemis/asb.js';
import {
  ARTEMIS_GOTO_TAG,
  ARTEMIS_INDEX_ARG,
  parseIet,
  type IetProgram,
} from '../../formats/artemis/iet.js';
import {artemisInteger} from './numbers.js';
import {artemisTagFilterResult, type ArtemisLua, type ArtemisLuaCall} from './lua.js';
import type {LuaValue} from '../../core/lua51/runtime.js';

const encoder = new TextEncoder();

export interface ArtemisScriptTrace {
  readonly origin: 'script' | 'queue';
  readonly file: string;
  readonly tagIndex: number;
  readonly tag: AsbTag;
}
export type ArtemisScriptState = 'ready' | 'waiting' | 'stopped' | 'ended' | 'faulted';
export interface ArtemisScriptHost {
  readonly nativeTagNames?: ReadonlySet<string>;
  readFile(path: string): Uint8Array | null;
  /** Implemented native services. Throw for every unsupported command. */
  dispatch(tag: AsbTag): 'waiting' | 'stopped' | 'suspended' | void;
  trace?(event: ArtemisScriptTrace): void;
  pushLocal?(): void;
  popLocal?(): void;
  /** Return with no caller reaches native exit/save handling, supplied by the host. */
  emptyReturn?(): 'stopped' | void;
  /** Native calllua c84b0: 12c030 catches function lookup and luabind::error failures,
   * then c7260 reports severity1 and the tag returns normally. The owner supplies the
   * debug-mode/LogFilter/console policy; absent owner keeps the failure strict.
   */
  reportLuaCallError?(report: ArtemisLuaCallErrorReport): void;
  /** c5800: a name outside the native command map with no matching macro reaches
   * c7260(script, 1, tag, "未知のタグ、または未定義のマクロです。") and the tag returns
   * normally. The owner supplies the report policy; without one every name reaches
   * `dispatch`, which refuses unsupported names. */
  reportUnknownTag?(report: ArtemisUnknownTagReport): void;
  /** c5800 strips n leading '$' from an argument value and applies the variable
   * expression evaluator afc60 n times before filtering and dispatch. Absent owner
   * refuses such arguments.
   */
  evaluateExpression?(expression: string): string;
  /** Host-owned caret fields (the wait flags b94..bc8 of CCaret). `take` returns the
   * current caret's fields and clears them for a new caret; `restore` reinstates the fields
   * of a returning caret. */
  caretFields?: {take(): unknown; restore(fields: unknown): void};
  /** 0x1400c0560 before a caret tag of a named file runs (queued tags are exempt): the
   * already-read check. An event scope it enters leaves an empty caret, and the tag waits. */
  beforeCaretTag?(file: string, index: number, tag: AsbTag): void;
  /** b6520/c6730 end a caret change with 0x1400b6cf0, after the new caret is installed. */
  caretTransferred?(): void;
}
export interface ArtemisLuaCallErrorReport {
  readonly file: string;
  readonly tag: AsbTag;
  /** Native last-error bytes formatted by c84b0's "%s". */
  readonly message: Uint8Array;
  readonly severity: 1;
  readonly error: unknown;
}
export interface ArtemisUnknownTagReport {
  readonly file: string;
  readonly tag: AsbTag;
  /** Native Shift_JIS message bytes (0x140372a70). */
  readonly message: Uint8Array;
  readonly severity: 1;
}
export interface ArtemisScriptStackFrame {
  readonly file: string;
  readonly index: number;
  readonly commands: readonly AsbTag[];
  readonly firstCommand: 0 | 1;
}
/** A saved CCaret (script +0xb68 and each call-stack entry): file, index, pending queue
 * and the copy of the tag at the index (+0xa8). */
export interface ArtemisScriptCaret {
  readonly file: string;
  readonly index: number;
  readonly queue: readonly AsbTag[];
  readonly tag: AsbTag | null;
  /** Call-stack frames saved by an event-handler scope resume in this state. */
  readonly resumeState?: ArtemisScriptState;
  /** +0x108 / +0x10c: run mode c70 and the previous mode c74 (0 when absent). */
  readonly runMode?: number;
  readonly previousRunMode?: number;
  /** A call-stack frame's host caret fields (`ArtemisScriptHost.caretFields`); the current
   * caret's fields stay with the host. */
  readonly fields?: unknown;
}
interface PendingLuaCall {
  readonly task: ArtemisLuaCall;
  readonly filterTag?: AsbTag;
  readonly callTag?: AsbTag;
}
interface Cursor {
  program: IetProgram;
  file: string;
  index: number;
  /** CCaret +0x108/+0x10c: run mode c70 and the previous mode c74. A new caret is 0/0. */
  mode: number;
  previousMode: number;
  /** Host caret fields saved with a caller (`ArtemisScriptHost.caretFields`). */
  fields?: unknown;
}

/** Script cursor/queue execution. Native rendering, waits and exit/save effects require host dispatch. */
export class ArtemisScript {
  private cursor: Cursor | null = null;
  private readonly cache = new Map<string, IetProgram>();
  /** Saved carets (c78). Each keeps its own pending tag queue (caret +0x80). */
  private readonly callers: (Cursor & {
    readonly resumeState?: ArtemisScriptState;
    readonly queue: readonly AsbTag[];
  })[] = [];
  private queue: AsbTag[] = [];
  private queueHead = 0;
  private running = false;
  private readonly luaCalls: PendingLuaCall[] = [];
  private luaSuspended = false;
  private frameCall = false;
  state: ArtemisScriptState = 'ended';
  /** Counts `restoreCarets`: a resource operation that loaded a save has replaced the
   * caret it suspended. */
  restoredCarets = 0;
  get currentFile(): string {
    return this.cursor?.file ?? '';
  }
  /** Name of the caret tag at the caret index (+0xb90), the next one the caret runs. */
  get nextTagName(): string | undefined {
    return this.cursor?.program.tags[this.cursor.index]?.name;
  }
  constructor(
    private readonly lua: ArtemisLua,
    private readonly host: ArtemisScriptHost,
  ) {}

  private prepare(path: string): IetProgram {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const bytes = this.host.readFile(path);
    if (bytes === null) throw new Error(`Missing Artemis script ${path}`);
    const parsed =
      bytes[0] === 65 && bytes[1] === 83 && bytes[2] === 66 ? parseAsb(bytes) : parseIet(bytes);
    // Native loader executes every inline Lua block during first load, then clears its argument.
    for (const tag of parsed.tags)
      if (tag.name === 'lua') {
        const script = tag.args.get('script');
        if (script === undefined) throw new Error('Missing inline Lua script');
        this.lua.vm.execute(new TextEncoder().encode(script), `@${path}:${tag.sourceLine}`);
      }
    const program = {
      ...parsed,
      tags: parsed.tags.map((tag) =>
        tag.name === 'lua' ? {...tag, args: new Map([['script', '']])} : tag,
      ),
    };
    this.cache.set(path, program);
    return program;
  }
  private transfer(path: string, label?: string): Cursor {
    if (!path) path = this.cursor?.file ?? '';
    if (!path) throw new Error('Missing Artemis script path');
    const program = this.prepare(path);
    const index = !label ? 0 : program.labels.get(label);
    if (index === undefined) throw new Error(`Missing Artemis label ${path}:${label}`);
    return {program, file: path, index, mode: 0, previousMode: 0};
  }
  load(path: string, label?: string): void {
    if (this.running) throw new Error('Use jump/call for script transfers during dispatch');
    try {
      this.cancelLuaCalls();
      this.cursor = this.transfer(path, label);
      this.host.caretFields?.take();
      this.state = 'ready';
    } catch (error) {
      this.state = 'faulted';
      throw error;
    }
  }
  /** bf210 script part: the caller/handler stacks (0xf8, c78) are dropped without popping
   * local variable scopes (variables +0x70 is not reset), the caret restarts at the boot
   * file (b68/b70) and c4ad0 loads it through the program cache (0xaf8, kept, so inline
   * Lua is not re-executed). The tag queue (0xbe8) and Lua callbacks in flight remain. */
  reset(bootPath: string): void {
    const cursor = this.transfer(bootPath);
    this.callers.length = 0;
    this.cursor = cursor;
    this.host.caretFields?.take();
    this.state = 'ready';
  }
  /** Native transfers assign a fresh caret (b6520 -> b8090), so pending queued tags are
   * dropped. */
  jump(path = '', label?: string): void {
    this.cursor = this.transfer(path, label);
    this.host.caretFields?.take();
    this.clearQueue();
    this.state = 'ready';
    this.host.caretTransferred?.();
  }
  private clearQueue(): void {
    this.queue = [];
    this.queueHead = 0;
  }
  /** Pending tags of the current caret, saved with it by call (eb990). */
  private takeQueue(): AsbTag[] {
    const queue = this.queue.slice(this.queueHead);
    this.clearQueue();
    return queue;
  }
  call(path = '', label?: string): void {
    if (!this.cursor) throw new Error('Artemis call without a script cursor');
    if (this.callers.length >= 10000) throw new Error('Artemis call depth limit exceeded');
    const destination = this.transfer(path, label);
    const fields = this.host.caretFields?.take();
    this.host.pushLocal?.();
    this.callers.push({...this.cursor, fields, queue: this.takeQueue()});
    this.cursor = destination;
    this.state = 'ready';
    this.host.caretTransferred?.();
  }
  /** c6730 handler-only events interrupt with an empty caret and a fresh scope.
   * Resource-suspended Lua must be deferred by the native-mode event owner.
   */
  enterEventHandlerScope(): void {
    if (!this.cursor || (this.state !== 'ready' && this.state !== 'waiting') || this.luaSuspended)
      throw Error('Unsupported Artemis interrupted event scope');
    if (!this.host.pushLocal || !this.host.popLocal)
      throw Error('Artemis event handler requires local scope owner');
    if (this.callers.length >= 10000) throw Error('Artemis call depth limit exceeded');
    this.host.pushLocal();
    const fields = this.host.caretFields?.take();
    this.callers.push({...this.cursor, fields, resumeState: this.state, queue: this.takeQueue()});
    this.cursor = {
      file: '',
      index: 0,
      program: {records: [], tags: [], labels: new Map()},
      mode: 0,
      previousMode: 0,
    };
    this.state = 'ready';
    this.host.caretTransferred?.();
  }
  return(): void {
    if (!this.callers.length) {
      if (!this.host.emptyReturn)
        throw new Error('Native Artemis exit/save handling is not implemented');
      this.state = this.host.emptyReturn() ?? 'ended';
      return;
    }
    this.host.popLocal?.();
    // c6580 assigns the saved caret, including its queue, over the current one.
    const {resumeState, queue, fields, ...cursor} = this.callers.pop()!;
    this.cursor = cursor;
    this.host.caretFields?.restore(fields);
    this.queue = [...queue];
    this.queueHead = 0;
    this.state = resumeState ?? 'ready';
  }
  enqueue(tag: AsbTag): void {
    if (this.queue.length - this.queueHead >= 10000)
      throw new Error('Artemis tag queue limit exceeded');
    this.queue.push({...tag, args: new Map(tag.args)});
  }
  /** Save writer sections 3/4: call-stack carets oldest first, then the current caret.
   * The native save tag runs synchronously, so a resource-suspended Lua callback is
   * refused; running Lua callbacks are host frames, not carets. */
  carets(): ArtemisScriptCaret[] {
    if (!this.cursor) throw Error('Artemis save without a script cursor');
    if (this.luaSuspended) throw Error('Unsupported Artemis save during suspended Lua');
    const caret = (
      cursor: Cursor,
      queue: readonly AsbTag[],
      resumeState?: ArtemisScriptState,
    ): ArtemisScriptCaret => ({
      file: cursor.file,
      index: cursor.index,
      queue: queue.map((tag) => ({...tag, args: new Map(tag.args)})),
      tag: cursor.program.tags[cursor.index] ?? null,
      ...(resumeState ? {resumeState} : {}),
      runMode: cursor.mode,
      previousRunMode: cursor.previousMode,
      ...(cursor.fields !== undefined ? {fields: cursor.fields} : {}),
    });
    return [
      ...this.callers.map((caller) => caret(caller, caller.queue, caller.resumeState)),
      caret(this.cursor, this.queue.slice(this.queueHead)),
    ];
  }
  /** Loader 0x140141b10: replaces the caret and call stack (programs come from the cache
   * +0xaf8). The loader re-resolves the current caret by its tag copy when the program
   * changed; a mismatch is refused. Local variable frames are restored by the variables
   * owner. */
  restoreCarets(carets: readonly ArtemisScriptCaret[]): void {
    if (this.running) throw new Error('Artemis caret restore during dispatch');
    if (!carets.length) throw Error('Artemis save without a current caret');
    const cursors = carets.map((caret) => {
      // An event-handler caret has no file and an empty program.
      const program = caret.file
        ? this.prepare(caret.file)
        : {records: [], tags: [], labels: new Map()};
      return {
        program,
        file: caret.file,
        index: caret.index,
        mode: caret.runMode ?? 0,
        previousMode: caret.previousRunMode ?? 0,
        queue: caret.queue,
        ...(caret.resumeState ? {resumeState: caret.resumeState} : {}),
      };
    });
    const current = cursors.at(-1)!;
    const saved = carets.at(-1)!.tag;
    const actual = current.program.tags[current.index] ?? null;
    if (
      (saved?.name ?? '') !== (actual?.name ?? '') ||
      (saved && actual && saved.sourceLine !== actual.sourceLine)
    )
      throw Error('Unsupported Artemis saved caret relocation');
    this.cancelLuaCalls();
    this.restoredCarets++;
    this.callers.length = 0;
    for (const {queue, ...cursor} of cursors.slice(0, -1))
      this.callers.push({
        ...cursor,
        queue: queue.map((tag) => ({...tag, args: new Map(tag.args)})),
      });
    this.cursor = {
      program: current.program,
      file: current.file,
      index: current.index,
      mode: current.mode,
      previousMode: current.previousMode,
    };
    this.host.caretFields?.take();
    this.queue = current.queue.map((tag) => ({...tag, args: new Map(tag.args)}));
    this.queueHead = 0;
    this.state = 'ready';
  }
  /** getScriptStack (0x1401318a0) source: saved carets oldest first, then the current caret
   * (b70 file, b90 index, be8 queue). Saved queues number from 1, the current one from 0. */
  stack(): ArtemisScriptStackFrame[] {
    return [
      ...this.callers.map((caller) => ({
        file: caller.file,
        index: caller.index,
        commands: caller.queue.slice(),
        firstCommand: 1 as const,
      })),
      {
        file: this.cursor?.file ?? '',
        index: this.cursor?.index ?? 0,
        commands: this.queue.slice(this.queueHead),
        firstCommand: 0 as const,
      },
    ];
  }
  /** Run mode c70 of the current caret. Transfers install a new caret in mode 0; a return
   * restores the caller's caret with its mode. */
  get runMode(): number {
    return this.cursor?.mode ?? 0;
  }
  /** c6160 entry: c74 = c70, c70 = `mode`. */
  enterRunMode(mode: number): void {
    if (!this.cursor) throw Error('Artemis run mode without a caret');
    this.cursor.previousMode = this.cursor.mode;
    this.cursor.mode = mode;
  }
  /** c6480 release: c70 = c74. */
  releaseRunMode(): void {
    if (!this.cursor) throw Error('Artemis run mode without a caret');
    this.cursor.mode = this.cursor.previousMode;
  }
  /** Assigns c70 alone (the loader's run mode 13 bracket restores the saved mode). */
  setRunMode(mode: number): void {
    if (!this.cursor) throw Error('Artemis run mode without a caret');
    this.cursor.mode = mode;
  }
  get queuedTags(): number {
    return this.queue.length - this.queueHead;
  }
  get callDepth(): number {
    return this.callers.length;
  }
  pause(): void {
    if (this.state !== 'ready') throw new Error('Artemis script is not ready to wait');
    this.state = 'waiting';
  }
  /** Ends the current wait. When an event handler scope interrupted the wait, the native run
   * mode still returns to 0 in that frame; the interrupted cursor resumes ready after the
   * handler returns. */
  resume(): void {
    if (this.luaSuspended) throw new Error('Use resumeLua for a suspended Artemis callback');
    if (this.state === 'waiting') {
      this.state = 'ready';
      return;
    }
    for (let index = this.callers.length - 1; index >= 0; index--) {
      const caller = this.callers[index]!;
      if (caller.resumeState !== 'waiting') continue;
      this.callers[index] = {...caller, resumeState: 'ready'};
      return;
    }
    throw new Error('Artemis script is not waiting');
  }
  get pendingLuaCalls(): number {
    return this.luaCalls.length;
  }
  /** Resource completion drives the deepest callback, then its suspended callers. */
  resumeLua(values: readonly LuaValue[] = []): ArtemisScriptState {
    if (this.state !== 'waiting' || !this.luaCalls.length || !this.luaSuspended)
      throw new Error('No suspended Artemis Lua callback');
    this.state = 'ready';
    this.luaSuspended = false;
    let input = values;
    while (this.luaCalls.length) {
      const frame = this.luaCalls.at(-1)!;
      const task = frame.task;
      const index = this.luaCalls.length - 1;
      try {
        const result = task.resume(input);
        if (result.status === 'yielded') {
          this.luaSuspended = true;
          this.state = 'waiting';
          return this.state;
        }
        if (this.luaCalls.at(-1) !== frame)
          throw new Error('Artemis nested callback completed with unsettled resource work');
        this.luaCalls.pop();
        task.close();
        if (frame.filterTag && !artemisTagFilterResult(result.values[0])) {
          if (this.dispatchNative(frame.filterTag) === 'suspended') return this.state;
        }
        input = [];
      } catch (failure) {
        for (const abandoned of this.luaCalls.splice(index).reverse()) abandoned.task.close();
        let error = failure;
        if (frame.callTag)
          try {
            this.reportLuaCall(frame.callTag, failure);
            input = []; // The calllua tag returned; its caller continues normally.
            continue;
          } catch (strict) {
            error = strict;
          }
        if (!this.luaCalls.length) {
          this.state = 'faulted';
          throw error;
        }
        input = [
          false,
          new TextEncoder().encode(error instanceof Error ? error.message : String(error)),
        ];
      }
    }
    return this.state;
  }
  cancelLuaCalls(): void {
    for (const frame of this.luaCalls.slice().reverse()) frame.task.close();
    this.luaCalls.length = 0;
    this.luaSuspended = false;
  }
  /** `frameCall`: the tag comes from a frame-phase Lua call (event filter, `onEnterFrame`).
   * Its resource suspension holds the frame, not the script, so the script state stays. */
  executeTag(tag: AsbTag, frameCall = false): void | 'suspended' {
    const outer = this.frameCall;
    this.frameCall = frameCall;
    try {
      return this.dispatch(tag);
    } catch (error) {
      this.state = 'faulted';
      throw error;
    } finally {
      this.frameCall = outer;
    }
  }
  /** The evaluated value replaces the argument; exact Lua argument bytes of that key are
   * replaced by its UTF-8 bytes (code page 2), so byte readers see the result too. */
  private evaluateArguments(tag: AsbTag): AsbTag {
    let args: Map<string, string> | null = null,
      bytes: Map<string, Uint8Array> | null = null;
    for (const [key, value] of tag.args) {
      let count = 0;
      while (value[count] === '$') count++;
      if (!count) continue;
      if (!this.host.evaluateExpression)
        throw new Error('Unsupported Artemis expression argument without an evaluator');
      let result = value.slice(count);
      for (; count > 0; count--) result = this.host.evaluateExpression(result);
      (args ??= new Map(tag.args)).set(key, result);
      if (tag.bytes?.has(key)) (bytes ??= new Map(tag.bytes)).set(key, encoder.encode(result));
    }
    if (!args) return tag;
    return bytes ? {...tag, args, bytes} : {...tag, args};
  }
  private dispatch(source: AsbTag): void | 'suspended' {
    if (!source.name) return; // Native generated empty handler block has no action.
    const tag = this.evaluateArguments(source);
    if (this.lua.suspendableTags) {
      const task = this.lua.createTagFilterCall(tag);
      if (task) return this.beginLuaCall(task, {...tag, args: new Map(tag.args)});
    } else if (this.lua.filterTag(tag)) return;
    return this.dispatchNative(tag);
  }
  /** Report a recoverable calllua failure through the owner, otherwise rethrow it. */
  private reportLuaCall(tag: AsbTag, error: unknown): void {
    const message = this.host.reportLuaCallError ? this.lua.callErrorMessage(error) : null;
    if (!message) throw error;
    this.host.reportLuaCallError!({file: this.currentFile, tag, message, severity: 1, error});
  }
  private beginLuaCall(
    task: ArtemisLuaCall,
    filterTag?: AsbTag,
    callTag?: AsbTag,
  ): void | 'suspended' {
    if (this.luaCalls.length >= 1000) {
      task.close();
      throw new Error('Artemis Lua call depth limit exceeded');
    }
    const frame = {task, filterTag, callTag},
      index = this.luaCalls.length;
    this.luaCalls.push(frame);
    try {
      const result = task.resume();
      if (result.status === 'yielded') {
        this.luaSuspended = true;
        this.state = 'waiting';
        return 'suspended';
      }
      if (this.luaCalls.at(-1) !== frame)
        throw new Error('Artemis nested callback completed with unsettled resource work');
      this.luaCalls.pop();
      task.close();
      if (filterTag && !artemisTagFilterResult(result.values[0]))
        return this.dispatchNative(filterTag);
    } catch (error) {
      for (const abandoned of this.luaCalls.splice(index).reverse()) abandoned.task.close();
      if (!callTag) throw error;
      this.reportLuaCall(callTag, error);
    }
  }
  private dispatchNative(tag: AsbTag): void | 'suspended' {
    switch (tag.name) {
      case 'lua':
        break;
      case 'calllua': {
        const name = tag.args.get('function');
        if (!name) throw new Error('Missing calllua function');
        let task: ArtemisLuaCall;
        try {
          if (!this.lua.suspendableTags) {
            this.lua.call(name, tag.args);
            break;
          }
          task = this.lua.createCall(name, tag.args);
        } catch (error) {
          this.reportLuaCall(tag, error);
          break;
        }
        return this.beginLuaCall(task, undefined, tag);
      }
      // e9fb0: atoi(estimate)==0 writes cursor b90; c7800 writes it unconditionally.
      // The frame loop has already advanced b90, so the target tag runs next.
      case 'if':
      case 'elseif':
      case 'loop':
        if (artemisInteger(tag.args.get('estimate') ?? '') !== 0) break;
      // Falls through to the shared cursor write.
      case ARTEMIS_GOTO_TAG:
        if (!this.cursor) throw new Error('Artemis branch without a script cursor');
        this.cursor.index = artemisInteger(tag.args.get(ARTEMIS_INDEX_ARG) ?? '');
        break;
      case 'jump':
        this.jump(tag.args.get('file'), tag.args.get('label'));
        break;
      case 'call':
        this.call(tag.args.get('file'), tag.args.get('label'));
        break;
      case 'return':
        this.return();
        break;
      default: {
        // The macro stack (b38..b40) stays empty: macroadd is not implemented here.
        if (
          this.host.reportUnknownTag &&
          !(this.host.nativeTagNames ?? artemisNativeTagNames).has(tag.name)
        ) {
          this.host.reportUnknownTag({
            file: this.currentFile,
            tag,
            message: artemisUnknownTagMessage.slice(),
            severity: 1,
          });
          break;
        }
        const state = this.host.dispatch(tag);
        if (state === 'suspended') {
          if (!this.frameCall) this.state = 'waiting';
          return 'suspended';
        }
        if (state) this.state = state;
      }
    }
  }
  step(): ArtemisScriptState {
    if (this.running) throw new Error('Reentrant Artemis script step');
    if (this.state !== 'ready') return this.state;
    const cursor = this.cursor,
      queued = this.queuedTags > 0;
    const tag = queued ? this.queue[this.queueHead++] : cursor?.program.tags[cursor.index];
    if (this.queueHead === this.queue.length) {
      this.queue = [];
      this.queueHead = 0;
    }
    if (!tag) {
      try {
        this.return();
        return this.state;
      } catch (error) {
        this.state = 'faulted';
        throw error;
      }
    }
    if (!queued && cursor!.file && this.host.beforeCaretTag) {
      try {
        this.host.beforeCaretTag(cursor!.file, cursor!.index, tag);
      } catch (error) {
        this.state = 'faulted';
        throw error;
      }
      if (this.cursor !== cursor) {
        if (!this.cursor?.file) return this.state;
        this.state = 'faulted';
        throw Error('Unsupported Artemis caret change in the read check');
      }
    }
    this.running = true;
    try {
      this.host.trace?.({
        origin: queued ? 'queue' : 'script',
        file: cursor?.file ?? '',
        tagIndex: queued ? -1 : cursor!.index,
        tag,
      });
      if (!queued) cursor!.index++;
      this.dispatch(tag);
      return this.state;
    } catch (error) {
      this.state = 'faulted';
      throw error;
    } finally {
      this.running = false;
    }
  }
  run(maxSteps = 1000): ArtemisScriptState {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
      throw new Error('Invalid Artemis step limit');
    for (let n = 0; n < maxSteps && this.state === 'ready'; n++) this.step();
    return this.state;
  }
}
