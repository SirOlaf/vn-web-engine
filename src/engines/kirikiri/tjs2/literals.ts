/**
 * TJS2 literal scanning: numbers, strings, octets and regular expressions, following
 * `tjsLex.cpp` of TJS 2.4. The number and string routines are also the conversions the VM
 * applies to strings (`TJSParseNumber`), so they take the text and a start offset and report
 * where they stopped.
 */

export type TjsNumber =
  {readonly type: 'int'; readonly value: bigint} | {readonly type: 'real'; readonly value: number};

/**
 * Offsets are where the native scanner stopped: the end of the text for unterminated
 * literals and comments.
 */
export class LiteralError extends Error {
  constructor(
    readonly code: 'TJSStringParseError' | 'TJSNumberError' | 'TJSUnclosedComment',
    readonly offset: number,
  ) {
    super(code);
    this.name = 'LiteralError';
  }
}

/** `TJS_iswspace`: C-locale `isspace` for code units below 0x100, false above. */
export function isTjsSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

/** `TJS_iswalpha`: ASCII letters, and every code unit at or above 0x100. */
export function isTjsAlpha(c: number): boolean {
  return c >= 0x100 || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

export function isTjsDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function hexDigit(c: number): number {
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  return -1;
}
function octDigit(c: number): number {
  return c >= 0x30 && c <= 0x37 ? c - 0x30 : -1;
}
function decDigit(c: number): number {
  return c >= 0x30 && c <= 0x39 ? c - 0x30 : -1;
}
function binDigit(c: number): number {
  return c === 0x30 ? 0 : c === 0x31 ? 1 : -1;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && isTjsSpace(text.charCodeAt(i))) i++;
  return i;
}

/** `TJSStringMatch(…, isword = true)`: `word` at `i`, not followed by a letter or `_`. */
function matchWord(text: string, i: number, word: string): boolean {
  if (!text.startsWith(word, i)) return false;
  const c = text.charCodeAt(i + word.length);
  return !(isTjsAlpha(c) || c === 0x5f);
}

const INT64 = (v: bigint) => BigInt.asIntN(64, v);

/**
 * `TJSParseNumber`: optional sign and spaces, `true`/`false`/`NaN`/`Infinity`, `0x`, `0b`,
 * leading-zero octal, decimal; hexadecimal, binary and octal reals with a `p` exponent.
 * Returns null where the native routine returns false.
 */
export function parseNumber(text: string, start: number): {value: TjsNumber; end: number} | null {
  let i = start,
    negative = false;
  const c0 = text.charCodeAt(i);
  if (c0 === 0x2b || c0 === 0x2d) {
    negative = c0 === 0x2d;
    i = skipSpace(text, i + 1);
    if (i >= text.length) return null;
  }
  const r = parseNumber2(text, i);
  if (!r) return null;
  if (negative)
    r.value =
      r.value.type === 'int'
        ? {type: 'int', value: INT64(-r.value.value)}
        : {type: 'real', value: -r.value.value};
  return r;
}

function parseNumber2(text: string, i: number): {value: TjsNumber; end: number} | null {
  if (matchWord(text, i, 'true')) return {value: {type: 'int', value: 1n}, end: i + 4};
  if (matchWord(text, i, 'false')) return {value: {type: 'int', value: 0n}, end: i + 5};
  if (matchWord(text, i, 'NaN')) return {value: {type: 'real', value: NaN}, end: i + 3};
  if (matchWord(text, i, 'Infinity')) return {value: {type: 'real', value: Infinity}, end: i + 8};

  if (text.charCodeAt(i) === 0x30) {
    if (i + 1 >= text.length) return {value: {type: 'int', value: 0n}, end: i + 1};
    const mark = text[i + 1];
    if (mark === 'x' || mark === 'X') {
      if (i + 2 >= text.length) return null;
      return parseNonDecimal(text, i + 2, hexDigit, 4);
    }
    if (mark === 'b' || mark === 'B') {
      if (i + 2 >= text.length) return null;
      return parseNonDecimal(text, i + 2, binDigit, 1);
    }
    if (mark === 'p' || mark === 'P') return null;
    if (mark !== '.' && mark !== 'e' && mark !== 'E') return parseNonDecimal(text, i, octDigit, 3);
  }

  const {digits, isReal, end} = extractNumber(text, i, decDigit, 'E', 'e');
  if (!digits) return null;
  if (isReal) return {value: {type: 'real', value: decimalReal(digits)}, end};
  let v = 0n;
  for (let k = 0; k < digits.length; k++) {
    const d = decDigit(digits.charCodeAt(k));
    if (d < 0) break;
    v = INT64(v * 10n + BigInt(d));
  }
  return {value: {type: 'int', value: v}, end};
}

