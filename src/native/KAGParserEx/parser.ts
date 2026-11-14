/**
 * `tTJSNI_KAGParser` of KAGParserEx: the KAG scenario parser of kirikiri 2 with the plugin's
 * extensions (multi-line tags, `taglist`, parameter macros).
 *
 * The parser follows the native code statement by statement, including where its results
 * depend on state left by earlier work:
 *
 * - The current line is a position in a NUL-terminated buffer (the scenario's, or the line
 *   buffer after a macro or `emb` expansion, `[call]` return or multi-line join); reads past a
 *   scenario line's end read the following text.
 * - `getNextTag` returns the same dictionary every time, cleared at the next call; `taglist` is
 *   its attribute-order array.
 * - An attribute name is added through `PropSetByVS`, which refuses the empty name, but
 *   `taglist` lists it: the space after the `;` of a multi-line tag's next line yields an
 *   empty attribute (`true`) there.
 * - `restore` decodes `ExcludeLevelStack` from overlapping 8-character windows (offset `i`, not
 *   `i * 8`).
 *
 * Callbacks into script (`onScenarioLoad`, `onScenarioLoaded`, `onLabel`, `onScript`, `onJump`,
 * `onCall`, `onReturn`, `onAfterReturn`) and storage reads may suspend; the methods that make
 * them are routines (`PluginRoutine`).
 */
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {
  asBoolean,
  asInt32,
  asString,
  int,
  obj,
  str,
  VOID,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {type PluginRoutine} from '../../engines/kirikiri/tp-stub/tp-stub.js';
import {
  failed,
  TJS_MEMBERENSURE,
  TJS_S_OK,
  type Dispatch,
  type NativeInstance,
  type TvpFunctionExporter,
  type Variant,
} from '../tvp-plugin/contract.js';
import {type ScenarioCache, ScenarioItem} from './scenario.js';

/** `tTVPKAGDebugLevel`. */
const TKDL_SIMPLE = 1;
const TKDL_VERBOSE = 2;

/** `__FILE__` of the binary's `TVPThrowInternalError`. */
export const SOURCE_FILE =
  'c:\\dwork\\kirikiri\\kirikiri2\\kirikiri2\\src\\plugins\\win32\\kagparserex\\KAGParser.cpp';

const TAB = 9;
const LF = 10;
const SPACE = 32;
const QUOTE = 34;
const AMP = 38;
const APOS = 39;
const PERCENT = 37;
const STAR = 42;
const EQ = 61;
const AT = 64;
const LBRACKET = 91;
const BACKSLASH = 92;
const RBRACKET = 93;
const BACKTICK = 96;
const P = 112;

/** `TVPIsWS`. */
const isWS = (c: number) => c === SPACE || c === TAB;

/** `tTJSString::ToLowerCase`: ASCII letters only. */
const toLowerCase = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** `ttstr(variant)`. */
const ttstr = (v: Variant) => asString(v);

const HR = '='.repeat(80);
const HR_JUMP = '- '.repeat(40);

/** The special tags (`tSpecialTags`). */
const enum Tag {
  Other,
  If,
  Else,
  Elsif,
  Ignore,
  Endif,
  Endignore,
  Emb,
  Macro,
  Endmacro,
  Macropop,
  Erasemacro,
  Jump,
  Call,
  Return,
  Pmacro,
  Erasepmacro,
}

const SPECIAL_TAGS = new Map<string, Tag>([
  ['if', Tag.If],
  ['ignore', Tag.Ignore],
  ['endif', Tag.Endif],
  ['endignore', Tag.Endignore],
  ['else', Tag.Else],
  ['elsif', Tag.Elsif],
  ['emb', Tag.Emb],
  ['macro', Tag.Macro],
  ['endmacro', Tag.Endmacro],
  ['macropop', Tag.Macropop],
  ['erasemacro', Tag.Erasemacro],
  ['jump', Tag.Jump],
  ['call', Tag.Call],
  ['return', Tag.Return],
  ['pmacro', Tag.Pmacro],
  ['erasepmacro', Tag.Erasepmacro],
]);

/** The plugin's shared state: `Dictionary`/`Array` methods (`initMethod`) and the cache. */
export interface KagContext {
  readonly ex: TvpFunctionExporter;
  readonly dicClear: Dispatch;
  readonly dicAssign: Dispatch;
  readonly arrayClear: Dispatch;
  readonly arrayAssign: Dispatch;
  readonly arrayPush: Dispatch;
  readonly cache: ScenarioCache;
  /** `TVPGetScenario`. */
  getScenario(name: string, isString: boolean): PluginRoutine<ScenarioItem>;
}

/** Reads a member through a closure (`tTJSVariantClosure::PropGet` with a null context). */
function closureGet(v: Variant, member: string | number, result: VariantSlot): number {
  if (v.type !== 1 || !v.object) return -1;
  const target = v.object;
  const objthis = v.objthis ?? target;
  return typeof member === 'number'
    ? target.propGetByNum(0, member, result, objthis)
    : target.propGet(0, member, result, objthis);
}

/** `TJSGetArrayElementCount`. */
function elementCount(array: Dispatch): number {
  const v = new VariantSlot();
  array.propGet(0, 'count', v, array);
  const n = asInt32(v.value);
  v.clear();
  return n;
}

/** `ArgValue`: tag attributes as a dictionary and their names in order. */
class ArgValue {
  readonly dic: Dispatch;
  readonly array: Dispatch;

  constructor(private readonly k: KagContext) {
    this.dic = k.ex.TJSCreateDictionaryObject();
    this.array = k.ex.TJSCreateArrayObject();
  }

  /** The copy constructor. */
  static copy(k: KagContext, orig: ArgValue): ArgValue {
    const a = new ArgValue(k);
    a.assign(orig);
    return a;
  }

  /** Construction from a save array (`[name, value, name, value…]`). */
  static fromSaveArray(k: KagContext, arrayVar: Variant): ArgValue {
    const a = new ArgValue(k);
    const src = arrayVar.type === 1 ? arrayVar.object : null;
    if (!src) return a;
    const count = elementCount(src);
    for (let i = 0; i < count; i += 2) {
      const name = new VariantSlot();
      const value = new VariantSlot();
      if (
        !failed(src.propGetByNum(0, i, name, src)) &&
        !failed(src.propGetByNum(0, i + 1, value, src))
      )
        a.addVariant(name.value, value.value);
      name.clear();
      value.clear();
    }
    return a;
  }

  /** `operator=`. */
  assign(right: ArgValue): void {
    this.k.dicAssign.funcCall(0, null, null, [obj(right.dic, right.dic)], this.dic);
    this.k.arrayAssign.funcCall(0, null, null, [obj(right.array, right.array)], this.array);
  }

  release(): void {
    this.dic.release();
    this.array.release();
  }

  clear(): void {
    this.k.dicClear.funcCall(0, null, null, [], this.dic);
    this.k.arrayClear.funcCall(0, null, null, [], this.array);
  }

  /**
   * `PropSetByVS`: the empty name is the null variant string, which the dictionary refuses
   * (`TJS_E_INVALIDTYPE`); the name is listed all the same.
   */
  add(name: string, value: Variant): void {
    if (name !== '') this.dic.propSet(TJS_MEMBERENSURE, name, value, this.dic);
    this.k.arrayPush.funcCall(0, null, null, [str(name)], this.array);
  }

  addVariant(name: Variant, value: Variant): void {
    const s = ttstr(name);
    if (s !== '') this.dic.propSet(TJS_MEMBERENSURE, s, value, this.dic);
    this.k.arrayPush.funcCall(0, null, null, [name], this.array);
  }

  getProp(name: string, value: VariantSlot): number {
    return this.dic.propGet(0, name, value, this.dic);
  }

  /** The dictionary with `taglist`, with a reference for the caller. */
  getReturn(): Dispatch {
    this.dic.propSet(TJS_MEMBERENSURE, 'taglist', obj(this.array, this.array), this.dic);
    this.dic.addRef();
    return this.dic;
  }

  /** `extract`: each listed name that the dictionary has, with its value. */
  extract(store: (name: Variant, value: Variant) => void): void {
    const count = elementCount(this.array);
    for (let i = 0; i < count; i++) {
      const name = new VariantSlot();
      const value = new VariantSlot();
      if (!failed(this.array.propGetByNum(0, i, name, this.array))) {
        if (!failed(this.dic.propGet(0, ttstr(name.value), value, this.dic)))
          store(name.value, value.value);
      }
      name.clear();
      value.clear();
    }
  }

  /** `getArray`: the save array, owned by the caller. */
  getArray(): Dispatch {
    const array = this.k.ex.TJSCreateArrayObject();
    this.extract((name, value) => {
      this.k.arrayPush.funcCall(0, null, null, [name, value], array);
    });
    return array;
  }
}

/** `tCallStackData`. */
interface CallStackData {
  storage: string;
  label: string;
  offset: number;
  orgLineStr: string;
  lineBuffer: string;
  pos: number;
  lineBufferUsing: boolean;
  macroArgStackBase: number;
  macroArgStackDepth: number;
  excludeLevelStack: number[];
  ifLevelExecutedStack: boolean[];
  excludeLevel: number;
  ifLevel: number;
}

const copyCallStackData = (d: CallStackData): CallStackData => ({
  ...d,
  excludeLevelStack: [...d.excludeLevelStack],
  ifLevelExecutedStack: [...d.ifLevelExecutedStack],
});

const HEX = '0123456789abcdef';

function intStackString(stack: readonly number[]): string {
  let s = '';
  for (const v of stack) for (let sh = 28; sh >= 0; sh -= 4) s += HEX[(v >> sh) & 0xf];
  return s;
}

/** `RestoreIntStackFromStr`: window `i` starts at character `i`. */
function intStackFromString(s: string): number[] {
  const stack: number[] = [];
  const len = Math.trunc(s.length / 8);
  const d = (c: number) => (c <= 0x39 ? c - 0x30 : c - 0x61 + 10);
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v |= d(s.charCodeAt(i + k)) << (28 - k * 4);
    stack.push(v | 0);
  }
  return stack;
}

