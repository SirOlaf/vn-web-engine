import {defineNativeContract} from '../../platform/native-libraries.js';

/**
 * The Kirikiri plugin interface: what `tp_stub.h` gives a TVP plugin. It holds the TJS2 object
 * interface (`iTJSDispatch2`, variants, result codes), the function exporter a plugin receives
 * in `V2Link`, and the core interfaces plugins implement (`iTVPStorageMedia`) or use
 * (`tTJSBinaryStream`). Reference build: `nekopara_vol1.exe` (SHA-256 `0b81a3c9…`), whose
 * exporter (0x420550) lists 649 functions by C++ signature.
 *
 * TJS values cross as tagged variants; objects are `Dispatch` handles with reference counts.
 * Two calls may complete asynchronously, where the native core blocks on file I/O: opening a
 * storage (`TvpStorageMedia.open`, `TvpFunctionExporter.TVPCreateStream`) and `V2Link`. The
 * core suspends the calling script until they settle.
 */

// --- Variants -------------------------------------------------------------------------------

export interface VoidVariant {
  readonly type: 0;
}
export interface ObjectVariant {
  readonly type: 1;
  readonly object: Dispatch | null;
  readonly objthis: Dispatch | null;
}
export interface StringVariant {
  readonly type: 2;
  readonly value: string;
}
export interface OctetVariant {
  readonly type: 3;
  readonly value: Uint8Array;
}
export interface IntegerVariant {
  readonly type: 4;
  readonly value: bigint;
}
export interface RealVariant {
  readonly type: 5;
  readonly value: number;
}
/**
 * `tTJSVariant`: void, an object closure, a string (the empty string is the native null
 * string), an octet (length 0 is the null octet), a signed 64-bit integer, a double.
 */
export type Variant =
  VoidVariant | ObjectVariant | StringVariant | OctetVariant | IntegerVariant | RealVariant;

/**
 * A caller-owned result variable (`tTJSVariant *result`). Assigning an object variant takes
 * references on its object and context; replacing or clearing releases them.
 */
export interface VariantResult {
  readonly value: Variant;
  set(value: Variant): void;
  clear(): void;
}

// Result codes (`tjsErrorDefs.h`).
export const TJS_S_OK = 0;
export const TJS_S_TRUE = 1;
export const TJS_S_FALSE = 2;
export const TJS_E_FAIL = -1;
export const TJS_E_MEMBERNOTFOUND = -1001;
export const TJS_E_NOTIMPL = -1002;
export const TJS_E_INVALIDPARAM = -1003;
export const TJS_E_BADPARAMCOUNT = -1004;
export const TJS_E_INVALIDTYPE = -1005;
export const TJS_E_INVALIDOBJECT = -1006;
export const TJS_E_ACCESSDENYED = -1007;
export const TJS_E_NATIVECLASSCRASH = -1008;
/**
 * Not a native code. The callee has started work that completes asynchronously and has
 * pushed its continuation (`suspension.ts`). It is a failure code so that callers which do not
 * know about suspension either propagate it unchanged (`if (failed(hr)) return hr`) or throw
 * on it, never mistake it for a result.
 */
export const TJS_E_SUSPENDED = -1100;

export function failed(code: number): boolean {
  return code < 0;
}
export function succeeded(code: number): boolean {
  return code >= 0;
}

// Call flags.
export const TJS_MEMBERENSURE = 0x00000200;
export const TJS_MEMBERMUSTEXIST = 0x00000400;
export const TJS_IGNOREPROP = 0x00000800;
export const TJS_HIDDENMEMBER = 0x00001000;
export const TJS_STATICMEMBER = 0x00010000;
export const TJS_ENUM_NO_VALUE = 0x00100000;

// NativeInstanceSupport flags.
export const TJS_NIS_REGISTER = 0x00000001;
export const TJS_NIS_GETINSTANCE = 0x00000002;

// ClassInstanceInfo flags.
export const TJS_CII_GET = 0x00000000;
export const TJS_CII_ADD = 0x00000001;
export const TJS_CII_SET_FINALIZE = 0x00000002;
export const TJS_CII_SET_MISSING = 0x00000003;
export const TJS_CII_SET_SUPRECLASS = 0x00000004;
export const TJS_CII_GET_SUPRECLASS = 0x00000005;