/** `TJSExtractNumber`: digits, one point, one exponent mark (spaces allowed after it and its sign). */
function extractNumber(
  text: string,
  i: number,
  valid: (c: number) => number,
  mark0: string,
  mark1: string,
): {digits: string; isReal: boolean; end: number} {
  let digits = '',
    point = false,
    exp = false;
  while (i < text.length) {
    const c = text.charCodeAt(i),
      ch = text[i]!;
    if (valid(c) !== -1 && !exp) {
      digits += ch;
      i++;
    } else if (ch === '.' && !point && !exp) {
      point = true;
      digits += ch;
      i++;
    } else if ((ch === mark0 || ch === mark1) && !exp) {
      exp = true;
      digits += ch;
      i = skipSpace(text, i + 1);
      if (i >= text.length) break;
      if (text[i] === '+' || text[i] === '-') {
        digits += text[i];
        i = skipSpace(text, i + 1);
      }
    } else if (decDigit(c) !== -1 && exp) {
      digits += ch;
      i++;
    } else {
      break;
    }
  }
  return {digits, isReal: point || exp, end: i};
}

/** `strtod` of an extracted decimal number; a dangling exponent mark is ignored as strtod does. */
function decimalReal(digits: string): number {
  const m = /^([0-9]*\.?[0-9]*)([eE][+-]?[0-9]+)?/.exec(digits)!;
  const mantissa = m[1] === '.' || m[1] === '' ? '0' : m[1]!;
  return Number(mantissa + (m[2] ?? ''));
}

function parseNonDecimal(
  text: string,
  i: number,
  valid: (c: number) => number,
  bits: number,
): {value: TjsNumber; end: number} | null {
  const {digits, isReal, end} = extractNumber(text, i, valid, 'P', 'p');
  if (!digits) return null;
  if (isReal) return {value: {type: 'real', value: nonDecimalReal(digits, valid, bits)}, end};
  let v = 0n;
  for (let k = 0; k < digits.length; k++)
    v = INT64((v << BigInt(bits)) + BigInt(valid(digits.charCodeAt(k))));
  return {value: {type: 'int', value: v}, end};
}

const U64 = (v: bigint) => BigInt.asUintN(64, v);

/** `TJSParseNonDecimalReal`: builds the IEEE double from the significand bits directly. */
function nonDecimalReal(digits: string, valid: (c: number) => number, bits: number): number {
  let main = 0n,
    exp = 0,
    signif = 0,
    pointPassed = false;
  for (let k = 0; k < digits.length; k++) {
    const ch = digits[k]!;
    if (ch === '.') {
      pointPassed = true;
    } else if (ch === 'p' || ch === 'P') {
      k++;
      let negative = false;
      if (digits[k] === '+') k++;
      else if (digits[k] === '-') {
        negative = true;
        k++;
      }
      let bias = 0;
      for (; k < digits.length; k++) bias = bias * 10 + decDigit(digits.charCodeAt(k));
      exp += negative ? -bias : bias;
      break;
    } else {
      const n = valid(digits.charCodeAt(k));
      if (signif === 0) {
        let b = bits - 1;
        while (b >= 0 && !((1 << b) & n)) b--;
        b++;
        if (b) {
          signif = b;
          main = U64(main | (BigInt(n) << BigInt(64 - signif)));
          if (pointPassed) exp -= bits - b + 1;
          else exp = b - 1;
        } else if (pointPassed) {
          exp -= bits;
        }
      } else {
        if (signif + bits < 64) {
          signif += bits;
          main = U64(main | (BigInt(n) << BigInt(64 - signif)));
        }
        if (!pointPassed) exp += bits;
      }
    }
  }
  main >>= BigInt(64 - 1 - 52);
  if (main === 0n) return 0;
  main &= (1n << 52n) - 1n;
  if (exp < -1022) return 0;
  if (exp > 1023) return Infinity;
  const raw = (BigInt(exp + 1023) << 52n) | main;
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, raw);
  return view.getFloat64(0);
}

/** `TJSUnescapeBackSlash`. */
function unescape(ch: string): string {
  switch (ch) {
    case 'a':
      return '\x07';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'v':
      return '\v';
    default:
      return ch;
  }
}

export type StringStop = 'delimiter' | 'ampersand' | 'dollar';

/**
 * `TJSInternalParseString` from just after the opening delimiter. Adjacent literals with the
 * same delimiter, separated only by spaces, are joined. In embeddable mode (`@"…"`) the scan
 * also stops after `&` and after `${`.
 */
