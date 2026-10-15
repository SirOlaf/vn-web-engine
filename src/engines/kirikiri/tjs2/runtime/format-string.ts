/**
 * `TJSFormatString` (krkrz `tjsVariantString.cpp`): the formatter behind `String.sprintf`. It
 * parses `% [flag] [0] [width|*] [.prec|.*] type` itself and hands numbers to the C runtime's
 * `snprintf` with an `I64`/`l` size prefix; `crtFormat…` below reproduce the pre-2015 MSVC
 * CRT for those conversions (three exponent digits, `1.#INF00` for infinities).
 */
import {TjsVariantError, tjsMessage} from './errors.js';
import {asInteger, asReal, asString, type Variant} from './variant.js';

interface Spec {
  /** One of `-`, `+`, `#`, or empty. */
  readonly flag: string;
  readonly zero: boolean;
  readonly width: number;
  /** Precision, or -1 when the format has none. */
  readonly precision: number;
}

function invalidFormat(): never {
  throw new TjsVariantError(tjsMessage('TJSInvalidFormatString'));
}

function badParamCount(): never {
  throw new TjsVariantError(tjsMessage('TJSBadParamCount'));
}

export function formatString(format: string, params: readonly Variant[]): string {
  let out = '';
  let f = 0;
  let input = 0;
  const next = (): Variant => {
    if (input >= params.length) badParamCount();
    return params[input++]!;
  };
  const at = (i: number) => (i < format.length ? format[i]! : '');
  while (f < format.length) {
    if (format[f] !== '%') {
      out += format[f++];
      continue;
    }
    let flag = '';
    let zero = false;
    let width = 0;
    let widthInd = false;
    let precision = -1;
    let precInd = false;
    f++;
    if (!at(f)) invalidFormat();
    if (at(f) === '-' || at(f) === '+' || at(f) === '#') {
      flag = at(f++);
      if (!at(f)) invalidFormat();
    }
    if (at(f) === '0') {
      zero = true;
      f++;
      if (!at(f)) invalidFormat();
    }
    if (at(f) === '*') {
      widthInd = true;
      f++;
      if (!at(f)) invalidFormat();
    } else {
      while (at(f) >= '0' && at(f) <= '9' && at(f) !== '') width = width * 10 + Number(format[f++]);
      if (!at(f)) invalidFormat();
    }
    if (at(f) === '.') {
      f++;
      if (!at(f)) invalidFormat();
      if (at(f) === '*') {
        precInd = true;
        f++;
        if (!at(f)) invalidFormat();
      } else {
        if (!(at(f) >= '0' && at(f) <= '9')) invalidFormat();
        precision = 0;
        while (at(f) >= '0' && at(f) <= '9' && at(f) !== '')
          precision = precision * 10 + Number(format[f++]);
      }
    }
    const type = at(f);
    switch (type) {
      case '%':
        out += '%';
        f++;
        continue;
      case 'c':
      case 's': {
        if (widthInd) width = Number(BigInt.asIntN(32, asInteger(next())));
        if (precInd) precision = Number(BigInt.asIntN(32, asInteger(next())));
        const str = asString(next());
        f++;
        // A void or empty string writes nothing at all (`AsString` is null).
        if (str === '') continue;
        let prec = precision > 0 ? precision : str.length;
        if (type === 'c' && prec > 1) prec = 1;
        if (width < prec) width = prec;
        // strncpy pads with NULs beyond the source; the result ends at the first NUL.
        const body = str.slice(0, prec).padEnd(prec, '\0');
        const pad = ' '.repeat(width - prec);
        out += flag === '-' ? body + pad : pad + body;
        continue;
      }
      case 'd':
      case 'i':
      case 'o':
      case 'u':
      case 'x':
      case 'X':
      case 'f':
      case 'e':
      case 'g':
      case 'E':
      case 'G': {
        const integer = 'diouxX'.includes(type);
        if (Math.max(width, 0) + Math.max(precision, 0) > 900) invalidFormat();
        let w = width,
          p = precision;
        if (widthInd) w = Number(BigInt.asIntN(32, asInteger(next())));
        if (precInd) p = Number(BigInt.asIntN(32, asInteger(next())));
        if ((widthInd || precInd) && Math.max(w, 0) + Math.max(p, 0) > 900) invalidFormat();
        const value = next();
        let left = flag === '-';
        if (w < 0) {
          left = true;
          w = -w;
        }
        const spec: Spec = {flag: left ? '-' : flag, zero, width: w, precision: p < 0 ? -1 : p};
        out += integer
          ? crtFormatInteger(spec, type, asInteger(value))
          : crtFormatReal(spec, type, asReal(value));
        f++;
        continue;
      }
    }
    // An unknown type character is copied as text.
  }
  const nul = out.indexOf('\0');
  return nul >= 0 ? out.slice(0, nul) : out;
}