// Operation codes (the low bits of the Operation flag).
export const TJS_OP_BAND = 0x0001;
export const TJS_OP_BOR = 0x0002;
export const TJS_OP_BXOR = 0x0003;
export const TJS_OP_SUB = 0x0004;
export const TJS_OP_ADD = 0x0005;
export const TJS_OP_MOD = 0x0006;
export const TJS_OP_DIV = 0x0007;
export const TJS_OP_IDIV = 0x0008;
export const TJS_OP_MUL = 0x0009;
export const TJS_OP_LOR = 0x000a;
export const TJS_OP_LAND = 0x000b;
export const TJS_OP_SAR = 0x000c;
export const TJS_OP_SAL = 0x000d;
export const TJS_OP_SR = 0x000e;
export const TJS_OP_INC = 0x000f;
export const TJS_OP_DEC = 0x0010;
export const TJS_OP_MASK = 0x001f;
export const TJS_OP_MIN = TJS_OP_BAND;
export const TJS_OP_MAX = TJS_OP_DEC;

/** A mutable out-parameter. */
export interface Out<T> {
  value: T;
}

/**
 * `iTJSDispatch2`. `member` null addresses the object itself (its default member). Results go
 * to caller-owned slots, which take a reference; arguments are borrowed for the call.
 * `objthis` is the context (`this`) the member runs with.
 *
 * Reference counting follows the native rules: an object starts with one reference owned by
 * its creator; `release` of the last reference finalizes it.
 */
export interface Dispatch {
  addRef(): number;
  release(): number;

