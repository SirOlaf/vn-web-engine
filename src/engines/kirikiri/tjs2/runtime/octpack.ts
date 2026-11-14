/**
 * `Array.pack` and `Octet.unpack` (krkrz `tjsOctPack.cpp`, `TJSOctetPack`/`TJSOctetUnpack`;
 * the reference build's `pack` is 0x477e10).
 *
 * Templates are Perl-like (`a A b B c C d f h H i I l L n N p P s S v V u w x X @ m`), each
 * with a count or `*`. Quirks of the native code are kept: in `unpack` a `*` count becomes
 * 0xFFFFFFFF in unsigned arithmetic, so number templates with `*` yield nothing and the byte
 * position wraps; hex digits accept `A`–`E` but not `F` in upper case; `p`/`P` pack nothing.
 * Narrow text (`a`, `A` in `unpack`) is Shift_JIS.
 */
import {decodeCp932} from '../../../../text/cp932.js';
import {throwTjsError} from './errors.js';
import {asInteger, asReal, asString, int, integer, real, str, type Variant} from './variant.js';

interface Template {
  readonly type: string;
  /** -1 for `*`. */
  readonly length: number;
}

const TYPES = 'aAbBcCdfhHiIlLnNpPsSvVuwxX@m';

/** `ParsePackTemplate`. */
function parseTemplate(text: string): Template[] {
  const out: Template[] = [];
  let i = 0;
  while (i < text.length) {
    const type = text[i]!;
    if (!TYPES.includes(type)) throwTjsError('TJSUnknownPackUnpackTemplateCharcter');
    i++;
    let length = 1;
    if (text[i] === '*') {
      length = -1;
      i++;
    } else if (text[i] !== undefined && text[i]! >= '0' && text[i]! <= '9') {
      length = 0;
      while (text[i] !== undefined && text[i]! >= '0' && text[i]! <= '9')
        length = (length * 10 + text.charCodeAt(i++) - 0x30) | 0;
    }
    out.push({type, length});
  }
  return out;
}

// --- pack ---------------------------------------------------------------------------------

function asciiToBin(bin: number[], arg: string, fill: number, len: number): void {
  if (len < 0) len = arg.length;
  let i = 0;
  for (; i < len && i < arg.length && arg.charCodeAt(i) !== 0; i++)
    bin.push(arg.charCodeAt(i) & 0xff);
  for (; i < len; i++) bin.push(fill);
}

function bitStringToBin(bin: number[], arg: string, mtol: boolean, len: number): void {
  if (len < 0) len = arg.length;
  let val = 0;
  let pos = mtol ? 7 : 0;
  for (let i = 0; i < len && i < arg.length && arg.charCodeAt(i) !== 0; i++) {
    const c = arg[i];
    if (c === '1') val |= 1 << pos;
    else if (c !== '0') throwTjsError('TJSUnknownBitStringCharacter');
    if (mtol ? pos === 0 : pos === 7) {
      bin.push(val);
      pos = mtol ? 7 : 0;
      val = 0;
    } else pos += mtol ? -1 : 1;
  }
  if (mtol ? pos < 7 : pos !== 0) bin.push(val);
}

function hexToBin(bin: number[], arg: string, mtol: boolean, len: number): void {
  if (len < 0) len = arg.length;
  let val = 0;
  let pos = mtol ? 1 : 0;
  for (let i = 0; i < len && i < arg.length && arg.charCodeAt(i) !== 0; i++) {
    const c = arg.charCodeAt(i);
    let d: number;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x45) d = c - 0x41 + 10;
    else return throwTjsError('TJSUnknownHexStringCharacter');
    val |= d << (pos * 4);
    if (mtol ? pos === 0 : pos !== 0) {
      bin.push(val);
      pos = mtol ? 1 : 0;
      val = 0;
    } else pos += mtol ? -1 : 1;
  }
  if (mtol ? pos < 1 : pos !== 0) bin.push(val);
}

/** Little-endian bytes of a number template; big-endian for `n`/`N`. */
function numberBytes(type: string, v: Variant): number[] {
  const le = (value: bigint, n: number) =>
    Array.from({length: n}, (_, i) => Number((value >> BigInt(i * 8)) & 0xffn));
  switch (type) {
    case 'c':
    case 'C':
      return le(asInteger(v), 1);
    case 's':
    case 'S':
    case 'v':
      return le(asInteger(v), 2);
    case 'n':
      return le(asInteger(v), 2).reverse();
    case 'i':
    case 'l':
    case 'I':
    case 'L':
    case 'V':
      return le(asInteger(v), 4);
    case 'N':
      return le(asInteger(v), 4).reverse();
    case 'f': {
      const b = new DataView(new ArrayBuffer(4));
      b.setFloat32(0, asReal(v), true);
      return Array.from(new Uint8Array(b.buffer));
    }
    default: {
      const b = new DataView(new ArrayBuffer(8));
      b.setFloat64(0, asReal(v), true);
      return Array.from(new Uint8Array(b.buffer));
    }
  }
}

