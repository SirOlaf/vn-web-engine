/**
 * TJS2 exceptions (krkrz `tjsError.h`): the C++ exception classes the core throws, and the
 * conversion of failed result codes into them. Messages come from the core's message table in
 * the user's UI language; the engine installs it with `setTjsMessages`.
 */
import {
  ENGLISH_MESSAGES,
  formatMessage,
  type KirikiriMessageName,
  type KirikiriMessages,
} from '../../messages.js';
import {
  TJS_E_ACCESSDENYED,
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDOBJECT,
  TJS_E_INVALIDPARAM,
  TJS_E_INVALIDTYPE,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NATIVECLASSCRASH,
  TJS_E_NOTIMPL,
  TJS_E_SUSPENDED,
} from './interface.js';
import type {Variant} from './variant.js';

let messages: KirikiriMessages = ENGLISH_MESSAGES;

/** Installs the message table of the running core (`TVPLoadMessage`). */
export function setTjsMessages(table: KirikiriMessages): void {
  messages = table;
}

/** `TJSAssignMessage`: replaces a message of the table in use; false for unknown names. */
export function assignTjsMessage(name: string, text: string): boolean {
  if (!Object.hasOwn(messages, name)) return false;
  messages = Object.freeze({...messages, [name]: text});
  return true;
}

/** A core message, with `%1`, `%2`, … replaced. */
export function tjsMessage(name: KirikiriMessageName, ...args: readonly string[]): string {
  return formatMessage(messages[name], ...args);
}

/** `eTJS`/`eTJSError`: an error with a message. */
export class TjsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TjsError';
  }
}

/** `eTJSVariantError`: a failed variant conversion or operation. */
export class TjsVariantError extends TjsError {
  constructor(message: string) {
    super(message);
    this.name = 'TjsVariantError';
  }
}

/** Where a script error happened: a script block and a source position in it. */
export interface TjsScriptSource {
  readonly name: string;
  /** 1-based line of the source position. */
  readonly line: number;
}

/** `eTJSScriptError`: an error with its script position and the trace text. */
export class TjsScriptError extends TjsError {
  trace = '';
  constructor(
    message: string,
    readonly source: TjsScriptSource | null,
  ) {
    super(message);
    this.name = 'TjsScriptError';
  }

  /** `AddTrace`: appends a call site, up to 1,500 characters of trace. */
  addTrace(description: string): boolean {
    if (this.trace.length >= 1500) return false;
    if (this.trace.length !== 0) this.trace += ' <-- ';
    this.trace += description;
    return true;
  }
}

/**
 * `eTJSScriptException`: a script `throw`, or a native error converted to an `Exception`
 * object. `value` is the thrown value; an object value is owned by the exception and released
 * by whoever handles it.
 */
export class TjsScriptException extends TjsScriptError {
  constructor(
    message: string,
    source: TjsScriptSource | null,
    readonly value: Variant,
  ) {
    super(message, source);
    this.name = 'TjsScriptException';
  }
}

/** `eTJSCompileError`. */
export class TjsCompileError extends TjsScriptError {
  constructor(message: string, source: TjsScriptSource | null) {
    super(message, source);
    this.name = 'TjsCompileError';
  }
}

/**
 * Raised when a callee returned `TJS_E_SUSPENDED` to a caller that cannot resume. The pending
 * continuation is discarded by the scheduler.
 */
export class TjsSuspensionError extends TjsError {
  constructor(message: string) {
    super(message);
    this.name = 'TjsSuspensionError';
  }
}

export function throwTjsError(name: KirikiriMessageName, ...args: readonly string[]): never {
  throw new TjsError(tjsMessage(name, ...args));
}

/** `TJSThrowFrom_tjs_error`: throws for a failed code; `name` is the member name if known. */
export function throwFromCode(code: number, name: string | null = null): void {
  switch (code) {
    case TJS_E_MEMBERNOTFOUND:
      if (name !== null) throwTjsError('TJSMemberNotFound', name);
      throwTjsError('TJSMemberNotFoundNoNameGiven');
    case TJS_E_NOTIMPL:
      throwTjsError('TJSNotImplemented');
    case TJS_E_INVALIDPARAM:
      throwTjsError('TJSInvalidParam');
    case TJS_E_BADPARAMCOUNT:
      throwTjsError('TJSBadParamCount');
    case TJS_E_INVALIDTYPE:
      throwTjsError('TJSInvalidType');
    case TJS_E_ACCESSDENYED:
      throwTjsError('TJSAccessDenyed');
    case TJS_E_INVALIDOBJECT:
      throwTjsError('TJSInvalidObject');
    case TJS_E_NATIVECLASSCRASH:
      throwTjsError('TJSNativeClassCrash');
    case TJS_E_SUSPENDED:
      throw new TjsSuspensionError('A suspending call returned to a caller that cannot resume');
    default:
      if (code < 0)
        throw new TjsError(
          tjsMessage('TJSUnknownFailure').replace(
            '%08X',
            (code >>> 0).toString(16).toUpperCase().padStart(8, '0'),
          ),
        );
  }
}

/** Calls `throwFromCode` for failed codes and returns successful ones. */
export function check(code: number, name: string | null = null): number {
  if (code < 0) throwFromCode(code, name);
  return code;
}