  funcCall(
    flag: number,
    member: string | null,
    result: VariantResult | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number;
  funcCallByNum(
    flag: number,
    num: number,
    result: VariantResult | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number;
  propGet(
    flag: number,
    member: string | null,
    result: VariantResult | null,
    objthis: Dispatch | null,
  ): number;
  propGetByNum(
    flag: number,
    num: number,
    result: VariantResult | null,
    objthis: Dispatch | null,
  ): number;
  propSet(flag: number, member: string | null, value: Variant, objthis: Dispatch | null): number;
  propSetByNum(flag: number, num: number, value: Variant, objthis: Dispatch | null): number;
  getCount(result: Out<number>, member: string | null, objthis: Dispatch | null): number;
  getCountByNum(result: Out<number>, num: number, objthis: Dispatch | null): number;
  /** Calls `callback(name, flags[, value])` per member until it returns false. */
  enumMembers(flag: number, callback: ObjectVariant, objthis: Dispatch | null): number;
  deleteMember(flag: number, member: string | null, objthis: Dispatch | null): number;
  deleteMemberByNum(flag: number, num: number, objthis: Dispatch | null): number;
  invalidate(flag: number, member: string | null, objthis: Dispatch | null): number;
  invalidateByNum(flag: number, num: number, objthis: Dispatch | null): number;
  /** TJS_S_TRUE (valid) or TJS_S_FALSE. */
  isValid(flag: number, member: string | null, objthis: Dispatch | null): number;
  isValidByNum(flag: number, num: number, objthis: Dispatch | null): number;
  /** The new object is returned with one reference owned by the caller. */
  createNew(
    flag: number,
    member: string | null,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number;
  createNewByNum(
    flag: number,
    num: number,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number;
  /** TJS_S_TRUE or TJS_S_FALSE. */
  isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number;
  isInstanceOfByNum(flag: number, num: number, className: string, objthis: Dispatch | null): number;
  /** Applies `flag & TJS_OP_MASK` to the member with `param`. */
  operation(
    flag: number,
    member: string | null,
    result: VariantResult | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number;
  operationByNum(
    flag: number,
    num: number,
    result: VariantResult | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number;
  nativeInstanceSupport(flag: number, classId: number, pointer: Out<NativeInstance | null>): number;
  classInstanceInfo(flag: number, num: number, value: VariantResult): number;
}

/** `iTJSNativeInstance`: the native part of an object of a native class. */
export interface NativeInstance {
  /** TJS constructor. */
  construct(args: readonly Variant[], owner: Dispatch): number;
  /** Called before destruction (on invalidate or the last release). */
  invalidate(): void;
  destruct(): void;
}

// --- Core interfaces --------------------------------------------------------------------------

/** `tTJSBinaryStream` seek origins. */
export const TJS_BS_SEEK_SET = 0;
export const TJS_BS_SEEK_CUR = 1;
export const TJS_BS_SEEK_END = 2;
/** Access modes (`flags & TJS_BS_ACCESS_MASK`). */
export const TJS_BS_READ = 0;
export const TJS_BS_WRITE = 1;
export const TJS_BS_APPEND = 2;
export const TJS_BS_UPDATE = 3;
export const TJS_BS_ACCESS_MASK = 0x0f;

/**
 * `tTJSBinaryStream`. Reads are synchronous over data the stream holds; a stream over a large
 * file holds only the ranges that `prefetch` has loaded, and `read` of a range that is not
 * loaded throws. Positions and sizes are byte offsets below 2^53.
 */
export interface TjsBinaryStream {
  /** Moves the position; returns the new position. */
  seek(offset: number, whence: number): number;
  /** Reads up to `length` bytes at the position and advances it. */
  read(length: number): Uint8Array;
  /** Loads a range so that later reads of it are synchronous. */
  prefetch(offset: number, length: number): void | Promise<void>;
  write(data: Uint8Array): number;
  setEndOfStorage(): void;
  getSize(): number;
  /** Closes the stream (`Destruct`). */
  destruct(): void;
}

/**
 * `iTVPStorageMedia`: a storage scheme (`file`, the protection plugin's `archive`). Names
 * passed in are the domain-and-path part of a normalized storage name (`./data.xp3/x.tjs`).
 */
export interface TvpStorageMedia {
  addRef(): void;
  release(): void;
  getName(): string;
  normalizeDomainName(name: string): string;
  normalizePathName(name: string): string;
  checkExistentStorage(name: string): boolean;
  open(name: string, flags: number): TjsBinaryStream | Promise<TjsBinaryStream>;
  /** Calls `add` with the name of every storage in the directory `name`. */
  getListAt(name: string, add: (file: string) => void): void;
  /** The local file name, or the empty string when the storage has none. */
  getLocallyAccessibleName(name: string): string;
}

/**
 * The function exporter (`iTVPFunctionExporter`). Each member is the core function of the
 * same name; `has` answers `TVPGetImportFuncPtr` probes by full exporter signature.
 * Functions are added here as plugins need them.
 */
export interface TvpFunctionExporter {
  has(signature: string): boolean;

  /**
   * Not a native function: the substitute for blocking I/O inside a native method. Returns
   * `TJS_E_SUSPENDED` after arranging for `then(value)` to finish the call once `promise`
   * settles; the method returns that code. Throws where the caller cannot be suspended.
   */
  suspend<T>(promise: Promise<T>, then: (value: T) => number): number;

  /** `TVPGetScriptDispatch`: the global object, with a reference for the caller. */
  TVPGetScriptDispatch(): Dispatch;
  /** `TJSCreateArrayObject`, owned by the caller. */
  TJSCreateArrayObject(): Dispatch;
  /** `TJSCreateDictionaryObject`, owned by the caller. */
  TJSCreateDictionaryObject(): Dispatch;

  TVPAddLog(message: string): void;
  TVPAddImportantLog(message: string): void;
  /** `TVPGetCommandLine`: the value of a `-name=value` option, or null. */
  TVPGetCommandLine(name: string): string | null;
  /** `TVPSetCommandLine`. */
  TVPSetCommandLine(name: string, value: string): void;
  /** `TVPGetAppPath`: the executable's directory as a storage name, ending in `/`. */
  TVPGetAppPath(): string;

  TVPRegisterStorageMedia(media: TvpStorageMedia): void;
  TVPUnregisterStorageMedia(media: TvpStorageMedia): void;
  TVPSetCurrentDirectory(name: string): void;
  TVPNormalizeStorageName(name: string): string;
  TVPExtractStorageName(name: string): string;
  TVPExtractStoragePath(name: string): string;
  TVPAddAutoPath(name: string): void;
  TVPRemoveAutoPath(name: string): void;
  TVPClearStorageCaches(): void;
  TVPIsExistentStorage(name: string): boolean;
  /** `TVPCreateStream` (also behind `TVPCreateIStream` and the stream adapters). */
  TVPCreateStream(name: string, flags: number): TjsBinaryStream | Promise<TjsBinaryStream>;
}

/** What a TVP plugin exports: `V2Link` and `V2Unlink`. */
export interface TvpPluginExports {
  /**
   * Links the plugin into the core. Returns `S_OK` (0) or an HRESULT failure; a promise when
   * linking reads storage that is not loaded yet.
   */
  v2Link(exporter: TvpFunctionExporter): number | Promise<number>;
  v2Unlink(): number;
}

/** Every TVP plugin (`.dll`, `.tpm`) provides this surface. */
export const TVP_PLUGIN = defineNativeContract<TvpPluginExports>('<tvp-plugin>', 'tvp-v2');