/** `decodeBase64`: four characters at a time, `=` padding; shorter input decodes to nothing. */
function decodeBase64(text: string, out: number[]): void {
  const len = text.length;
  if (len < 4) return;
  const num = (i: number) => {
    const c = text.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) return c - 0x41;
    if (c >= 0x61 && c <= 0x7a) return c - 0x61 + 26;
    if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52;
    if (c === 0x2b) return 62;
    if (c === 0x2f) return 63;
    return 0;
  };
  let p = 0;
  while (p < len - 4) {
    out.push(((num(p) << 2) | (num(p + 1) >> 4)) & 0xff);
    p++;
    out.push(((num(p) << 4) | (num(p + 1) >> 2)) & 0xff);
    p++;
    out.push(((num(p) << 6) | num(p + 1)) & 0xff);
    p += 2;
  }
  out.push(((num(p) << 2) | (num(p + 1) >> 4)) & 0xff);
  p++;
  let tmp = (num(p++) << 4) & 0xff;
  if (text[p] !== '=') {
    tmp |= num(p) >> 2;
    out.push(tmp);
    tmp = (num(p++) << 6) & 0xff;
    if (text[p] !== '=') out.push(tmp | num(p));
  }
}

/** `TJSOctetPack`: the items packed by the template, or null when no bytes result. */
export function pack(template: string, items: readonly Variant[]): Uint8Array | null {
  const templ = parseTemplate(template);
  const out: number[] = [];
  const numargs = items.length;
  let argindex = 0;
  for (let i = 0; i < templ.length && argindex < numargs; argindex++) {
    const {type, length: len} = templ[i]!;
    switch (type) {
      case 'a':
      case 'A':
        asciiToBin(out, asString(items[argindex]!), type === 'a' ? 0 : 0x20, len);
        break;
      case 'b':
      case 'B':
        bitStringToBin(out, asString(items[argindex]!), type === 'B', len);
        break;
      case 'h':
      case 'H':
        hexToBin(out, asString(items[argindex]!), type === 'H', len);
        break;
      case 'p':
      case 'P':
        break;
      case 'u':
      case 'w':
        return throwTjsError(type === 'u' ? 'TJSNotSupportedUuencode' : 'TJSNotSupportedBER');
      case 'x':
        for (let a = 0; a < len; a++) out.push(0);
        argindex--;
        break;
      case 'X':
        for (let a = 0; a < len; a++) {
          // pop_back on an empty vector is undefined natively.
          if (!out.length) throw new Error('Array.pack: X backs up past the start');
          out.pop();
        }
        argindex--;
        break;
      case '@':
        while (out.length < len) out.push(0);
        argindex--;
        break;
      case 'm':
        decodeBase64(asString(items[argindex]!), out);
        break;
      default: {
        // ReadNumber: `len` items (the rest for `*`), then the loop's increment.
        let n = len < 0 ? numargs - argindex : len;
        if (n + argindex > numargs) n = numargs - argindex;
        for (let a = 0; a < n; a++) out.push(...numberBytes(type, items[argindex + a]!));
        argindex += n - 1;
      }
    }
    if (len >= 0) i++;
  }
  return out.length ? Uint8Array.from(out) : null;
}

// --- unpack -------------------------------------------------------------------------------

