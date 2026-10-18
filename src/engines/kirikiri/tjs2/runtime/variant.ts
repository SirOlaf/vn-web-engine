/**
 * TJS2 variants (`tTJSVariant`, krkrz `tjsVariant.cpp`) as explicit tagged values. A variant is
 * immutable; storage that owns object references is a `VariantSlot` (`slot.ts`).
 *
 * | Type    | Payload                                                             |
 * | ------- | ------------------------------------------------------------------- |
 * | Void    | none                                                                |
 * | Object  | `object` and `objthis` (the closure context); both may be null      |
 * | String  | `value`; the empty string is the native null string                 |
 * | Octet   | `value`; length 0 is the native null octet                          |
 * | Integer | `value`, a signed 64-bit `bigint`                                   |
 * | Real    | `value`, a double                                                   |
 *
 * Conversions and operators follow the native code, including the 32-bit MSVC build's integer
 * edge cases (`(tTVInteger)real` of an out-of-range value, shift counts of 64 and more).
 */
import {parseNumber} from '../literals.js';
import {escapeC} from '../literals.js';
import {TjsVariantError, tjsMessage} from './errors.js';
import type {
  Dispatch,
  IntegerVariant,
  ObjectVariant,
  OctetVariant,
  RealVariant,
  StringVariant,
  Variant,
  VoidVariant,
} from './interface.js';

export const VariantType = {
  Void: 0,
  Object: 1,
  String: 2,
  Octet: 3,
  Integer: 4,
  Real: 5,
} as const;
export type VariantType = (typeof VariantType)[keyof typeof VariantType];

export type {
  IntegerVariant,
  ObjectVariant,
  OctetVariant,
  RealVariant,
  StringVariant,
  Variant,
  VoidVariant,
} from './interface.js';

export const VOID: VoidVariant = Object.freeze({type: 0});
export const NULL_OBJECT: ObjectVariant = Object.freeze({type: 1, object: null, objthis: null});
export const EMPTY_STRING: StringVariant = Object.freeze({type: 2, value: ''});
const EMPTY_OCTET: OctetVariant = Object.freeze({type: 3, value: new Uint8Array(0)});

const SMALL_INTEGERS: IntegerVariant[] = [];
for (let i = -128; i < 1024; i++) SMALL_INTEGERS.push(Object.freeze({type: 4, value: BigInt(i)}));

const INT64_MIN = -(1n << 63n);

export function integer(value: bigint): IntegerVariant {
  const v = BigInt.asIntN(64, value);
  if (v >= -128n && v < 1024n) return SMALL_INTEGERS[Number(v) + 128]!;
  return {type: 4, value: v};
}
/** An Integer from a JavaScript integer (`tTJSVariant(tjs_int)`). */
export function int(value: number): IntegerVariant {
  if (value >= -128 && value < 1024 && Number.isInteger(value)) return SMALL_INTEGERS[value + 128]!;
  return integer(BigInt(Math.trunc(value)));
}
export function bool(value: boolean): IntegerVariant {
  return SMALL_INTEGERS[value ? 129 : 128]!;
}
export function real(value: number): RealVariant {
  return {type: 5, value};
}
export function str(value: string): StringVariant {
  return value === '' ? EMPTY_STRING : {type: 2, value};
}
/** Copies nothing: the bytes must not change afterwards. */
export function octet(value: Uint8Array): OctetVariant {
  return value.length === 0 ? EMPTY_OCTET : {type: 3, value};
}
/** An object variant; `objthis` null is a plain object reference. */
export function obj(object: Dispatch | null, objthis: Dispatch | null = null): ObjectVariant {
  return object === null && objthis === null ? NULL_OBJECT : {type: 1, object, objthis};
}

// --- Conversions ---------------------------------------------------------------------------

function convertError(from: Variant, to: string): never {
  if (to === 'object')
    throw new TjsVariantError(tjsMessage('TJSVariantConvertErrorToObject', readableString(from)));
  throw new TjsVariantError(tjsMessage('TJSVariantConvertError', readableString(from), to));
}

/** `TJSVariantTypeToTypeString`. */
export function typeString(type: VariantType): string {
  return ['void', 'object', 'string', 'octet', 'int', 'real'][type]!;
}