const boolStackString = (stack: readonly boolean[]) => stack.map((b) => (b ? '1' : '0')).join('');
const boolStackFromString = (s: string) => Array.from(s, (c) => c === '1');

export class KagParserInstance implements NativeInstance {
  readonly #k: KagContext;
  readonly #ex: TvpFunctionExporter;
  owner: Dispatch | null = null;

  readonly #args: ArgValue;
  readonly macros: Dispatch;
  readonly paramMacros: Dispatch;
  #macroArgs: ArgValue[] = [];
  #macroArgStackDepth = 0;
  #macroArgStackBase = 0;
  #callStack: CallStackData[] = [];

  /** `Scenario` and `Lines`. */
  #scenario: ScenarioItem | null = null;
  #lineCount = 0;
  storageName = '';
  #storageShortName = '';

  curLine = 0;
  curPos = 0;
  /** `CurLineStr`: `#cur` from `#curBase`, NUL-terminated (null as the empty string). */
  #cur = '';
  #curBase = 0;
  #lineBuffer = '';
  #lineBufferUsing = false;
  curLabel = '';
  #curPage = '';
  #tagLine = 0;

  debugLevel = TKDL_SIMPLE;
  processSpecialTags = true;
  ignoreCR = false;
  #recordingMacro = false;
  #recordingMacroStr = '';
  #recordingMacroName = '';

  readonly #valueVariant = new VariantSlot();

  #excludeLevel = -1;
  #ifLevel = 0;
  #excludeLevelStack: number[] = [];
  #ifLevelExecutedStack: boolean[] = [];

  #interrupted = false;
  multiLineTagEnabled = false;

  constructor(k: KagContext) {
    this.#k = k;
    this.#ex = k.ex;
    this.#args = new ArgValue(k);
    this.macros = k.ex.TJSCreateDictionaryObject();
    this.paramMacros = k.ex.TJSCreateDictionaryObject();
  }

  construct(_args: readonly Variant[], owner: Dispatch): number {
    this.owner = owner;
    return TJS_S_OK;
  }

  invalidate(): void {
    this.macros.release();
    this.paramMacros.release();
    this.#clearMacroArgs();
    this.#clearBuffer();
    this.owner = null;
  }

  destruct(): void {
    this.#args.release();
    this.#valueVariant.clear();
  }

  // --- Helpers -------------------------------------------------------------------------------

