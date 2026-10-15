/**
 * `RegExp` (krkrz `tjsRegExp.cpp`) on Oniguruma patterns (`../oniguruma.ts`), as the reference
 * build implements it (0x4d1f30). Differences from later krkrz kept here:
 *
 * - A search runs on the target from `start` on, so its offsets are relative to `start`;
 *   `exec`/`test` and `match` apply them to the whole target (`matches`, `lastMatch`,
 *   `lastParen`) or add `start` once more (`lastIndex`, `leftContext`, `rightContext`). With
 *   `start` 0, the usual case, every value is exact.
 * - `index` is `start` plus the match position in bytes (twice the character offset), as in
 *   every krkrz build.
 *
 * Literals (`/re/gi`) compile through `_compile("//gi/re")`.
 */
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_FAIL,
  TJS_E_NATIVECLASSCRASH,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_S_OK,
  type Dispatch,
} from '../interface.js';
import {closureFuncCall} from '../dispatch.js';
import {constructNativeInstance, NativeClass, NativeInstanceBase} from '../native.js';
import {OnigRegex} from '../oniguruma.js';
import {VariantSlot} from '../slot.js';
import {withoutSuspension} from '../suspension.js';
import {
  asBoolean,
  asInteger,
  asString,
  bool,
  integer,
  obj,
  str,
  VOID,
  type Variant,
} from '../variant.js';
import type {ArrayObject} from './array.js';
import type {TjsEngine} from '../engine.js';

/** The TJS flag bit for `g`; `i` is Oniguruma's IGNORECASE. */
const GLOBAL_SEARCH = 0x80000000;
const IGNORE_CASE = 1;

/** `TJSGetRegExpFlagsFromString`: flag letters up to `/`; unknown letters are ignored. */
function flagsFromString(s: string): number {
  let flags = 0;
  for (const c of s) {
    if (c === '/') break;
    if (c === 'g') flags |= GLOBAL_SEARCH;
    else if (c === 'i') flags |= IGNORE_CASE;
  }
  return flags >>> 0;
}

/** Compiled patterns by flags and text; a literal compiles each time it is evaluated. */
const cache = new Map<string, OnigRegex>();
const CACHE_MAX = 256;

function compile(pattern: string, ignoreCase: boolean): OnigRegex {
  const key = (ignoreCase ? 'i' : '-') + pattern;
  let re = cache.get(key);
  if (re) {
    cache.delete(key);
  } else {
    re = new OnigRegex(pattern, ignoreCase);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, re);
  return re;
}

/** A search result: begin/end per region in UTF-16 units relative to the searched text. */
type Region = number[];

/** `tTJSNI_RegExp`. */
export class RegExpNI extends NativeInstanceBase {
  regex: OnigRegex | null = null;
  flags = 0;
  start = 0;
  readonly array = new VariantSlot();
  index = 0;
  input = '';
  lastIndex = 0;
  lastMatch = '';
  lastParen = '';
  leftContext = '';
  rightContext = '';

  constructor(private readonly engine: TjsEngine) {
    super();
  }

  override destruct(): void {
    this.array.clear();
  }

