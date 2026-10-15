/**
 * Members of strings and octets, which the VM answers itself (krkrz `tjsInterCodeExec.cpp`:
 * `GetStringProperty`, `ProcessStringFunction`, `ProcessOctetFunction`). The reference build
 * has the same thirteen string methods as the 2021 sources.
 */
import type {TjsEngine} from '../runtime/engine.js';
import {escapeC} from '../literals.js';
import {closureFuncCall} from '../runtime/dispatch.js';
import {throwFromCode, throwTjsError} from '../runtime/errors.js';
import {formatString} from '../runtime/format-string.js';
import {
  TJS_E_ACCESSDENYED,
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDPARAM,
  TJS_E_MEMBERNOTFOUND,
  TJS_MEMBERENSURE,
  type VariantResult,
} from '../runtime/interface.js';
import {unpack} from '../runtime/octpack.js';
import type {VariantSlot} from '../runtime/slot.js';
import {
  asInt32,
  asObjectClosure,
  asString,
  int,
  obj,
  str,
  type Variant,
} from '../runtime/variant.js';

/** `member.GetString()`: the name of a non-numeric member; void has none. */
function memberName(member: Variant): string {
  if (member.type === 0) throwFromCode(TJS_E_MEMBERNOTFOUND, '');
  return asString(member);
}

/** `TJS_atoi` of a name starting with a digit. */
function atoi(name: string): number {
  let n = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x30 || c > 0x39) break;
    n = (n * 10 + (c - 0x30)) | 0;
  }
  return n;
}

function isNumber(member: Variant): boolean {
  return member.type === 4 || member.type === 5;
}

function charAtOrRange(s: string, n: number): Variant {
  if (n === s.length) return str('');
  if (n < 0 || n > s.length) throwTjsError('TJSRangeError');
  return str(s[n]!);
}

/** `GetStringProperty`: `length` and character access by index. */
export function getStringProperty(result: VariantResult, s: string, member: Variant): void {
  if (!isNumber(member)) {
    const name = memberName(member);
    if (name === 'length') {
      result.set(int(s.length));
      return;
    }
    const c = name.charCodeAt(0);
    if (c >= 0x30 && c <= 0x39) {
      result.set(charAtOrRange(s, atoi(name)));
      return;
    }
    throwFromCode(TJS_E_MEMBERNOTFOUND, name);
  }
  result.set(charAtOrRange(s, asInt32(member)));
}

/** `SetStringProperty` and `SetOctetProperty`: strings and octets are read-only. */
export function setStringProperty(member: Variant): never {
  if (!isNumber(member)) {
    const name = memberName(member);
    const c = name.charCodeAt(0);
    if (name === 'length' || (c >= 0x30 && c <= 0x39)) throwFromCode(TJS_E_ACCESSDENYED, '');
    throwFromCode(TJS_E_MEMBERNOTFOUND, name);
  }
  throwFromCode(TJS_E_ACCESSDENYED, '');
  throw new Error('unreachable');
}

/** `GetOctetProperty`. */
export function getOctetProperty(result: VariantResult, o: Uint8Array, member: Variant): void {
  let n: number;
  if (!isNumber(member)) {
    const name = memberName(member);
    if (name === 'length') {
      result.set(int(o.length));
      return;
    }
    const c = name.charCodeAt(0);
    if (!(c >= 0x30 && c <= 0x39)) throwFromCode(TJS_E_MEMBERNOTFOUND, name);
    n = atoi(name);
  } else n = asInt32(member);
  if (n < 0 || n >= o.length) throwTjsError('TJSRangeError');
  result.set(int(o[n]!));
}