export function scanString(
  text: string,
  start: number,
  delimiter: string,
  embeddable: boolean,
): {value: string; stop: StringStop; end: number} {
  let i = start,
    out = '';
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      i++;
      if (i >= text.length) break;
      const e = text[i]!;
      if (e === 'x' || e === 'X') {
        i++;
        if (i >= text.length) break;
        let code = 0,
          count = 0,
          d: number;
        while (count < 4 && (d = hexDigit(text.charCodeAt(i))) !== -1) {
          code = code * 16 + d;
          count++;
          i++;
          if (i >= text.length) break;
        }
        if (i >= text.length) break;
        out += String.fromCharCode(code);
      } else if (e === '0') {
        i++;
        if (i >= text.length) break;
        let code = 0,
          d: number;
        while ((d = octDigit(text.charCodeAt(i))) !== -1) {
          code = (code * 8 + d) & 0xffff;
          i++;
          if (i >= text.length) break;
        }
        if (i >= text.length) break;
        out += String.fromCharCode(code);
      } else {
        out += unescape(e);
        i++;
      }
    } else if (ch === delimiter) {
      i++;
      if (i >= text.length) return {value: out, stop: 'delimiter', end: i};
      const p = skipSpace(text, i);
      if (text[p] === delimiter) i = p + 1;
      else return {value: out, stop: 'delimiter', end: i};
    } else if (embeddable && ch === '&') {
      i++;
      if (i >= text.length) break;
      return {value: out, stop: 'ampersand', end: i};
    } else if (embeddable && ch === '$') {
      if (i + 1 >= text.length) break;
      if (text[i + 1] === '{') {
        if (i + 2 >= text.length) break;
        return {value: out, stop: 'dollar', end: i + 2};
      }
      out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  throw new LiteralError('TJSStringParseError', i);
}

/**
 * `TJSSkipComment` at `i`. Returns the offset after the comment and following spaces, or -1
 * if there is no comment at `i`. Block comments nest.
 */
export function skipComment(text: string, i: number): number {
  if (text[i] !== '/') return -1;
  if (text[i + 1] === '/') {
    const nl = text.indexOf('\n', i);
    return nl < 0 ? text.length : skipSpace(text, nl + 1);
  }
  if (text[i + 1] === '*') {
    i += 2;
    if (i >= text.length) throw new LiteralError('TJSUnclosedComment', text.length);
    let level = 0;
    for (;;) {
      if (text[i] === '/' && text[i + 1] === '*') level++;
      if (text[i] === '*' && text[i + 1] === '/') {
        if (level === 0) {
          i += 2;
          break;
        }
        level--;
      }
      i++;
      if (i >= text.length) throw new LiteralError('TJSUnclosedComment', text.length);
    }
    return skipSpace(text, i);
  }
  return -1;
}

/** `TJSParseOctet` at `<%`: hex digit pairs, `,` ends a single digit, comments allowed. */
export function scanOctet(text: string, start: number): {value: Uint8Array; end: number} {
  let i = start + 2;
  const bytes: number[] = [];
  let leading = true,
    cur = 0;
  while (i < text.length) {
    const skipped = skipComment(text, i);
    if (skipped >= 0) {
      if (skipped >= text.length) break;
      i = skipped;
    }
    if (text[i] === '%' && text[i + 1] === '>') {
      if (!leading) bytes.push(cur);
      return {value: Uint8Array.from(bytes), end: i + 2};
    }
    const c = text.charCodeAt(i),
      n = hexDigit(c);
    if (n !== -1) {
      if (leading) {
        cur = n;
        leading = false;
      } else {
        cur = ((cur << 4) + n) & 0xff;
        bytes.push(cur);
        leading = true;
      }
    }
    if (!leading && c === 0x2c) {
      bytes.push(cur);
      leading = true;
    }
    i++;
  }
  throw new LiteralError('TJSStringParseError', text.length);
}

/**
 * `TJSParseRegExp` from just after the opening `/`: the pattern is kept verbatim (escapes are
 * not decoded) and ends at an unescaped `/`, followed by lowercase flag letters.
 */
export function scanRegExp(
  text: string,
  start: number,
): {pattern: string; flags: string; end: number} {
  let i = start,
    pattern = '',
    lastBackslash = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      pattern += ch;
      lastBackslash = !lastBackslash;
    } else if (ch === '/' && !lastBackslash) {
      i++;
      let flags = '';
      while (i < text.length && text[i]! >= 'a' && text[i]! <= 'z') flags += text[i++];
      return {pattern, flags, end: i};
    } else {
      lastBackslash = false;
      pattern += ch;
    }
    i++;
  }
  throw new LiteralError('TJSStringParseError', text.length);
}

/** `tTJSString::EscapeC`: C escapes, `\xNN` for other control characters and hex digits after one. */
export function escapeC(text: string): string {
  let out = '',
    hex = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!,
      c = text.charCodeAt(i);
    const named = ESCAPES[ch];
    if (named) {
      out += named;
      hex = false;
    } else if (c < 0x20 || (hex && /[0-9A-Fa-f]/.test(ch))) {
      out += '\\x' + c.toString(16).padStart(2, '0');
      hex = true;
    } else {
      out += ch;
      hex = false;
    }
  }
  return out;
}

const ESCAPES: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\\': '\\\\',
  "'": "\\'",
  '"': '\\"',
};