  #search(subject: string): Region | null {
    // A RegExp that was never compiled searches with a null regex_t natively.
    if (!this.regex) throw new Error('RegExp: search without a compiled pattern');
    return this.regex.search(subject);
  }

  /** `tTJSNC_RegExp::Compile`. */
  compile(args: readonly Variant[]): void {
    let expr = asString(args[0]!);
    const flags = args.length >= 2 ? flagsFromString(asString(args[1]!)) : 0;
    if (expr === '') expr = '(?:)';
    this.regex = compile(expr, (flags & IGNORE_CASE) !== 0);
    this.flags = flags;
  }

  /** `_compile("//flags/expression")`; false when the text is not in that form. */
  compileLiteral(expr: string): boolean {
    if (!expr.startsWith('//')) return false;
    const slash = expr.indexOf('/', 2);
    if (slash < 0) return false;
    const flags = flagsFromString(expr.slice(2));
    this.regex = compile(expr.slice(slash + 1), (flags & IGNORE_CASE) !== 0);
    this.flags = flags;
    return true;
  }

  /** `Match`: searches the target from `start`; nothing at or past its end. */
  match(target: string): Region | null {
    if (this.start >= target.length) return null;
    return this.#search(target.slice(this.start));
  }

  /** `GetResultArray`: each region's text, taken from the whole target. */
  resultArray(region: Region | null, target: string): ArrayObject {
    const array = this.engine.createArray();
    if (region)
      for (let i = 0; i < region.length; i += 2) {
        const beg = region[i]!,
          end = region[i + 1]!;
        const text = beg < 0 ? '' : target.slice(beg, end);
        array.propSetByNum(TJS_MEMBERENSURE | TJS_IGNOREPROP, i / 2, str(text), array);
      }
    return array;
  }

  /** `Exec`: a search that updates the match properties (and `start` with `g`). */
  exec(target: string): boolean {
    const region = this.match(target);
    const array = this.resultArray(region, target);
    this.array.set(obj(array, array));
    array.release();
    this.input = target;
    if (!region) {
      this.index = this.start;
      this.lastIndex = this.start;
      this.lastMatch = '';
      this.lastParen = '';
      this.leftContext = target.slice(0, this.start);
      return false;
    }
    const [beg0, end0] = region as [number, number];
    this.index = (this.start + beg0 * 2) >>> 0;
    let lastEnd = 0;
    for (let i = 1; i < region.length; i += 2) if (region[i]! > lastEnd) lastEnd = region[i]!;
    this.lastIndex = lastEnd + this.start;
    this.lastMatch = target.slice(beg0, end0);
    const last = region.length - 2;
    this.lastParen = region[last]! < 0 ? '' : target.slice(region[last], region[last + 1]);
    this.leftContext = target.slice(0, beg0 + this.start);
    this.rightContext = target.slice(this.lastIndex);
    if ((this.flags & GLOBAL_SEARCH) !== 0) this.start = this.lastIndex;
    return true;
  }

  /** `split_regex`: appends the pieces between matches to `array`. */
  split(array: ArrayObject, target: string, purgeEmpty: boolean): void {
    let count = 0;
    const push = (text: string) => array.propSetByNum(TJS_MEMBERENSURE, count++, str(text), array);
    let s = 0;
    let region = this.#search(target);
    if (!region) {
      push(target);
      return;
    }
    do {
      const len = region[0]!;
      if (!purgeEmpty || len > 0) push(target.slice(s, s + len));
      s += region[1]!;
    } while ((region = this.#search(target.slice(s))));
    if (!purgeEmpty || s < target.length) push(target.slice(s));
  }

  /**
   * `replace_regex`: replaces the first match (every match with `g`) by a string or by what a
   * function returns for the match array. Each search runs on the rest of the target. Returns
   * the result code of a failed callback with the text so far.
   */
  replace(target: string, replacement: Variant, objthis: Dispatch, out: {text: string}): number {
    const func =
      replacement.type === 1 ? obj(replacement.object, replacement.objthis ?? objthis) : null;
    const to = func ? '' : asString(replacement);
    const all = (this.flags & GLOBAL_SEARCH) !== 0;
    let s = 0;
    let region = this.#search(target);
    if (!region) {
      out.text += target;
      return TJS_S_OK;
    }
    do {
      const pos = region[0]!,
        end = region[1]!;
      if (pos > 0) out.text += target.slice(s, s + pos);
      if (!func) out.text += to;
      else {
        const array = this.resultArray(region, target.slice(s));
        const result = new VariantSlot();
        try {
          // The native loop cannot resume after its callback.
          const hr = withoutSuspension(() =>
            closureFuncCall(func, 0, null, result, [obj(array, array)], null),
          );
          if (hr < 0) return hr;
          out.text += asString(result.value);
        } finally {
          array.release();
          result.clear();
        }
      }
      s += end;
    } while (all && s < target.length && (region = this.#search(target.slice(s))));
    if (s < target.length) out.text += target.slice(s);
    return TJS_S_OK;
  }
}

export class RegExpClass extends NativeClass {
  /** `tTJSNC_RegExp::LastRegExp`: the RegExp of the last `test`/`exec`. */
  readonly last = new VariantSlot();

  constructor(engine: TjsEngine) {
    super('RegExp', () => new RegExpNI(engine));
    const self = this;
    const get = (objthis: Dispatch) => self.instanceOf<RegExpNI>(objthis);
    this.emptyFinalize();
    this.constructorMethod((_result, args, objthis) => {
      const r = constructNativeInstance<RegExpNI>(self, args, objthis);
      if (typeof r === 'number') return r;
      if (args.length >= 1) r.compile(args);
      return TJS_S_OK;
    });
    this.method('compile', (_result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      ni.compile(args);
      return TJS_S_OK;
    });
    this.method('_compile', (_result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length !== 1) return TJS_E_BADPARAMCOUNT;
      return ni.compileLiteral(asString(args[0]!)) ? TJS_S_OK : TJS_E_FAIL;
    });
    this.method('test', (result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const matched = ni.exec(asString(args[0]!));
      this.last.set(obj(objthis, objthis));
      result?.set(bool(matched));
      return TJS_S_OK;
    });
    this.method('match', (result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      if (result) {
        const target = asString(args[0]!);
        const array = ni.resultArray(ni.match(target), target);
        result.set(obj(array, array));
        array.release();
      }
      return TJS_S_OK;
    });
    this.method('exec', (result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      ni.exec(asString(args[0]!));
      this.last.set(obj(objthis, objthis));
      result?.set(ni.array.value);
      return TJS_S_OK;
    });
    this.method('replace', (result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 2) return TJS_E_BADPARAMCOUNT;
      const out = {text: ''};
      // A failing callback ends the replacement with the text so far.
      ni.replace(asString(args[0]!), args[1]!, objthis, out);
      result?.set(str(out.text));
      return TJS_S_OK;
    });
    this.method('split', (result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const target = asString(args[0]!);
      const purgeEmpty = args.length >= 3 ? asBoolean(args[2]!) : false;
      const array = engine.createArray();
      try {
        ni.split(array, target, purgeEmpty);
      } catch (e) {
        array.release();
        throw e;
      }
      result?.set(obj(array, array));
      array.release();
      return TJS_S_OK;
    });
    const prop = (read: (ni: RegExpNI) => Variant) => ({
      get: (result: VariantSlot, objthis: Dispatch) => {
        const ni = get(objthis);
        if (!ni) return TJS_E_NATIVECLASSCRASH;
        result.set(read(ni));
        return TJS_S_OK;
      },
    });
    this.property(
      'matches',
      prop((ni) => ni.array.value),
    );
    this.property('start', {
      ...prop((ni) => integer(BigInt(ni.start))),
      set: (value, objthis) => {
        const ni = get(objthis);
        if (!ni) return TJS_E_NATIVECLASSCRASH;
        ni.start = Number(BigInt.asUintN(32, asInteger(value)));
        return TJS_S_OK;
      },
    });
    this.property(
      'index',
      prop((ni) => integer(BigInt(ni.index))),
    );
    this.property(
      'lastIndex',
      prop((ni) => integer(BigInt(ni.lastIndex))),
    );
    this.property(
      'input',
      prop((ni) => str(ni.input)),
    );
    this.property(
      'lastMatch',
      prop((ni) => str(ni.lastMatch)),
    );
    this.property(
      'lastParen',
      prop((ni) => str(ni.lastParen)),
    );
    this.property(
      'leftContext',
      prop((ni) => str(ni.leftContext)),
    );
    this.property(
      'rightContext',
      prop((ni) => str(ni.rightContext)),
    );
    this.staticProperty('last', {get: (result) => (result.set(this.last.value), TJS_S_OK)});
  }

  /** Releases `RegExp.last` (engine shutdown). */
  clearLast(): void {
    this.last.set(VOID);
  }
}