/** `(tTVInteger)r` on the reference build: truncation; NaN and out-of-range give INT64_MIN. */
export function realToInteger(r: number): bigint {
  if (!(r >= -9223372036854775808 && r < 9223372036854775808)) return INT64_MIN;
  return BigInt(Math.trunc(r));
}

/** `TJSParseNumber` on a whole string; 0 when it does not start with a number. */
export function stringToNumber(s: string): IntegerVariant | RealVariant {
  const r = parseNumber(s, 0);
  if (!r) return SMALL_INTEGERS[128]!;
  return r.value.type === 'int' ? integer(r.value.value) : real(r.value.value);
}

/** `AsInteger`. */
export function asInteger(v: Variant): bigint {
  switch (v.type) {
    case 0:
      return 0n;
    case 2: {
      const n = stringToNumber(v.value);
      return n.type === 4 ? n.value : realToInteger(n.value);
    }
    case 4:
      return v.value;
    case 5:
      return realToInteger(v.value);
    default:
      return convertError(v, 'int');
  }
}

/** `(tjs_int)AsInteger()`: the low 32 bits, signed. */
export function asInt32(v: Variant): number {
  if (v.type === 4) return Number(BigInt.asIntN(32, v.value));
  return Number(BigInt.asIntN(32, asInteger(v)));
}

/** `AsReal`. */
export function asReal(v: Variant): number {
  switch (v.type) {
    case 0:
      return 0;
    case 2: {
      const n = stringToNumber(v.value);
      return n.type === 4 ? Number(n.value) : n.value;
    }
    case 4:
      return Number(v.value);
    case 5:
      return v.value;
    default:
      return convertError(v, 'real');
  }
}

/** `AsNumber`: Integer or Real. */
export function asNumber(v: Variant): IntegerVariant | RealVariant {
  switch (v.type) {
    case 0:
      return SMALL_INTEGERS[128]!;
    case 2:
      return stringToNumber(v.value);
    case 4:
    case 5:
      return v;
    default:
      return convertError(v, 'int/real');
  }
}

/** `operator bool`. A string is true when its number is non-zero. */
export function asBoolean(v: Variant): boolean {
  switch (v.type) {
    case 0:
      return false;
    case 1:
      return v.object !== null;
    case 2:
      return asInteger(v) !== 0n;
    case 3:
      return v.value.length !== 0;
    case 4:
      return v.value !== 0n;
    case 5:
      return v.value !== 0;
  }
}

/** `AsString`. Void is the empty string. */
export function asString(v: Variant): string {
  switch (v.type) {
    case 0:
      return '';
    case 1:
      return objectToString(v.object, v.objthis);
    case 2:
      return v.value;
    case 3:
      return convertError(v, 'string');
    case 4:
      return integerToString(v.value);
    case 5:
      return realToString(v.value);
  }
}

/** `AsOctet`: void is the empty octet. */
export function asOctet(v: Variant): Uint8Array {
  if (v.type === 0) return EMPTY_OCTET.value;
  if (v.type === 3) return v.value;
  return convertError(v, 'octet');
}

/** `AsObjectClosureNoAddRef`. */
export function asObjectClosure(v: Variant): ObjectVariant {
  if (v.type === 1) return v;
  return convertError(v, 'object');
}

/** `AsObjectNoAddRef`: the object, which may be null. */
export function asObject(v: Variant): Dispatch | null {
  if (v.type === 1) return v.object;
  return convertError(v, 'object');
}

/** `TJSIntegerToString`. */
export function integerToString(i: bigint): string {
  return i.toString();
}

/** `TJSRealToString`: `%.15lg` of the reference CRT, special values spelled out. */
export function realToString(r: number): string {
  const special = specialRealToString(r);
  if (special !== null) return special;
  return formatG(r, 15);
}

function specialRealToString(r: number): string | null {
  if (Number.isNaN(r)) return 'NaN';
  if (r === Infinity) return '+Infinity';
  if (r === -Infinity) return '-Infinity';
  if (r === 0) return Object.is(r, -0) ? '-0.0' : '+0.0';
  return null;
}

/**
 * `%.<precision>g` of the pre-2015 MSVC CRT, which prints at least three exponent digits
 * (`1e+020`; the reference build's static CRT carries the `e+000` template).
 */