/** `ProcessStringFunction`: the methods of a string value. */
export function processStringFunction(
  engine: TjsEngine,
  member: string,
  s: string,
  args: readonly Variant[],
  result: VariantSlot | null,
): void {
  const n = args.length;
  const set = (v: Variant) => result?.set(v);
  switch (member) {
    case 'charAt': {
      if (n !== 1) throwFromCode(TJS_E_BADPARAMCOUNT);
      if (s.length === 0) return void set(str(''));
      const i = asInt32(args[0]!);
      set(i < 0 || i >= s.length ? str('') : str(s[i]!));
      return;
    }
    case 'indexOf': {
      if (n !== 1 && n !== 2) throwFromCode(TJS_E_BADPARAMCOUNT);
      const sub = asString(args[0]!);
      if (s === '' || sub === '') return void set(int(-1));
      const start = n === 1 ? 0 : asInt32(args[1]!);
      if (start >= s.length) return void set(int(-1));
      set(int(s.indexOf(sub, Math.max(0, start))));
      return;
    }
    case 'toUpperCase':
      if (n !== 0) throwFromCode(TJS_E_BADPARAMCOUNT);
      set(str(s.replace(/[a-z]+/g, (m) => m.toUpperCase())));
      return;
    case 'toLowerCase':
      if (n !== 0) throwFromCode(TJS_E_BADPARAMCOUNT);
      set(str(s.replace(/[A-Z]+/g, (m) => m.toLowerCase())));
      return;
    case 'substring':
    case 'substr': {
      if (n !== 1 && n !== 2) throwFromCode(TJS_E_BADPARAMCOUNT);
      const start = asInt32(args[0]!);
      if (start < 0 || start >= s.length) return void set(str(''));
      if (n === 2) {
        let count = asInt32(args[1]!);
        if (count < 0) return void set(str(''));
        if (start + count > s.length) count = s.length - start;
        set(str(s.substr(start, count)));
        return;
      }
      set(str(s.slice(start)));
      return;
    }
    case 'sprintf':
      if (result) result.set(str(formatString(s, args)));
      return;
    case 'replace': {
      // string.replace(pattern, replacement) is pattern.replace(string, replacement).
      if (n < 2) throwFromCode(TJS_E_BADPARAMCOUNT);
      const clo = asObjectClosure(args[0]!);
      closureFuncCall(clo, 0, 'replace', result, [str(s), args[1]!], null);
      return;
    }
    case 'escape':
      set(str(escapeC(s)));
      return;
    case 'split': {
      // string.split(pattern, reserved, purgeempty) is Array.split(pattern, string, …).
      if (n < 1) throwFromCode(TJS_E_BADPARAMCOUNT);
      const array = engine.createArray();
      try {
        const params: Variant[] = [args[0]!, str(s)];
        if (n >= 2) params.push(args[1]!);
        if (n >= 3) params.push(args[2]!);
        array.funcCall(0, 'split', null, params, array);
        set(obj(array, array));
      } finally {
        array.release();
      }
      return;
    }
    case 'trim': {
      if (n !== 0) throwFromCode(TJS_E_BADPARAMCOUNT);
      if (!result) return;
      let b = 0,
        e = s.length;
      const space = (i: number) => {
        const c = s.charCodeAt(i);
        return c > 0 && c <= 0x20;
      };
      while (e > b && space(e - 1)) e--;
      while (b < e && space(b)) b++;
      set(str(s.slice(b, e)));
      return;
    }
    case 'reverse':
      if (n !== 0) throwFromCode(TJS_E_BADPARAMCOUNT);
      if (!result) return;
      set(str(Array.from({length: s.length}, (_, i) => s[s.length - 1 - i]).join('')));
      return;
    case 'repeat': {
      if (n !== 1) throwFromCode(TJS_E_BADPARAMCOUNT);
      if (!result) return;
      const count = asInt32(args[0]!);
      set(str(count <= 0 || s.length === 0 ? '' : s.repeat(count)));
      return;
    }
  }
  throwFromCode(TJS_E_MEMBERNOTFOUND, member);
}

/** `ProcessOctetFunction`: `unpack` (`TJSOctetUnpack`); other members do not exist. */
export function processOctetFunction(
  engine: TjsEngine,
  member: string,
  octet: Uint8Array,
  args: readonly Variant[],
  result: VariantSlot | null,
): void {
  if (member !== 'unpack') throwFromCode(TJS_E_MEMBERNOTFOUND, member);
  if (args.length < 1) throwFromCode(TJS_E_BADPARAMCOUNT);
  // The empty octet is the null octet: there is nothing to unpack.
  const template = args[0]!;
  if (template.type !== 2 || octet.length === 0) return throwFromCode(TJS_E_INVALIDPARAM);
  if (!result) return;
  const array = engine.createArray();
  try {
    let n = 0;
    unpack(template.value, octet, (v) => array.propSetByNum(TJS_MEMBERENSURE, n++, v, array));
    result.set(obj(array, array));
  } finally {
    array.release();
  }
}
