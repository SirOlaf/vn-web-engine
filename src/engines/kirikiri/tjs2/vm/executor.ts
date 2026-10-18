/**
 * The script executor the core installs as `TjsEngine.executor`: compiles a script block to
 * VM code (or reads TJS2 bytecode), instantiates it and runs its top level
 * (`tTJS::ExecScript`, `EvalExpression`, `LoadByteCode`, `tTJSScriptCache`).
 */
import type {CodeBlock} from '../code-block.js';
import {generateScriptBlock, tjs2ConsoleLine, type Tjs2CompilerOptions} from '../compiler.js';
import {isTjs2ByteCode, readTjs2ByteCode} from '../bytecode.js';
import type {TjsEngine, TjsScriptBlock, TjsScriptExecutor} from '../runtime/engine.js';
import {TjsCompileError, TjsScriptError, tjsMessage} from '../runtime/errors.js';
import {TJS_E_SUSPENDED, type Dispatch, type VariantResult} from '../runtime/interface.js';
import {instantiateBlock} from './link.js';
import {Vm, type VmOptions} from './vm.js';

/** `TJS_SCRIPT_CACHE_MAX`. */
const SCRIPT_CACHE_MAX = 64;

export interface TjsVmOptions extends VmOptions {
  readonly compiler: Tjs2CompilerOptions;
}

export class TjsVm implements TjsScriptExecutor {
  readonly vm: Vm;
  /** Anonymous expressions by text and result use, most recently used last. */
  readonly #cache = new Map<string, CodeBlock>();

  constructor(
    readonly engine: TjsEngine,
    readonly options: TjsVmOptions,
  ) {
    this.vm = new Vm(engine, this, {
      evalOperatorIsOnGlobal:
        options.evalOperatorIsOnGlobal ?? options.compiler.evalOperatorIsOnGlobal,
    });
  }

  run(block: TjsScriptBlock, result: VariantResult | null, context: Dispatch | null): number {
    if (block.text === '') return 0;
    const cacheable = block.mode === 'expression' && block.name === '';
    const key = `${result ? 1 : 0}${block.text}`;
    let code = cacheable ? this.#cache.get(key) : undefined;
    if (code) {
      this.#cache.delete(key);
      this.#cache.set(key, code);
    } else {
      const compiled = this.compile(block, result !== null);
      code = compiled.code;
      // Only blocks of one context without preprocessor use are reused (`IsReusable`).
      if (cacheable && compiled.reusable) {
        this.#cache.set(key, code);
        if (this.#cache.size > SCRIPT_CACHE_MAX)
          this.#cache.delete(this.#cache.keys().next().value!);
      }
    }
    return this.runCode(code, result, context);
  }

  /**
   * Compiles a script block (`tTJSScriptBlock::Parse`). Diagnostics go to the console as the
   * native compiler prints them; the first error is thrown as a `TjsCompileError`.
   */
  compile(block: TjsScriptBlock, resultNeeded: boolean): {code: CodeBlock; reusable: boolean} {
    const compiled = generateScriptBlock(
      {
        text: block.text,
        name: block.name,
        lineOffset: block.lineOffset,
        mode: block.mode,
        resultNeeded: block.mode === 'expression' && resultNeeded,
      },
      this.options.compiler,
    );
    const messages = this.options.compiler.messages;
    for (const d of compiled.diagnostics.list) this.engine.host.print(tjs2ConsoleLine(d, messages));
    const first = compiled.diagnostics.errors[0];
    if (first || !compiled.code)
      throw new TjsCompileError(first?.message ?? tjsMessage('TJSInternalError'), {
        name: block.name,
        line: first?.line ?? 1,
      });
    return {
      code: compiled.code,
      reusable: compiled.code.contexts.length === 1 && !compiled.usedPreprocessor,
    };
  }

  /** Instantiates compiled code and runs its top level with `this` = `context` or global. */
  runCode(code: CodeBlock, result: VariantResult | null, context: Dispatch | null): number {
    const top = instantiateBlock(this.vm, code);
    if (!top) return 0;
    let hr: number;
    try {
      hr = top.funcCall(0, null, result as never, [], context);
    } catch (e) {
      top.release();
      throw e;
    }
    if (hr === TJS_E_SUSPENDED)
      return this.engine.suspender.defer((o) => {
        top.release();
        if ('error' in o) throw o.error;
        return o.code;
      });
    top.release();
    return hr;
  }

  doGarbageCollection(): void {
    this.vm.stack.compact();
  }

  runByteCode(
    bytes: Uint8Array,
    name: string,
    result: VariantResult | null,
    context: Dispatch | null,
  ): number | null {
    if (!isTjs2ByteCode(bytes)) return null;
    const code = readTjs2ByteCode(bytes, name);
    if (!code) throw new TjsScriptError(tjsMessage('TJSByteCodeBroken'), {name, line: 1});
    return this.runCode(code, result, context);
  }
}