/** `%[flag][0][width][.prec]I64<type>` of the MSVC CRT. */
export function crtFormatInteger(spec: Spec, type: string, value: bigint): string {
  let sign = '';
  let digits: string;
  let prefix = '';
  if (type === 'd' || type === 'i') {
    const v = BigInt.asIntN(64, value);
    if (v < 0n) sign = '-';
    else if (spec.flag === '+') sign = '+';
    digits = (v < 0n ? -v : v).toString();
  } else {
    const v = BigInt.asUintN(64, value);
    digits = v.toString(type === 'o' ? 8 : type === 'u' ? 10 : 16);
    if (type === 'X') digits = digits.toUpperCase();
    if (spec.flag === '#' && v !== 0n) {
      if (type === 'o') prefix = '0';
      else if (type === 'x') prefix = '0x';
      else if (type === 'X') prefix = '0X';
    }
  }
  if (spec.precision >= 0) {
    if (spec.precision === 0 && digits === '0') digits = '';
    digits = digits.padStart(spec.precision, '0');
  }
  if (prefix === '0' && digits.startsWith('0')) prefix = '';
  return pad(spec, sign + prefix, digits, spec.precision < 0);
}

/** `%[flag][0][width][.prec]l<type>` of the pre-2015 MSVC CRT. */
export function crtFormatReal(spec: Spec, type: string, value: number): string {
  const precision = spec.precision < 0 ? 6 : spec.precision;
  const negative = value < 0 || Object.is(value, -0);
  const sign = negative ? '-' : spec.flag === '+' ? '+' : '';
  const a = Math.abs(value);
  let body: string;
  if (!Number.isFinite(a)) {
    body = specialReal(a, type, precision);
  } else if (type === 'f') {
    body = a.toFixed(precision);
    if (spec.flag === '#' && precision === 0) body += '.';
  } else if (type === 'e' || type === 'E') {
    body = exponential(a, precision, spec.flag === '#');
    if (type === 'E') body = body.toUpperCase();
  } else {
    body = general(a, precision === 0 ? 1 : precision, spec.flag === '#');
    if (type === 'G') body = body.toUpperCase();
  }
  return pad(spec, sign, body, Number.isFinite(a));
}

function exponential(a: number, precision: number, alt: boolean): string {
  const e = a.toExponential(precision);
  const mark = e.indexOf('e');
  let mantissa = e.slice(0, mark);
  if (alt && precision === 0) mantissa += '.';
  const exponent = Number(e.slice(mark + 1));
  return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(3, '0')}`;
}

function general(a: number, p: number, alt: boolean): string {
  const exponent = a === 0 ? 0 : Number(a.toExponential(p - 1).split('e')[1]);
  let s: string;
  if (exponent < -4 || exponent >= p) {
    s = exponential(a, p - 1, alt);
    if (!alt) {
      const mark = s.indexOf('e');
      let m = s.slice(0, mark);
      if (m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, '');
      s = m + s.slice(mark);
    }
  } else {
    s = a.toFixed(Math.max(0, p - 1 - exponent));
    if (!alt && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    else if (alt && !s.includes('.')) s += '.';
  }
  return s;
}

/** The old CRT's `1.#INF`/`1.#QNAN` forms, rounded to the precision as digits are. */
function specialReal(a: number, type: string, precision: number): string {
  const text = Number.isNaN(a) ? '1.#QNAN' : '1.#INF';
  if (type === 'g' || type === 'G') return text;
  const body = precision === 0 ? '1' : (text + '0'.repeat(precision)).slice(0, precision + 2);
  return type === 'e' || type === 'E' ? `${body}e+000` : body;
}

function pad(spec: Spec, head: string, body: string, zeroAllowed: boolean): string {
  const len = head.length + body.length;
  if (len >= spec.width) return head + body;
  const fill = spec.width - len;
  if (spec.flag === '-') return head + body + ' '.repeat(fill);
  if (spec.zero && zeroAllowed) return head + '0'.repeat(fill) + body;
  return ' '.repeat(fill) + head + body;
}