export function formatG(r: number, precision: number): string {
  const p = precision === 0 ? 1 : precision;
  const e = r.toExponential(p - 1);
  const mark = e.indexOf('e');
  const exponent = Number(e.slice(mark + 1));
  if (exponent < -4 || exponent >= p) {
    let mantissa = e.slice(0, mark);
    if (mantissa.includes('.')) mantissa = mantissa.replace(/0+$/, '').replace(/\.$/, '');
    const sign = exponent < 0 ? '-' : '+';
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(3, '0')}`;
  }
  let fixed = r.toFixed(p - 1 - exponent);
  if (fixed.includes('.')) fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return fixed;
}

/** `TJSRealToHexString`: `0x1.<13 hex digits>p<exponent>`. */
export function realToHexString(r: number): string {
  const special = specialRealToString(r);
  if (special !== null) return special;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, r);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn) - 1023;
  const significand = (bits & ((1n << 52n) - 1n)).toString(16).toUpperCase().padStart(13, '0');
  return `${bits >> 63n ? '-' : ''}0x1.${significand}p${exponent}`;
}

/** `TJSOctetToListString`: `XX XX …`. */
export function octetToListString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i) s += ' ';
    s += bytes[i]!.toString(16).toUpperCase().padStart(2, '0');
  }
  return s;
}

/**
 * Pseudo addresses for `%p` of objects: stable per object, increasing in creation order of the
 * first print. They stand in for heap pointers, which scripts can only print and compare.
 */
const addresses = new WeakMap<Dispatch, number>();
let nextAddress = 0x01000000;
export function objectAddress(o: Dispatch | null): string {
  if (o === null) return '00000000';
  let a = addresses.get(o);
  if (a === undefined) {
    a = nextAddress;
    nextAddress += 0x40;
    addresses.set(o, a);
  }
  return a.toString(16).toUpperCase().padStart(8, '0');
}

/** `TJSObjectToString` without object type information (debug mode off). */
export function objectToString(object: Dispatch | null, objthis: Dispatch | null): string {
  return `(object 0x${objectAddress(object)}:0x${objectAddress(objthis)})`;
}

function trimLength(s: string, max: number): string {
  if (s.length <= max) return s;
  let t = s.slice(0, max);
  if (max >= 3) t = t.slice(0, max - 3) + '...';
  return t;
}

/** `TJSVariantToReadableString` (error messages): `(string)"…"`, `(int)1`, … */
export function readableString(v: Variant, max = 512): string {
  switch (v.type) {
    case 0:
      return trimLength('(void)', max);
    case 1: {
      let s = '(object)';
      try {
        s += asString(v);
      } catch {
        // as natively: the type prefix alone
      }
      return trimLength(s, max);
    }
    case 2:
      return trimLength(`(string)"${escapeC(v.value)}"`, max);
    case 3:
      return trimLength(`(octet)<% ${octetToListString(v.value)} %>`, max);
    case 4:
      return trimLength(`(int)${integerToString(v.value)}`, max);
    case 5:
      return trimLength(`(real)${realToString(v.value)}`, max);
  }
}

/** `TJSVariantToExpressionString`: TJS source for a value; objects give the empty string. */
export function expressionString(v: Variant): string {
  switch (v.type) {
    case 0:
      return 'void';
    case 1:
      return '';
    case 2:
      return `"${escapeC(v.value)}"`;
    case 3:
      return `<% ${octetToListString(v.value)} %>`;
    case 4:
      return integerToString(v.value);
    case 5:
      return `${realToHexString(v.value)} /* ${realToString(v.value)} */`;
  }
}

/** The `typeof` operator's names. */
export function typeOfName(v: Variant): string {
  return ['void', 'Object', 'String', 'Octet', 'Integer', 'Real'][v.type]!;
}

// --- Comparison ----------------------------------------------------------------------------

function realEquals(r1: number, r2: number): boolean {
  if (Number.isNaN(r1) || Number.isNaN(r2)) return false;
  return r1 === r2;
}

function octetEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `NormalCompare` (`==`). Conversion errors compare unequal. */
export function normalCompare(a: Variant, b: Variant): boolean {
  try {
    if (a.type === b.type) {
      switch (a.type) {
        case 4:
          return a.value === (b as IntegerVariant).value;
        case 2:
          return a.value === (b as StringVariant).value;
        case 3:
          return octetEquals(a.value, (b as OctetVariant).value);
        case 1:
          return a.object === (b as ObjectVariant).object;
        case 0:
          return true;
      }
    }
    if (a.type === 2 || b.type === 2) return asString(a) === asString(b);
    if (a.type === 0) {
      if (b.type === 4) return b.value === 0n;
      if (b.type === 5) return b.value === 0;
      return false;
    }
    if (b.type === 0) {
      if (a.type === 4) return a.value === 0n;
      if (a.type === 5) return a.value === 0;
      return false;
    }
    return realEquals(asReal(a), asReal(b));
  } catch (e) {
    if (e instanceof TjsVariantError) return false;
    throw e;
  }
}

/** `DiscernCompare` (`===`): same type and value; closures compare both halves. */
export function discernCompare(a: Variant, b: Variant): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 1: {
      const o = b as ObjectVariant;
      return a.object === o.object && a.objthis === o.objthis;
    }
    case 2:
    case 3:
      return normalCompare(a, b);
    case 0:
      return true;
    case 5:
      return realEquals(a.value, (b as RealVariant).value);
    case 4:
      return a.value === (b as IntegerVariant).value;
  }
}

/** `DiscernCompareStrictReal`: reals compare by bit pattern. */
export function discernCompareStrictReal(a: Variant, b: Variant): boolean {
  if (a.type === 5 && b.type === 5) {
    const view = new DataView(new ArrayBuffer(16));
    view.setFloat64(0, a.value);
    view.setFloat64(8, b.value);
    return view.getBigUint64(0) === view.getBigUint64(8);
  }
  return discernCompare(a, b);
}

/** `GreaterThan`: true when `a < b` (the native name reads from the right operand). */
export function greaterThan(a: Variant, b: Variant): boolean {
  if (a.type !== 2 || b.type !== 2) {
    if (a.type === 4 && b.type === 4) return a.value < b.value;
    return asReal(a) < asReal(b);
  }
  return compareStrings(a.value, b.value) < 0;
}

/** `LittlerThan`: true when `a > b`. */
export function littlerThan(a: Variant, b: Variant): boolean {
  if (a.type !== 2 || b.type !== 2) {
    if (a.type === 4 && b.type === 4) return a.value > b.value;
    return asReal(a) > asReal(b);
  }
  return compareStrings(a.value, b.value) > 0;
}

/** `TJS_strcmp`: UTF-16 code unit order. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Operators -----------------------------------------------------------------------------

function divideByZero(): never {
  throw new TjsVariantError(tjsMessage('TJSDivideByZero'));
}

function shiftCount(v: Variant): number {
  // The 64-bit shift helpers (_allshl/_allshr/_aullshr) use CL: counts of 64 and above fill.
  return asInt32(v) & 0xff;
}

/** `operator +`: concatenation if either is a String, Integer if both are, else Real. */
export function add(a: Variant, b: Variant): Variant {
  if (a.type === 2 || b.type === 2) return str(asString(a) + asString(b));
  if (a.type === b.type) {
    if (a.type === 3) {
      const o = (b as OctetVariant).value;
      const r = new Uint8Array(a.value.length + o.length);
      r.set(a.value);
      r.set(o, a.value.length);
      return octet(r);
    }
    if (a.type === 4) return integer(a.value + (b as IntegerVariant).value);
  }
  if (a.type === 0 && (b.type === 4 || b.type === 5)) return b;
  if (b.type === 0 && (a.type === 4 || a.type === 5)) return a;
  return real(asReal(a) + asReal(b));
}

export function sub(a: Variant, b: Variant): Variant {
  const l = asNumber(a),
    r = asNumber(b);
  if (l.type === 4 && r.type === 4) return integer(l.value - r.value);
  return real(asReal(l) - asReal(r));
}

export function mul(a: Variant, b: Variant): Variant {
  const l = asNumber(a),
    r = asNumber(b);
  if (l.type === 4 && r.type === 4) return integer(l.value * r.value);
  return real(asReal(l) * asReal(r));
}

/** `/`: always Real. */
export function div(a: Variant, b: Variant): RealVariant {
  const l = asReal(a);
  return real(l / asReal(b));
}

/** `\`: Integer division; throws on zero. */
export function idiv(a: Variant, b: Variant): IntegerVariant {
  const r = asInteger(b);
  const l = asInteger(a);
  if (r === 0n) divideByZero();
  return integer(l / r);
}

export function mod(a: Variant, b: Variant): IntegerVariant {
  const r = asInteger(b);
  if (r === 0n) divideByZero();
  return integer(asInteger(a) % r);
}

export function bitAnd(a: Variant, b: Variant): IntegerVariant {
  return integer(asInteger(a) & asInteger(b));
}
export function bitOr(a: Variant, b: Variant): IntegerVariant {
  return integer(asInteger(a) | asInteger(b));
}
export function bitXor(a: Variant, b: Variant): IntegerVariant {
  return integer(asInteger(a) ^ asInteger(b));
}
export function shiftLeft(a: Variant, b: Variant): IntegerVariant {
  const l = asInteger(a),
    c = shiftCount(b);
  return c >= 64 ? integer(0n) : integer(l << BigInt(c));
}
/** `>>`: arithmetic. */
export function shiftRight(a: Variant, b: Variant): IntegerVariant {
  const l = asInteger(a),
    c = shiftCount(b);
  return c >= 64 ? integer(l < 0n ? -1n : 0n) : integer(l >> BigInt(c));
}
/** `>>>`: logical. */
export function shiftRightUnsigned(a: Variant, b: Variant): IntegerVariant {
  const l = BigInt.asUintN(64, asInteger(a)),
    c = shiftCount(b);
  return c >= 64 ? integer(0n) : integer(l >> BigInt(c));
}
export function logicalOr(a: Variant, b: Variant): IntegerVariant {
  return bool(asBoolean(a) || asBoolean(b));
}
export function logicalAnd(a: Variant, b: Variant): IntegerVariant {
  return bool(asBoolean(a) && asBoolean(b));
}
export function logicalNot(a: Variant): IntegerVariant {
  return bool(!asBoolean(a));
}
export function bitNot(a: Variant): IntegerVariant {
  return integer(~asInteger(a));
}
/** Unary `-`. */
export function negate(a: Variant): Variant {
  if (a.type === 4) return integer(-a.value);
  const n = asNumber(a);
  return n.type === 4 ? integer(-n.value) : real(-n.value);
}
/** Unary `+` (`tonumber`). */
export function toNumber(a: Variant): IntegerVariant | RealVariant {
  if (a.type === 4 || a.type === 5) return a;
  if (a.type === 2) return stringToNumber(a.value);
  if (a.type === 0) return SMALL_INTEGERS[128]!;
  return convertError(a, 'int/real');
}
export function increment(a: Variant): Variant {
  const v = a.type === 2 ? stringToNumber(a.value) : a;
  if (v.type === 5) return real(v.value + 1);
  if (v.type === 4) return integer(v.value + 1n);
  if (v.type === 0) return SMALL_INTEGERS[129]!;
  return convertError(v, 'int/real');
}
export function decrement(a: Variant): Variant {
  const v = a.type === 2 ? stringToNumber(a.value) : a;
  if (v.type === 5) return real(v.value - 1);
  if (v.type === 4) return integer(v.value - 1n);
  if (v.type === 0) return SMALL_INTEGERS[127]!;
  return convertError(v, 'int/real');
}

/** `TJSDoVariantOperation`: the result of `target <op>= param`. */
export function variantOperation(op: number, target: Variant, param: Variant | null): Variant {
  const p = param ?? VOID;
  switch (op) {
    case 0x01:
      return bitAnd(target, p);
    case 0x02:
      return bitOr(target, p);
    case 0x03:
      return bitXor(target, p);
    case 0x04:
      return sub(target, p);
    case 0x05:
      return add(target, p);
    case 0x06:
      return mod(target, p);
    case 0x07:
      return div(target, p);
    case 0x08:
      return idiv(target, p);
    case 0x09:
      return mul(target, p);
    case 0x0a:
      return logicalOr(target, p);
    case 0x0b:
      return logicalAnd(target, p);
    case 0x0c:
      return shiftRight(target, p);
    case 0x0d:
      return shiftLeft(target, p);
    case 0x0e:
      return shiftRightUnsigned(target, p);
    case 0x0f:
      return increment(target);
    case 0x10:
      return decrement(target);
  }
  return target;
}