/** `Unpack`: the values described by the template, appended to `add`. */
export function unpack(template: string, data: Uint8Array, add: (v: Variant) => void): void {
  const templ = parseTemplate(template);
  const tail = data.length;
  // `current` is a pointer: offsets wrap modulo 2^32 as native 32-bit pointers do.
  let current = 0;
  const advance = (n: number) => (current = (current + n) | 0);
  // A position wrapped before the data stops unpacking (natively it reads outside).
  for (let i = 0; i < templ.length && current >= 0 && current < tail; i++) {
    const t = templ[i]!;
    // tjs_size: a `*` count is 0xFFFFFFFF.
    const len = t.length >>> 0;
    switch (t.type) {
      case 'a':
      case 'A': {
        const bytes: number[] = [];
        for (let k = 0; k < len && current + k !== tail; k++) {
          const b = data[current + k]!;
          if (b !== 0) bytes.push(b);
        }
        add(str(decodeCp932(Uint8Array.from(bytes))));
        advance(len);
        break;
      }
      case 'b':
      case 'B': {
        const mtol = t.type === 'B';
        let s = '';
        for (let k = current, pos = 0; k < tail && pos < len; k++)
          for (let bit = 0; bit < 8 && pos < len; bit++, pos++)
            s += data[k]! & (1 << (mtol ? 7 - bit : bit)) ? '1' : '0';
        add(str(s));
        advance(Math.floor(((len + 7) >>> 0) / 8));
        break;
      }
      case 'h':
      case 'H': {
        const mtol = t.type === 'H';
        // Pointer arithmetic: `data + len` wraps, and so does `len + 1`.
        let end = tail;
        if (((current + len) | 0) < tail) end = current + (((len + 1) >>> 0) >>> 1);
        let s = '';
        let k = current;
        let pos = mtol ? 1 : 0;
        for (let n = 0; n < len && k < end; n++) {
          const nib = (data[k]! >> (pos * 4)) & 0xf;
          s += String.fromCharCode(nib > 9 ? 0x41 + nib - 10 : 0x30 + nib);
          if (mtol ? pos === 0 : pos !== 0) {
            pos = mtol ? 1 : 0;
            k++;
          } else pos += mtol ? -1 : 1;
        }
        add(str(s));
        advance(Math.floor(((len + 1) >>> 0) / 2));
        break;
      }
      case 'p':
        return throwTjsError('TJSNotSupportedUnpackLP');
      case 'P':
        return throwTjsError('TJSNotSupportedUnpackP');
      case 'u':
        return throwTjsError('TJSNotSupportedUuencode');
      case 'w':
        return throwTjsError('TJSNotSupportedBER');
      case 'x':
        advance(len);
        break;
      case 'X':
        for (let x = 0; x < (len | 0) && current !== 0; x++) current--;
        break;
      case '@':
        current = len | 0;
        break;
      case 'm':
        add(str(encodeBase64(data.subarray(current))));
        current = tail;
        break;
      default:
        unpackNumbers(t.type, data, current, len, add);
        advance((len * numberSize(t.type)) | 0);
    }
  }
}

function numberSize(type: string): number {
  return 'cC'.includes(type) ? 1 : 'sSnv'.includes(type) ? 2 : type === 'd' ? 8 : 4;
}

/**
 * `BinToNumber*`: values of `len` items from `current`, the last one partial when the data
 * ends inside it. `len * size` wraps, so a `*` count reads nothing.
 */
function unpackNumbers(
  type: string,
  data: Uint8Array,
  current: number,
  len: number,
  add: (v: Variant) => void,
): void {
  const size = numberSize(type);
  let tail = data.length;
  const end = (current + ((len * size) >>> 0)) | 0;
  if (end < tail) tail = end;
  const bytes: number[] = [];
  const flush = () => {
    if (!bytes.length) return;
    const b = new Uint8Array(size);
    // Big-endian values fill from the most significant byte; a partial one lacks low bytes.
    b.set(bytes);
    const view = new DataView(b.buffer);
    switch (type) {
      case 'c':
        add(int(view.getInt8(0)));
        break;
      case 'C':
        add(int(view.getUint8(0)));
        break;
      case 's':
        add(int(view.getInt16(0, true)));
        break;
      case 'S':
      case 'v':
        add(int(view.getUint16(0, true)));
        break;
      case 'n':
        add(int(view.getUint16(0, false)));
        break;
      case 'i':
      case 'l':
        add(int(view.getInt32(0, true)));
        break;
      case 'I':
      case 'L':
      case 'V':
        add(integer(BigInt(view.getUint32(0, true))));
        break;
      case 'N':
        add(integer(BigInt(view.getUint32(0, false))));
        break;
      case 'f':
        add(real(view.getFloat32(0, true)));
        break;
      default:
        add(real(view.getFloat64(0, true)));
    }
    bytes.length = 0;
  };
  for (let p = current; p < tail; p++) {
    bytes.push(data[p]!);
    if (bytes.length === size) flush();
  }
  flush();
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(data: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 3 <= data.length; i += 3) {
    s += BASE64[data[i]! >> 2]! + BASE64[((data[i]! << 4) & 0x30) | (data[i + 1]! >> 4)]!;
    s += BASE64[((data[i + 1]! << 2) & 0x3c) | (data[i + 2]! >> 6)]! + BASE64[data[i + 2]! & 0x3f]!;
  }
  if (data.length - i === 2)
    s +=
      BASE64[data[i]! >> 2]! +
      BASE64[((data[i]! << 4) & 0x30) | (data[i + 1]! >> 4)]! +
      BASE64[(data[i + 1]! << 2) & 0x3c]! +
      '=';
  else if (data.length - i === 1)
    s += BASE64[data[i]! >> 2]! + BASE64[(data[i]! << 4) & 0x30]! + '==';
  return s;
}