  #msg(name: string): string {
    return this.#ex.TJSGetMessageMapMessage(name);
  }
  #throw(name: string, ...params: string[]): never {
    return this.#ex.TVPThrowExceptionMessage(this.#msg(name), ...params);
  }
  #syntaxError(): never {
    return this.#throw('TVPKAGSyntaxError');
  }
  #internalError(line: number): never {
    return this.#ex.TVPThrowExceptionMessage(
      this.#msg('TVPInternalError'),
      SOURCE_FILE,
      String(line),
    );
  }
  #log(message: string): void {
    this.#ex.TVPAddLog(message);
  }
  /** The scenario a native call dereferences without a check. */
  #requireScenario(): ScenarioItem {
    if (!this.#scenario) this.#throw('TJSNullAccess');
    return this.#scenario;
  }

  /** `CurLineStr[i]`. */
  #c(i: number): number {
    const c = this.#cur.charCodeAt(this.#curBase + i);
    return c >= 0 ? c : 0;
  }
  /** `ttstr(CurLineStr + from, to - from)`. */
  #slice(from: number, to: number): string {
    return this.#cur.slice(this.#curBase + from, this.#curBase + to);
  }
  /** `ttstr(CurLineStr + from)`. */
  #rest(from: number): string {
    const s = this.#curBase + from;
    const e = this.#cur.indexOf('\0', s);
    return this.#cur.slice(s, e < 0 ? undefined : e);
  }
  /** `CurLineStr = Lines[line].Start`. */
  #setLine(line: number): void {
    const sc = this.#scenario!;
    this.#cur = sc.buffer;
    this.#curBase = sc.lineStart(line);
  }
  /** `LineBuffer = s; CurLineStr = LineBuffer.c_str()`. */
  #setLineBuffer(s: string): void {
    this.#lineBuffer = s;
    this.#cur = s;
    this.#curBase = 0;
  }

  get curLineStr(): string {
    return this.#rest(0);
  }
  get callStackDepth(): number {
    return this.#callStack.length;
  }

  // --- State ---------------------------------------------------------------------------------

  /** `operator=` (`assign`). */
  assignFrom(ref: KagParserInstance): void {
    const k = this.#k;
    k.dicAssign.funcCall(0, null, null, [obj(ref.macros, ref.macros)], this.macros);
    k.dicAssign.funcCall(0, null, null, [obj(ref.paramMacros, ref.paramMacros)], this.paramMacros);

    const src = ref.#macroArgs;
    const n = Math.min(this.#macroArgs.length, src.length);
    for (let i = 0; i < n; i++) this.#macroArgs[i]!.assign(src[i]!);
    for (let i = n; i < src.length; i++) this.#macroArgs.push(ArgValue.copy(k, src[i]!));
    for (const a of this.#macroArgs.splice(src.length)) a.release();
    this.#macroArgStackDepth = ref.#macroArgStackDepth;
    this.#macroArgStackBase = ref.#macroArgStackBase;

    this.#callStack = ref.#callStack.map(copyCallStackData);

    this.storageName = ref.storageName;
    this.#storageShortName = ref.#storageShortName;

    if (this.#scenario !== ref.#scenario) {
      if (this.#scenario) {
        this.#scenario = null;
        this.#cur = '';
        this.#curBase = 0;
      }
      this.#scenario = ref.#scenario;
      this.#lineCount = ref.#lineCount;
    }

    this.curLine = ref.curLine;
    this.curPos = ref.curPos;

    this.#cur = ref.#cur;
    this.#curBase = ref.#curBase;
    this.#lineBuffer = ref.#lineBuffer;
    this.#lineBufferUsing = ref.#lineBufferUsing;

    this.curLabel = ref.curLabel;
    this.#curPage = ref.#curPage;
    this.#tagLine = ref.#tagLine;

    this.debugLevel = ref.debugLevel;
    this.ignoreCR = ref.ignoreCR;

    this.#recordingMacro = ref.#recordingMacro;
    this.#recordingMacroStr = ref.#recordingMacroStr;
    this.#recordingMacroName = ref.#recordingMacroName;

    this.#excludeLevel = ref.#excludeLevel;
    this.#ifLevel = ref.#ifLevel;
    this.#excludeLevelStack = [...ref.#excludeLevelStack];
    this.#ifLevelExecutedStack = [...ref.#ifLevelExecutedStack];
  }

  /** `Store`: a new dictionary, owned by the caller. */
  store(): Dispatch {
    const ex = this.#ex;
    const k = this.#k;
    const dic = ex.TJSCreateDictionaryObject();
    const set = (target: Dispatch, name: string, v: Variant) =>
      target.propSet(TJS_MEMBERENSURE, name, v, target);
    /** A new object stored in `dic` (which keeps the only reference). */
    const member = (name: string, created: Dispatch) => {
      set(dic, name, obj(created, created));
      created.release();
      return created;
    };
    try {
      const macros = member('macros', ex.TJSCreateDictionaryObject());
      k.dicAssign.funcCall(0, null, null, [obj(this.macros, this.macros)], macros);

      const paramMacros = member('paramMacros', ex.TJSCreateDictionaryObject());
      k.dicAssign.funcCall(0, null, null, [obj(this.paramMacros, this.paramMacros)], paramMacros);

      const macroArgs = member('macroArgs', ex.TJSCreateArrayObject());
      for (let i = 0; i < this.#macroArgStackDepth; i++) {
        const a = this.#macroArgs[i]!.getArray();
        macroArgs.propSetByNum(TJS_MEMBERENSURE, i, obj(a, a), macroArgs);
        a.release();
      }

      const callStack = member('callStack', ex.TJSCreateArrayObject());
      this.#callStack.forEach((d, i) => {
        const e = ex.TJSCreateDictionaryObject();
        callStack.propSetByNum(TJS_MEMBERENSURE, i, obj(e, e), callStack);
        e.release();
        set(e, 'storage', str(d.storage));
        set(e, 'label', str(d.label));
        set(e, 'offset', int(d.offset));
        set(e, 'orgLineStr', str(d.orgLineStr));
        set(e, 'lineBuffer', str(d.lineBuffer));
        set(e, 'pos', int(d.pos));
        set(e, 'lineBufferUsing', int(d.lineBufferUsing ? 1 : 0));
        set(e, 'macroArgStackBase', int(d.macroArgStackBase));
        set(e, 'macroArgStackDepth', int(d.macroArgStackDepth));
        set(e, 'ExcludeLevel', int(d.excludeLevel));
        set(e, 'IfLevel', int(d.ifLevel));
        set(e, 'ExcludeLevelStack', str(intStackString(d.excludeLevelStack)));
        set(e, 'IfLevelExecutedStack', str(boolStackString(d.ifLevelExecutedStack)));
      });

      set(dic, 'storageName', str(this.storageName));
      set(dic, 'storageShortName', str(this.#storageShortName));
      set(dic, 'curLine', int(this.curLine));
      set(dic, 'curPos', int(this.curPos));
      set(dic, 'lineBuffer', str(this.#lineBuffer));
      set(dic, 'lineBufferUsing', int(this.#lineBufferUsing ? 1 : 0));
      set(dic, 'curLabel', str(this.curLabel));
      set(dic, 'ExcludeLevel', int(this.#excludeLevel));
      set(dic, 'IfLevel', int(this.#ifLevel));
      set(dic, 'ExcludeLevelStack', str(intStackString(this.#excludeLevelStack)));
      set(dic, 'IfLevelExecutedStack', str(boolStackString(this.#ifLevelExecutedStack)));
      set(dic, 'macroArgStackBase', int(this.#macroArgStackBase));
      set(dic, 'macroArgStackDepth', int(this.#macroArgStackDepth));
    } catch (e) {
      dic.release();
      throw e;
    }
    return dic;
  }

  /** `Restore`. */
  *restore(dic: Dispatch): PluginRoutine<void> {
    const k = this.#k;
    const val = new VariantSlot();
    const get = (name: string) => {
      val.clear();
      dic.propGet(0, name, val, dic);
      return val.value;
    };

    if (get('macros').type !== 0) k.dicAssign.funcCall(0, null, null, [val.value], this.macros);
    if (get('paramMacros').type !== 0)
      k.dicAssign.funcCall(0, null, null, [val.value], this.paramMacros);

    // macro arguments
    this.#macroArgStackDepth = 0;
    const macroArgs = get('macroArgs');
    if (macroArgs.type !== 0) {
      const array = new VariantSlot(macroArgs);
      const v = new VariantSlot();
      closureGet(array.value, 'count', v);
      const count = asInt32(v.value);
      this.#clearMacroArgs();
      if (get('macroArgStackDepth').type !== 0) this.#macroArgStackDepth = asInt32(val.value);
      for (let i = 0; i < count; i++) {
        closureGet(array.value, i, v);
        this.#macroArgs.push(ArgValue.fromSaveArray(k, v.value));
      }
      v.clear();
      array.clear();
    }
    if (this.#macroArgStackDepth !== this.#macroArgs.length) this.#throw('TVPKAGMalformedSaveData');
    this.#macroArgStackBase = this.#macroArgs.length;

    // call stack
    const callStack = get('callStack');
    if (callStack.type !== 0) {
      const array = new VariantSlot(callStack);
      const v = new VariantSlot();
      closureGet(array.value, 'count', v);
      const count = asInt32(v.value);
      this.#callStack = [];
      for (let i = 0; i < count; i++) {
        const f = new VariantSlot();
        closureGet(array.value, i, v);
        const entry = v.value;
        const field = (name: string) => {
          closureGet(entry, name, f);
          return f.value;
        };
        const storage = ttstr(field('storage'));
        const label = ttstr(field('label'));
        const offset = asInt32(field('offset'));
        const orgLineStr = ttstr(field('orgLineStr'));
        const lineBuffer = ttstr(field('lineBuffer'));
        const pos = asInt32(field('pos'));
        const lineBufferUsing = asBoolean(field('lineBufferUsing'));
        const macroArgStackBase = asInt32(field('macroArgStackBase'));
        const macroArgStackDepth = asInt32(field('macroArgStackDepth'));
        const excludeLevel = asInt32(field('ExcludeLevel'));
        const ifLevel = asInt32(field('IfLevel'));
        const excludeLevelStack = intStackFromString(ttstr(field('ExcludeLevelStack')));
        const ifLevelExecutedStack = boolStackFromString(ttstr(field('IfLevelExecutedStack')));
        f.clear();
        this.#callStack.push({
          storage,
          label,
          offset,
          orgLineStr,
          lineBuffer,
          pos,
          lineBufferUsing,
          macroArgStackBase,
          macroArgStackDepth,
          excludeLevelStack,
          ifLevelExecutedStack,
          excludeLevel,
          ifLevel,
        });
      }
      v.clear();
      array.clear();
    }

    if (get('storageName').type !== 0) this.storageName = ttstr(val.value);
    if (get('storageShortName').type !== 0) this.#storageShortName = ttstr(val.value);
    if (get('curLabel').type !== 0) this.curLabel = ttstr(val.value);
    val.clear();

    // load the scenario
    const storage = this.storageName;
    const label = this.curLabel;
    this.#clearBuffer(); // ensure re-loading the scenario
    yield* this.loadScenario(storage);
    this.goToLabel(label);

    if (get('ExcludeLevel').type !== 0) this.#excludeLevel = asInt32(val.value);
    if (get('IfLevel').type !== 0) this.#ifLevel = asInt32(val.value);
    if (get('ExcludeLevelStack').type !== 0)
      this.#excludeLevelStack = intStackFromString(ttstr(val.value));
    if (get('IfLevelExecutedStack').type !== 0)
      this.#ifLevelExecutedStack = boolStackFromString(ttstr(val.value));
    if (get('macroArgStackBase').type !== 0) this.#macroArgStackBase = asInt32(val.value);
    val.clear();
  }

  /** `LoadScenario`. */
  *loadScenario(name: string): PluginRoutine<void> {
    this.#breakConditionAndMacro();
    if (this.storageName === name) {
      // avoid re-loading
      this.#rewind();
    } else {
      this.#clearBuffer();
      // fire onScenarioLoad
      const owner = this.owner;
      const result = new VariantSlot();
      const status = owner
        ? yield () => owner.funcCall(0, 'onScenarioLoad', result, [str(name)], owner)
        : -1;
      const scenario =
        status === TJS_S_OK && result.value.type === 2
          ? yield* this.#k.getScenario(result.value.value, true)
          : yield* this.#k.getScenario(name, false);
      result.clear();
      this.#scenario = scenario;
      this.#lineCount = scenario.lineCount;
      this.#rewind();
      this.storageName = name;
      this.#storageShortName = this.#ex.TVPExtractStorageName(name);
      if (this.debugLevel >= TKDL_SIMPLE) {
        this.#log(HR);
        this.#log('Scenario loaded : ' + name);
      }
    }
    const owner = this.owner;
    if (owner) {
      const storageName = this.storageName;
      yield () => owner.funcCall(0, 'onScenarioLoaded', null, [str(storageName)], owner);
    }
  }

  /** `Clear`. */
  clear(): void {
    this.#k.cache.clear(); // also invalidates the scenario cache
    this.#clearBuffer();
    this.#clearMacroArgs();
    this.clearCallStack();
  }

  #clearBuffer(): void {
    if (this.#scenario) {
      this.#scenario = null;
      this.#cur = '';
      this.#curBase = 0;
    }
    this.storageName = '';
    this.#storageShortName = '';
    this.#breakConditionAndMacro();
  }

  #rewind(): void {
    this.curLine = 0;
    this.curPos = 0;
    this.#setLine(0);
    this.#lineBufferUsing = false;
    this.#breakConditionAndMacro();
  }

  #breakConditionAndMacro(): void {
    this.#recordingMacro = false;
    this.#excludeLevel = -1;
    this.#excludeLevelStack = [];
    this.#ifLevelExecutedStack = [];
    this.#ifLevel = 0;
    // macro arguments down to the current base
    this.#macroArgStackDepth = this.#macroArgStackBase;
  }

  /** `GoToLabel`: `name` starts with `*`. */
  goToLabel(name: string): void {
    if (name === '') return;
    const sc = this.#requireScenario();
    sc.ensureLabelCache(this.#ex);
    const data = sc.labelCache.get(name);
    if (data) {
      const line = sc.line(data.line);
      const vl = line.indexOf('|');
      this.curLabel = sc.labelAlias(data.line);
      this.#curPage = vl >= 0 ? line.slice(vl + 1) : '';
      this.curLine = data.line;
      this.curPos = 0;
      this.#lineBufferUsing = false;
    } else {
      this.#throw('TVPKAGLabelNotFound', this.storageName, name);
    }
    if (this.debugLevel >= TKDL_SIMPLE) {
      this.#log(HR_JUMP);
      this.#log(this.#storageShortName + ' : jumped to : ' + name);
    }
    this.#breakConditionAndMacro();
  }

  *#goToStorageAndLabel(storage: string, label: string): PluginRoutine<void> {
    if (storage !== '') yield* this.loadScenario(storage);
    if (label !== '') this.goToLabel(label);
  }

  /** `CallLabel`. */
  callLabel(name: string): void {
    this.#pushCallStack();
    this.goToLabel(name);
  }

  /**
   * `SkipCommentOrLabel`: skips comments and labels (firing `onLabel`) and inline scripts
   * (firing `onScript`) to the next line to parse.
   */
  *#skipCommentOrLabel(): PluginRoutine<boolean> {
    this.#requireScenario().ensureLabelCache(this.#ex);
    this.curPos = 0;
    if (this.curLine >= this.#lineCount) return false;
    for (; this.curLine < this.#lineCount; this.curLine++) {
      // the callbacks may clear the scenario
      const sc = this.#scenario;
      if (!sc) return false;
      const p = sc.line(this.curLine);

      if (p[0] === ';') continue; // comment

      if (p[0] === '*') {
        // label
        if (this.#recordingMacro) this.#throw('TVPLabelOrScriptInMacro');
        const vl = p.indexOf('|');
        this.curLabel = sc.labelAlias(this.curLine);
        this.#curPage = vl >= 0 ? p.slice(vl + 1) : '';
        const owner = this.owner;
        if (owner) {
          const args = [str(this.curLabel), vl >= 0 ? str(this.#curPage) : VOID];
          yield () => owner.funcCall(0, 'onLabel', null, args, owner);
        }
        continue;
      }

      if (
        (p[0] === '[' && (p === '[iscript]' || p === '[iscript]\\')) ||
        (p[0] === '@' && p === '@iscript')
      ) {
        // inline TJS script
        if (this.#recordingMacro) this.#throw('TVPLabelOrScriptInMacro');
        let script = '';
        this.curLine++;
        const scriptStart = this.curLine;
        for (; this.curLine < this.#lineCount; this.curLine++) {
          const q = sc.line(this.curLine);
          if (q === '[endscript]' || q === '[endscript]\\' || q === '@endscript') break;
          if (this.#excludeLevel === -1) script += q + '\r\n';
        }
        if (this.curLine === this.#lineCount) this.#throw('TVPKAGInlineScriptNotEnd');
        const owner = this.owner;
        if (this.#excludeLevel === -1 && owner) {
          const args = [str(script), str(this.#storageShortName), int(scriptStart)];
          yield () => owner.funcCall(0, 'onScript', null, args, owner);
        }
        continue;
      }
      break;
    }
    if (this.curLine >= this.#lineCount) return false;
    this.#setLine(this.curLine);
    this.#lineBufferUsing = false;
    if (this.debugLevel >= TKDL_VERBOSE)
      this.#log(this.#storageShortName + ' : ' + this.curLineStr);
    return true;
  }

  // --- Macro arguments and the call stack ----------------------------------------------------

  #pushMacroArgs(value: ArgValue): void {
    if (this.#macroArgs.length > this.#macroArgStackDepth) {
      this.#macroArgs[this.#macroArgStackDepth]!.assign(value);
    } else {
      if (this.#macroArgStackDepth > this.#macroArgs.length) this.#internalError(1376);
      this.#macroArgs.push(ArgValue.copy(this.#k, value));
    }
    this.#macroArgStackDepth++;
  }

  /** `PopMacroArgs`. */
  popMacroArgs(): void {
    if (this.#macroArgStackDepth === 0) this.#syntaxError();
    this.#macroArgStackDepth--;
  }

  #clearMacroArgs(): void {
    for (const a of this.#macroArgs) a.release();
    this.#macroArgs = [];
    this.#macroArgStackDepth = 0;
  }

  /** `GetMacroTopNoAddRef`. */
  macroTop(): Dispatch | null {
    if (this.#macroArgStackDepth === 0) return null;
    return this.#macroArgs[this.#macroArgStackDepth - 1]!.dic;
  }

  /** `FindNearestLabel`: the last label line before `start` (-1 and '' when none). */
  #findNearestLabel(start: number): [number, string] {
    const sc = this.#requireScenario();
    sc.ensureLabelCache(this.#ex);
    let labelname = '';
    start--;
    while (start >= 0) {
      if (sc.buffer.charCodeAt(sc.lineStart(start)) === STAR) {
        labelname = sc.labelAlias(start);
        break;
      }
      start--;
    }
    return [start, start === -1 ? '' : labelname];
  }

  #pushCallStack(): void {
    if (this.debugLevel >= TKDL_VERBOSE)
      this.#log(
        this.#storageShortName +
          ' : call stack depth before calling : ' +
          String(this.#callStack.length),
      );
    let [labelline, labelname] = this.#findNearestLabel(this.curLine);
    if (labelline < 0) labelline = 0;
    const content =
      this.#scenario && this.curLine < this.#lineCount ? this.#scenario.line(this.curLine) : '';
    this.#callStack.push({
      storage: this.storageName,
      label: labelname,
      offset: this.curLine - labelline,
      orgLineStr: content,
      lineBuffer: this.#lineBuffer,
      pos: this.curPos,
      lineBufferUsing: this.#lineBufferUsing,
      macroArgStackBase: this.#macroArgStackBase,
      macroArgStackDepth: this.#macroArgStackDepth,
      excludeLevelStack: [...this.#excludeLevelStack],
      ifLevelExecutedStack: [...this.#ifLevelExecutedStack],
      excludeLevel: this.#excludeLevel,
      ifLevel: this.#ifLevel,
    });
    this.#macroArgStackBase = this.#macroArgStackDepth;
  }

  *#popCallStack(storage: string, label: string): PluginRoutine<void> {
    if (this.#callStack.length === 0) this.#throw('TVPKAGCallStackUnderflow');
    const data = this.#callStack[this.#callStack.length - 1]!;
    this.#macroArgStackBase = data.macroArgStackDepth; // later reset to MacroArgStackBase
    this.#macroArgStackDepth = data.macroArgStackDepth;

    if (storage !== '' || label !== '') {
      // return to the given position
      yield* this.#goToStorageAndLabel(storage, label);
    } else {
      // return to the calling position
      yield* this.loadScenario(data.storage);
      if (data.label !== '') this.goToLabel(data.label);
      this.curLine += data.offset;
      if (this.curLine > this.#lineCount) this.#throw('TVPKAGReturnLostSync');
      // CurLine == LineCount is the end of the file
      if (this.curLine < this.#lineCount && data.orgLineStr !== this.#scenario!.line(this.curLine))
        this.#throw('TVPKAGReturnLostSync');
      if (data.lineBufferUsing) {
        this.#setLineBuffer(data.lineBuffer);
        this.#lineBufferUsing = true;
      } else if (this.curLine < this.#lineCount) {
        this.#setLine(this.curLine);
        this.#lineBufferUsing = false;
      }
      this.curPos = data.pos;
      this.#excludeLevelStack = [...data.excludeLevelStack];
      this.#excludeLevel = data.excludeLevel;
      this.#ifLevelExecutedStack = [...data.ifLevelExecutedStack];
      this.#ifLevel = data.ifLevel;
      if (this.debugLevel >= TKDL_SIMPLE) {
        const l = data.label === '' ? '(start)' : data.label;
        this.#log(
          this.#storageShortName + ' : returned to : ' + l + ' line offset ' + String(data.offset),
        );
      }
    }
    this.#macroArgStackBase = data.macroArgStackBase;
    this.#callStack.pop();

    const owner = this.owner;
    if (owner) yield () => owner.funcCall(0, 'onAfterReturn', null, [], owner);

    if (this.debugLevel >= TKDL_VERBOSE)
      this.#log(
        this.#storageShortName +
          ' : call stack depth after returning : ' +
          String(this.#callStack.length),
      );
  }

  /** `ClearCallStack`: macro arguments are cleared too. */
  clearCallStack(): void {
    this.#callStack = [];
    this.#macroArgStackBase = 0;
    this.#macroArgStackDepth = 0;
  }

  interrupt(): void {
    this.#interrupted = true;
  }
  resetInterrupt(): void {
    this.#interrupted = false;
  }

  // --- Tags ----------------------------------------------------------------------------------

  /**
   * `EntryParam`: the value of one attribute into `vv` (entity, macro argument or literal);
   * `cond` sets the condition. Returns whether the attribute is stored. An attribute named
   * after a parameter macro stores the macro's attributes instead.
   */
  #entryParam(
    condition: {value: boolean},
    vv: VariantSlot,
    attribname: string,
    value: string,
    entity: boolean,
    macroarg: boolean,
  ): boolean {
    const ex = this.#ex;
    const pm = new VariantSlot();
    if (
      !failed(this.paramMacros.propGet(0, attribname, pm, this.paramMacros)) &&
      pm.value.type === 1
    ) {
      const clo = pm.value;
      const v = new VariantSlot();
      closureGet(clo, 'count', v);
      const count = asInt32(v.value);
      for (let i = 0; i < count; i += 2) {
        let e = false;
        let m = false;
        const nVar = new VariantSlot();
        const pVar = new VariantSlot();
        closureGet(clo, i, nVar);
        closureGet(clo, i + 1, pVar);
        const name = ttstr(nVar.value);
        let param = ttstr(pVar.value);
        nVar.clear();
        pVar.clear();
        if (param[0] === '&') {
          e = true;
          param = param.slice(1);
        } else if (param[0] === '%') {
          m = true;
          param = param.slice(1);
        }
        if (this.#entryParam(condition, v, name, param, e, m)) this.#args.add(name, v.value);
      }
      v.clear();
      pm.clear();
      return false;
    }
    pm.clear();

    // expression entity or macro argument
    if (entity) {
      ex.TVPExecuteExpression(value, this.owner, vv);
      if (vv.value.type !== 0) vv.set(str(asString(vv.value)));
    } else if (macroarg) {
      const args = this.macroTop();
      if (args) {
        const vp = value.indexOf('|');
        if (vp >= 0) {
          args.propGet(0, value.slice(0, vp), vv, args);
          if (vv.value.type === 0) vv.set(str(value.slice(vp + 1)));
        } else {
          args.propGet(0, value, vv, args);
        }
      } else {
        vv.set(str(value));
      }
    } else {
      vv.set(str(value));
    }

    if (attribname === 'cond') {
      const val = new VariantSlot();
      ex.TVPExecuteExpression(ttstr(vv.value), this.owner, val);
      condition.value = asBoolean(val.value);
      val.clear();
      return false;
    }
    return true;
  }

  /** Evaluates the `exp` attribute (`[if]`, `[elsif]`, `[emb]`). */
  #exp<T>(convert: (v: Variant) => T): T {
    const val = new VariantSlot();
    this.#args.getProp('exp', val);
    const exp = ttstr(val.value);
    if (exp === '') this.#syntaxError();
    this.#ex.TVPExecuteExpression(exp, this.owner, val);
    const v = convert(val.value);
    val.clear();
    return v;
  }

  /** Fires `onJump`/`onCall`/`onReturn`; true when the parser processes the tag. */
  *#fire(event: string): PluginRoutine<boolean> {
    const owner = this.owner;
    if (!owner) return true;
    const res = new VariantSlot();
    const dic = this.#args.dic;
    const er = yield () => owner.funcCall(0, event, res, [obj(dic, dic)], owner);
    const process = er === TJS_S_OK ? asBoolean(res.value) : true;
    res.clear();
    return process;
  }

  /**
   * `GetNextTag`: the next tag as the parser's tag dictionary (with a reference for the
   * caller), or null at the end. Characters are `ch` tags, line ends `r` tags.
   */
  *getNextTag(): PluginRoutine<Dispatch | null> {
    const ex = this.#ex;
    const args = this.#args;
    parse: for (;;) {
      if (this.curLine >= this.#lineCount) return null;
      if (!this.#scenario) return null;

      tokens: for (;;) {
        args.clear();

        if (this.#interrupted) {
          // returned as an "interrupt" tag
          args.add('tagname', str('interrupt'));
          this.#interrupted = false;
          return args.getReturn();
        }

        if (this.curLine >= this.#lineCount) break; // the whole scenario was decoded

        const tagstartpos = this.curPos;

        if (!this.#lineBufferUsing && this.curPos === 0)
          if (!(yield* this.#skipCommentOrLabel())) return null;

        if (!this.ignoreCR) {
          const pos = this.curPos;
          if (
            (this.#c(pos) === BACKSLASH && this.#c(pos + 1) === 0) ||
            (this.#c(pos) === 0 &&
              pos >= 3 &&
              this.#c(pos - 3) === LBRACKET &&
              this.#c(pos - 2) === P && // for a line ending with [p]
              this.#c(pos - 1) === RBRACKET)
          ) {
            // line ended with '\'
            this.curLine++;
            this.curPos = 0;
            this.#lineBufferUsing = false;
            continue;
          }
          if (this.#c(pos) === 0) {
            // line ended
            this.#tagLine = this.curLine;
            args.add('tagname', str('r'));
            args.add('eol', str('true'));
            if (this.#recordingMacro) this.#recordingMacroStr += '[r eol=true]';
            this.curLine++;
            this.curPos = 0;
            this.#lineBufferUsing = false;
            if (!this.#recordingMacro && this.#excludeLevel === -1) return args.getReturn();
            continue;
          }
        }

        let ldelim: number; // the tag's last delimiter
        if (!this.#lineBufferUsing && this.curPos === 0 && this.#c(0) === AT) {
          // line command mode: the tag ends at the line's NUL
          ldelim = 0;
        } else {
          if (this.#c(this.curPos) !== LBRACKET || this.#c(this.curPos + 1) === LBRACKET) {
            // normal character
            const ch = this.#c(this.curPos);
            this.#tagLine = this.curLine;
            if (ch === 0) {
              // line ended
              this.curLine++;
              this.curPos = 0;
              this.#lineBufferUsing = false;
              continue;
            } else if (ch === TAB) {
              this.curPos++;
              continue;
            } else if (ch !== LF) {
              args.add('tagname', str('ch'));
              args.add('text', str(String.fromCharCode(ch)));
              if (this.#recordingMacro)
                this.#recordingMacroStr += ch === LBRACKET ? '[[' : String.fromCharCode(ch);
            } else {
              // \n (reline)
              args.add('tagname', str('r'));
              if (this.#recordingMacro) this.#recordingMacroStr += '[r]';
            }
            if (this.#c(this.curPos) === LBRACKET) this.curPos++;
            this.curPos++;
            if (!this.#recordingMacro && this.#excludeLevel === -1) return args.getReturn();
            continue;
          }
          ldelim = RBRACKET;
        }

        // a tag
        const condition = {value: true};
        this.#tagLine = this.curLine;
        const tagstart = this.curPos;
        this.curPos++;
        if (this.#c(this.curPos) === 0) this.#syntaxError();

        // tag name
        while (isWS(this.#c(this.curPos))) this.curPos++;
        if (this.#c(this.curPos) === 0) this.#syntaxError();
        const tagnamestart = this.curPos;
        while (
          this.#c(this.curPos) &&
          !isWS(this.#c(this.curPos)) &&
          this.#c(this.curPos) !== ldelim
        )
          this.curPos++;
        if (tagnamestart === this.curPos) this.#syntaxError();
        const tagname = toLowerCase(this.#slice(tagnamestart, this.curPos));
        args.add('tagname', str(tagname));

        const tagkind = this.processSpecialTags
          ? (SPECIAL_TAGS.get(tagname) ?? Tag.Other)
          : Tag.Other;
        if (tagkind === Tag.Macro) this.#recordingMacroName = '';

        let multiLine = this.curLine;
        /** `TVP_KAG_STEP_NEXT`. */
        const stepNext = () => {
          if (multiLine > this.curLine) {
            if (this.debugLevel >= TKDL_SIMPLE && ldelim !== 0 && this.#c(this.curPos + 1) !== 0)
              this.#log(
                this.#storageShortName +
                  ' : ignore after multi-line tag : ' +
                  this.#rest(this.curPos + 1),
              );
            this.curLine = multiLine + 1;
            this.curPos = 0;
            this.#lineBufferUsing = false;
          } else if (ldelim === 0) {
            this.curLine++;
            this.curPos = 0;
            this.#lineBufferUsing = false;
          } else {
            this.curPos++;
          }
        };

        // tag attributes
        for (;;) {
          while (isWS(this.#c(this.curPos))) this.curPos++;

          if (this.#c(this.curPos) === ldelim) {
            // tag ended
            let ismacro = false;
            let macrocontent = '';

            if (condition.value && this.#excludeLevel === -1) {
              if (tagkind === Tag.Endmacro) {
                // macro recording ended
                if (!this.#recordingMacro) this.#syntaxError();
                this.#recordingMacro = false;
                if (this.debugLevel >= TKDL_VERBOSE)
                  this.#log(
                    'macro : ' + this.#recordingMacroName + ' : ' + this.#recordingMacroStr,
                  );
                this.#recordingMacroStr += '[macropop]'; // macro arguments are to be popped
                this.macros.propSet(
                  TJS_MEMBERENSURE,
                  this.#recordingMacroName,
                  str(this.#recordingMacroStr),
                  this.macros,
                );
              }

              if (this.#recordingMacro) {
                if (ldelim !== 0) {
                  // normal tag
                  this.#recordingMacroStr += this.#slice(tagstart, this.curPos + 1);
                } else if (this.curPos - tagstart >= 1) {
                  // line command
                  this.#recordingMacroStr += '[' + this.#slice(tagstart + 1, this.curPos) + ']';
                }
                stepNext();
                continue tokens;
              }

              const macroval = new VariantSlot();
              ismacro = !failed(this.macros.propGet(0, tagname, macroval, this.macros));
              if (ismacro) ismacro = macroval.value.type !== 0;
              if (ismacro) macrocontent = ttstr(macroval.value);
              macroval.clear();
            }

            if (tagkind === Tag.Other && !ismacro) {
              // not a control tag
              stepNext();
              if (condition.value && this.#excludeLevel === -1) return args.getReturn();
              continue tokens;
            }

            // if/ignore
            if (tagkind === Tag.If || tagkind === Tag.Ignore) {
              this.#ifLevel++;
              this.#ifLevelExecutedStack.push(false);
              this.#excludeLevelStack.push(this.#excludeLevel);
              if (this.#excludeLevel === -1) {
                let cond = this.#exp(asBoolean);
                if (tagkind === Tag.Ignore) cond = !cond;
                this.#ifLevelExecutedStack[this.#ifLevelExecutedStack.length - 1] = cond;
                if (!cond) this.#excludeLevel = this.#ifLevel;
              }
            }

            // elsif
            if (tagkind === Tag.Elsif) {
              const executed = this.#ifLevelExecutedStack;
              if (executed.length === 0) {
                // no preceding if/ignore
              } else if (executed[executed.length - 1]) {
                this.#excludeLevel = this.#ifLevel;
              } else if (this.#ifLevel === this.#excludeLevel) {
                if (this.#exp(asBoolean)) {
                  executed[executed.length - 1] = true;
                  this.#excludeLevel = -1;
                }
              }
            }

            // else
            if (tagkind === Tag.Else) {
              const executed = this.#ifLevelExecutedStack;
              if (executed.length === 0) {
                // no preceding if/ignore
              } else if (executed[executed.length - 1]) {
                this.#excludeLevel = this.#ifLevel;
              } else if (this.#ifLevel === this.#excludeLevel) {
                executed[executed.length - 1] = true;
                this.#excludeLevel = -1;
              }
            }

            // endif/endignore
            if (tagkind === Tag.Endif || tagkind === Tag.Endignore) {
              if (this.#excludeLevelStack.length)
                this.#excludeLevel = this.#excludeLevelStack.pop()!;
              if (this.#ifLevelExecutedStack.length) this.#ifLevelExecutedStack.pop();
              this.#ifLevel--;
              if (this.#ifLevel < 0) this.#ifLevel = 0;
              stepNext();
              continue tokens;
            }

            if (condition.value && this.#excludeLevel === -1) {
              if (tagkind === Tag.Emb || (ismacro && tagkind === Tag.Other)) {
                // insert the text at the current position
                if (ldelim !== 0) this.curPos++;
                let content: string;
                if (!ismacro) {
                  content = '';
                  for (const c of this.#exp(ttstr)) content += c === '[' ? '[[' : c;
                } else {
                  content = macrocontent;
                }
                let newbuf = this.#slice(0, tagstartpos) + content + this.#rest(this.curPos);
                if (ldelim === 0 && !this.ignoreCR) newbuf += '\\';
                this.#setLineBuffer(newbuf);
                this.curPos = tagstartpos;
                this.#lineBufferUsing = true;
                if (ismacro) this.#pushMacroArgs(args);
                continue tokens;
              } else if (tagkind === Tag.Jump || tagkind === Tag.Call || tagkind === Tag.Return) {
                const val = new VariantSlot();
                args.getProp('storage', val);
                const storage = ttstr(val.value);
                args.getProp('target', val);
                const target = ttstr(val.value);
                val.clear();
                const event =
                  tagkind === Tag.Jump ? 'onJump' : tagkind === Tag.Call ? 'onCall' : 'onReturn';
                if (yield* this.#fire(event)) {
                  if (tagkind === Tag.Jump) {
                    yield* this.#goToStorageAndLabel(storage, target);
                  } else if (tagkind === Tag.Call) {
                    stepNext();
                    this.#pushCallStack();
                    yield* this.#goToStorageAndLabel(storage, target);
                  } else {
                    yield* this.#popCallStack(storage, target);
                  }
                  continue parse; // re-start parsing
                }
              } else if (tagkind === Tag.Macro) {
                const val = new VariantSlot();
                args.getProp('name', val);
                this.#recordingMacroName = toLowerCase(ttstr(val.value));
                val.clear();
                if (this.#recordingMacroName === '') this.#syntaxError(); // missing macro name
                this.#recordingMacro = true; // start recording
                this.#recordingMacroStr = '';
              } else if (tagkind === Tag.Macropop) {
                this.popMacroArgs();
              } else if (tagkind === Tag.Erasemacro || tagkind === Tag.Erasepmacro) {
                const val = new VariantSlot();
                args.getProp('name', val);
                const macroname = ttstr(val.value);
                val.clear();
                const dict = tagkind === Tag.Erasemacro ? this.macros : this.paramMacros;
                if (failed(dict.deleteMember(0, macroname, dict)))
                  this.#throw('TVPUnknownMacroName', macroname);
              } else if (tagkind === Tag.Pmacro) {
                const val = new VariantSlot();
                args.getProp('name', val);
                const macroname = ttstr(val.value);
                val.clear();
                const array = ex.TJSCreateArrayObject();
                args.extract((name, value) => {
                  const n = ttstr(name);
                  if (n !== 'name' && n !== 'tagname')
                    this.#k.arrayPush.funcCall(0, null, null, [name, value], array);
                });
                this.paramMacros.propSet(
                  TJS_MEMBERENSURE,
                  macroname,
                  obj(array, array),
                  this.paramMacros,
                );
                array.release();
              }
            }

            stepNext();
            continue tokens;
          }

          // a multi-line tag continues on the next line after ';'
          if (
            this.multiLineTagEnabled &&
            this.#c(this.curPos) === BACKSLASH &&
            this.#c(this.curPos + 1) === 0
          ) {
            if (++multiLine >= this.#lineCount) this.#syntaxError();
            const curlen = this.#rest(0).length - 1; // without '\'
            const next = this.#scenario!.line(multiLine);
            if (next[0] !== ';') this.#syntaxError();
            this.#setLineBuffer(this.#slice(0, curlen) + next.slice(1));
            this.#lineBufferUsing = true;
          }

          if (this.#c(this.curPos) === 0) this.#syntaxError();

          // attribute name
          if (this.#c(this.curPos) === STAR) {
            // all macro arguments
            if (!this.#recordingMacro && this.#macroArgStackDepth > 0) {
              this.#macroArgs[this.#macroArgStackDepth - 1]!.extract((name, value) => {
                const n = ttstr(name);
                if (n !== 'tagname') args.add(n, value);
              });
            }
            this.curPos++;
            while (this.#c(this.curPos) && isWS(this.#c(this.curPos))) this.curPos++;
            continue;
          }

          const attribnamestart = this.curPos;
          while (
            this.#c(this.curPos) &&
            !isWS(this.#c(this.curPos)) &&
            this.#c(this.curPos) !== EQ &&
            this.#c(this.curPos) !== ldelim
          )
            this.curPos++;
          const attribname = toLowerCase(this.#slice(attribnamestart, this.curPos));

          // =
          while (isWS(this.#c(this.curPos))) this.curPos++;

          let entity = false;
          let macroarg = false;
          let value: string;

          if (this.#c(this.curPos) !== EQ) {
            // attribute value omitted
            value = 'true';
          } else {
            this.curPos++;
            if (this.#c(this.curPos) === 0) this.#syntaxError();
            while (this.#c(this.curPos) && isWS(this.#c(this.curPos))) this.curPos++;
            if (this.#c(this.curPos) === 0) this.#syntaxError();

            // attribute value
            let vdelim = 0;
            if (this.#c(this.curPos) === AMP) {
              entity = true;
              this.curPos++;
            } else if (this.#c(this.curPos) === PERCENT) {
              macroarg = true;
              this.curPos++;
            }
            if (this.#c(this.curPos) === QUOTE || this.#c(this.curPos) === APOS) {
              vdelim = this.#c(this.curPos);
              this.curPos++;
            }

            const valuestart = this.curPos;
            for (;;) {
              const c = this.#c(this.curPos);
              if (!c || (vdelim ? c === vdelim : c === ldelim || isWS(c))) break;
              if (c === BACKTICK) {
                // escaped with '`'
                this.curPos++;
                if (this.#c(this.curPos) === 0) this.#syntaxError();
              }
              this.curPos++;
            }
            if (ldelim !== 0 && this.#c(this.curPos) === 0) this.#syntaxError();
            const valueend = this.curPos;
            if (vdelim) this.curPos++;

            // unescape '`'
            value = this.#slice(valuestart, valueend);
            if (valueend !== valuestart) {
              let i = 0;
              if (!entity && value[i] === '&') {
                entity = true;
                i++;
              }
              if (!macroarg && value[i] === '%') {
                macroarg = true;
                i++;
              }
              let out = '';
              for (; i < value.length; i++) {
                if (value[i] === '`') {
                  i++;
                  if (i >= value.length) break;
                }
                out += value[i];
              }
              value = out;
            }
          }

          // special attribute processing
          let store = true;
          if ((!this.#recordingMacro && this.#excludeLevel === -1) || tagkind === Tag.Elsif)
            store = this.#entryParam(
              condition,
              this.#valueVariant,
              attribname,
              value,
              entity,
              macroarg,
            );
          if (store) args.add(attribname, this.#valueVariant.value);
        }
      }
      return null;
    }
  }
}

/** The routine that `TVPGetScenario` runs: cached storages, text from `onScenarioLoad`. */
export function* getScenario(
  ex: TvpFunctionExporter,
  cache: ScenarioCache,
  name: string,
  isString: boolean,
): PluginRoutine<ScenarioItem> {
  if (isString) return ScenarioItem.load(ex, name, name);
  const found = cache.find(name);
  if (found) return found;
  const text = ex.TVPCreateTextStreamForRead(name, '');
  let loaded = typeof text === 'string' ? text : '';
  if (typeof text !== 'string')
    yield () =>
      ex.suspend(text, (s) => {
        loaded = s;
        return TJS_S_OK;
      });
  const item = ScenarioItem.load(ex, name, loaded);
  cache.add(name, item);
  return item;
}
