/** CID-keyed CFF outlines of OpenType (`OTTO`) fonts as FreeType 2.4.8 loads them:
 * `cff_font_load` (INDEXes, Top/FD/Private DICTs, FDSelect, charset checks), the font matrix
 * normalization of `cff_face_init`, and `cff_slot_load` with the unhinted Type 2 charstring
 * interpreter `cff_decoder_parse_charstrings`.
 *
 * Not reproduced: name-keyed CFF (glyph names, encodings, `seac` accents) and the
 * `random` operator's address-derived seed (a fixed seed is used). FreeType inverts the charset
 * of CID fonts only for bare CFF files, so glyph indices are used directly.
 */
import {
  divFix,
  mulDiv,
  mulFix,
  multiplyScaled,
  transform,
  transformScaled,
  type Matrix,
} from './fixed.js';
import {Outline, TAG_CUBIC, TAG_ON} from './outline.js';
import {FontError, FontErrorCode, type Sfnt} from './sfnt.js';

const MAX_DICT_STACK = 96,
  MAX_OPERANDS = 48,
  MAX_SUBRS_CALLS = 32,
  MAX_TRANS_ELEMENTS = 32,
  MAX_CID_FONTS = 256,
  NO_SID = 0xffff,
  /** Seed of `random`; FreeType derives it from stack addresses. */
  RANDOM_SEED = 0x7384,
  /** `sqrt` iterates until convergence in FreeType; bounded here. */
  SQRT_ITERATIONS = 64;

const POWER_TENS = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];

function fail(code: FontErrorCode): never {
  throw new FontError(code);
}

/** `power_tens[i]`; FreeType reads past its table for out-of-range digit counts. */
function ten(i: number): number {
  const value = POWER_TENS[i];
  if (value === undefined) fail(FontErrorCode.UnimplementedFeature);
  return value;
}

/** Bounds of an FT memory stream: a read or frame of `count` bytes at `pos`. */
function need(size: number, pos: number, count: number): void {
  if (pos >= size || size - pos < count) fail(FontErrorCode.InvalidStreamOperation);
}

/** `FT_Stream_Seek` / `FT_Stream_Skip` target check. */
function seek(size: number, pos: number): void {
  if (pos > size) fail(FontErrorCode.InvalidStreamOperation);
}

/** A CFF INDEX (`CFF_IndexRec`). Element offsets are read from the file on access. */
class Index {
  count = 0;
  offSize = 0;
  dataOffset = 0;
  dataSize = 0;
  /** Stream position after `cff_index_init`. */
  readonly end: number;

  /** `cff_index_init`; `load` extracts the data as a frame instead of skipping it. */
  constructor(
    private readonly data: Uint8Array,
    readonly start: number,
    load: boolean,
  ) {
    const size = data.length;
    need(size, start, 2);
    const count = (data[start]! << 8) | data[start + 1]!;
    let end = start + 2;
    if (count > 0) {
      need(size, start + 2, 1);
      const offSize = data[start + 2]!;
      if (offSize < 1 || offSize > 4) fail(FontErrorCode.InvalidTable);
      this.count = count;
      this.offSize = offSize;
      const tableSize = (count + 1) * offSize;
      this.dataOffset = start + 3 + tableSize;
      seek(size, start + 3 + tableSize - offSize);
      const last = this.offsetAt(start + 3 + tableSize - offSize);
      if (last === 0) fail(FontErrorCode.InvalidTable);
      this.dataSize = last - 1;
      if (load) need(size, this.dataOffset, this.dataSize);
      else seek(size, this.dataOffset + this.dataSize);
      end = this.dataOffset + this.dataSize;
    }
    this.end = end;
  }

  private offsetAt(pos: number): number {
    const d = this.data;
    need(d.length, pos, this.offSize);
    let result = 0;
    for (let i = 0; i < this.offSize; i++) result = result * 256 + d[pos + i]!;
    return result;
  }

  /** `cff_index_access_element` without a loaded offset table: [start, end) of an element,
   * or an empty range.
   */
  element(element: number): [number, number] {
    if (element >= this.count) fail(FontErrorCode.InvalidArgument);
    const size = this.data.length;
    let pos = this.start + 3 + element * this.offSize;
    seek(size, pos);
    const off1 = this.offsetAt(pos);
    let off2 = 0;
    if (off1 !== 0) {
      do {
        element++;
        pos += this.offSize;
        off2 = this.offsetAt(pos);
      } while (off2 === 0 && element < this.count);
    }
    if (off2 > size + 1 || this.dataOffset > size - off2 + 1)
      off2 = (size - this.dataOffset + 1) >>> 0;
    if (off1 && off2 > off1) {
      const begin = (this.dataOffset + off1 - 1) >>> 0;
      need(size, begin, off2 - off1);
      return [begin, begin + off2 - off1];
    }
    return [0, 0];
  }

  /** `cff_index_get_pointers` without a string pool: count + 1 element boundaries. */
  pointers(): Int32Array | null {
    const count = this.count;
    if (count === 0) return null;
    const table = new Int32Array(count + 1);
    let cur = (this.offsetAt(this.start + 3) - 1) >>> 0;
    if (cur >= this.dataSize) cur = 0;
    table[0] = this.dataOffset + cur;
    for (let n = 1; n <= count; n++) {
      let next = (this.offsetAt(this.start + 3 + n * this.offSize) - 1) >>> 0;
      if (next === 0 || next < cur || (next >= this.dataSize && n < count)) next = cur;
      table[n] = this.dataOffset + next;
      cur = next;
    }
    return table;
  }
}

/** The fields of `CFF_FontRecDictRec` and `CFF_PrivateRec` that glyph loading reads. */
interface FontDict {
  charstringType: number;
  matrix: Matrix;
  offset: Int32Array;
  unitsPerEm: number;
  hasFontMatrix: boolean;
  charsetOffset: number;
  charstringsOffset: number;
  privateOffset: number;
  privateSize: number;
  cidRegistry: number;
  fdArrayOffset: number;
  fdSelectOffset: number;
  localSubrsOffset: number;
  defaultWidth: number;
  nominalWidth: number;
}

interface SubFont {
  readonly dict: FontDict;
  locals: Int32Array | null;
  numLocals: number;
}

const newDict = (): FontDict => ({
  charstringType: 2,
  matrix: {xx: 0x10000, xy: 0, yx: 0, yy: 0x10000},
  offset: new Int32Array(2),
  unitsPerEm: 0,
  hasFontMatrix: false,
  charsetOffset: 0,
  charstringsOffset: 0,
  privateOffset: 0,
  privateSize: 0,
  cidRegistry: NO_SID,
  fdArrayOffset: 0,
  fdSelectOffset: 0,
  localSubrsOffset: 0,
  defaultWidth: 0,
  nominalWidth: 0,
});

/** `cff_parse_integer` of the operand at `p` ending before `limit`. */
function parseInteger(d: Uint8Array, p: number, limit: number): number {
  const v = d[p++]!;
  if (v === 28) return p + 2 > limit ? 0 : (((d[p]! << 8) | d[p + 1]!) << 16) >> 16;
  if (v === 29)
    return p + 4 > limit ? 0 : (d[p]! << 24) | (d[p + 1]! << 16) | (d[p + 2]! << 8) | d[p + 3]!;
  if (v < 247) return v - 139;
  if (p + 1 > limit) return 0;
  return v < 251 ? (v - 247) * 256 + d[p]! + 108 : -(v - 251) * 256 - d[p]! - 108;
}

/** `cff_parse_real`; with `scaling` set, returns the dynamic-scaling result through `out[0]`. */
function parseReal(
  d: Uint8Array,
  start: number,
  limit: number,
  powerTen: number,
  out: Int32Array | null,
): number {
  let p = start,
    nib = 0,
    phase = 4,
    result = 0,
    number = 0,
    exponent = 0,
    sign = false,
    exponentSign = false,
    exponentAdd = 0,
    integerLength = 0,
    fractionLength = 0;
  if (out) out[0] = 0;
  for (;;) {
    if (phase) {
      p++;
      if (p >= limit) return result;
    }
    nib = (d[p]! >> phase) & 0xf;
    phase = 4 - phase;
    if (nib === 0xe) sign = true;
    else if (nib > 9) break;
    else if (number >= 0xccccccc) exponentAdd++;
    else if (nib || number) {
      integerLength++;
      number = number * 10 + nib;
    }
  }
  if (nib === 0xa)
    for (;;) {
      if (phase) {
        p++;
        if (p >= limit) return result;
      }
      nib = (d[p]! >> phase) & 0xf;
      phase = 4 - phase;
      if (nib >= 10) break;
      if (!nib && !number) exponentAdd--;
      else if (number < 0xccccccc && fractionLength < 9) {
        fractionLength++;
        number = number * 10 + nib;
      }
    }
  if (nib === 12) {
    exponentSign = true;
    nib = 11;
  }
  if (nib === 11) {
    for (;;) {
      if (phase) {
        p++;
        if (p >= limit) return result;
      }
      nib = (d[p]! >> phase) & 0xf;
      phase = 4 - phase;
      if (nib >= 10) break;
      exponent = exponent * 10 + nib;
      if (exponent > 1000) return result;
    }
    if (exponentSign) exponent = -exponent;
  }
  exponent += powerTen + exponentAdd;
  if (out) {
    fractionLength += integerLength;
    exponent += integerLength;
    if (fractionLength <= 5) {
      if (number > 0x7fff) {
        result = divFix(number, 10);
        out[0] = exponent - fractionLength + 1;
      } else {
        if (exponent > 0) {
          const newFractionLength = Math.min(exponent, 5);
          exponent -= newFractionLength;
          number = Math.imul(number, ten(newFractionLength - fractionLength));
          if (number > 0x7fff) {
            number = (number / 10) | 0;
            exponent += 1;
          }
        } else exponent -= fractionLength;
        result = number << 16;
        out[0] = exponent;
      }
    } else if (((number / ten(fractionLength - 5)) | 0) > 0x7fff) {
      result = divFix(number, ten(fractionLength - 4));
      out[0] = exponent - 4;
    } else {
      result = divFix(number, ten(fractionLength - 5));
      out[0] = exponent - 5;
    }
  } else {
    integerLength += exponent;
    fractionLength -= exponent;
    if (Math.abs(integerLength) > 5) return result;
    if (integerLength < 0) {
      number = (number / ten(-integerLength)) | 0;
      fractionLength += integerLength;
    }
    if (fractionLength === 10) {
      number = (number / 10) | 0;
      fractionLength -= 1;
    }
    if (fractionLength > 0) {
      if (((number / ten(fractionLength)) | 0) > 0x7fff) return result;
      result = divFix(number, ten(fractionLength));
    } else {
      number = Math.imul(number, ten(-fractionLength));
      if (number > 0x7fff) return result;
      result = number << 16;
    }
  }
  return sign ? -result | 0 : result;
}

/** A DICT operand stack: positions of the operands, the last entry is the operator. Only the
 * values glyph loading reads are converted; FontBBox, blues and other hinting values are not.
 */
class DictParser {
  readonly stack = new Int32Array(MAX_DICT_STACK + 1);
  top = 0;
  private readonly scaling = new Int32Array(1);

  constructor(readonly data: Uint8Array) {}

  num(i: number): number {
    const d = this.data,
      p = this.stack[i]!,
      limit = this.stack[i + 1]!;
    return d[p] === 30 ? parseReal(d, p, limit, 0, null) >> 16 : parseInteger(d, p, limit);
  }

  fixedScaled(i: number, scaling: number): number {
    const d = this.data,
      p = this.stack[i]!,
      limit = this.stack[i + 1]!;
    return d[p] === 30
      ? parseReal(d, p, limit, scaling, null)
      : Math.imul(parseInteger(d, p, limit), ten(scaling)) << 16;
  }

  /** `cff_parse_fixed_dynamic`: returns [value, scaling]. */
  fixedDynamic(i: number): [number, number] {
    const d = this.data,
      p = this.stack[i]!,
      limit = this.stack[i + 1]!;
    if (d[p] === 30) {
      const value = parseReal(d, p, limit, 0, this.scaling);
      return [value, this.scaling[0]!];
    }
    const number = parseInteger(d, p, limit);
    if (number <= 0x7fff) return [number << 16, 0];
    let length = 5;
    for (; length < 10; length++) if (number < POWER_TENS[length]!) break;
    if (((number / POWER_TENS[length - 5]!) | 0) > 0x7fff)
      return [divFix(number, POWER_TENS[length - 4]!), length - 4];
    return [divFix(number, POWER_TENS[length - 5]!), length - 5];
  }
}

const enum Kind {
  Num,
  Fixed,
  Fixed1000,
  Delta,
  Callback,
}

const enum Code {
  Top = 0x1000,
  Private = 0x2000,
}

interface Field {
  readonly kind: Kind;
  /** Stores a number field; absent for fields glyph loading never reads. */
  readonly store?: (dict: FontDict, value: number) => void;
  readonly callback?: (dict: FontDict, parser: DictParser) => void;
}

const num = (store?: Field['store']): Field => ({kind: Kind.Num, store});

/** `cff_parse_font_matrix`. */
function parseFontMatrix(dict: FontDict, parser: DictParser): void {
  if (parser.top < 6) fail(FontErrorCode.StackUnderflow);
  const m = dict.matrix,
    o = dict.offset;
  dict.hasFontMatrix = true;
  let scaling: number;
  [m.xx, scaling] = parser.fixedDynamic(0);
  scaling = -scaling;
  if (scaling < 0 || scaling > 9) {
    m.xx = 0x10000;
    m.yx = 0;
    m.xy = 0;
    m.yy = 0x10000;
    o[0] = 0;
    o[1] = 0;
    dict.unitsPerEm = 1;
    return;
  }
  m.yx = parser.fixedScaled(1, scaling);
  m.xy = parser.fixedScaled(2, scaling);
  m.yy = parser.fixedScaled(3, scaling);
  o[0] = parser.fixedScaled(4, scaling);
  o[1] = parser.fixedScaled(5, scaling);
  dict.unitsPerEm = POWER_TENS[scaling]!;
}

/** `cff_field_handlers` (cfftoken.h). Codes carry the DICT kind in bits 12–13. */
const FIELDS = new Map<number, Field>([
  [Code.Top | 0, num()],
  [Code.Top | 1, num()],
  [Code.Top | 0x100, num()],
  [Code.Top | 2, num()],
  [Code.Top | 3, num()],
  [Code.Top | 4, num()],
  [Code.Top | 0x101, num()],
  [Code.Top | 0x102, {kind: Kind.Fixed}],
  [Code.Top | 0x103, {kind: Kind.Fixed}],
  [Code.Top | 0x104, {kind: Kind.Fixed}],
  [Code.Top | 0x105, num()],
  [Code.Top | 0x106, num((d, v) => (d.charstringType = v))],
  [Code.Top | 0x107, {kind: Kind.Callback, callback: parseFontMatrix}],
  [Code.Top | 13, num()],
  [
    Code.Top | 5,
    {
      kind: Kind.Callback,
      callback: (_, p) => {
        if (p.top < 4) fail(FontErrorCode.StackUnderflow);
      },
    },
  ],
  [Code.Top | 0x108, num()],
  [Code.Top | 15, num((d, v) => (d.charsetOffset = v >>> 0))],
  [Code.Top | 16, num()],
  [Code.Top | 17, num((d, v) => (d.charstringsOffset = v >>> 0))],
  [
    Code.Top | 18,
    {
      kind: Kind.Callback,
      callback: (d, p) => {
        if (p.top < 2) fail(FontErrorCode.StackUnderflow);
        d.privateSize = p.num(0) >>> 0;
        d.privateOffset = p.num(1) >>> 0;
      },
    },
  ],
  [Code.Top | 0x114, num()],
  [Code.Top | 0x115, num()],
  [
    Code.Top | 0x11e,
    {
      kind: Kind.Callback,
      callback: (d, p) => {
        if (p.top < 3) fail(FontErrorCode.StackUnderflow);
        d.cidRegistry = p.num(0) >>> 0;
      },
    },
  ],
  [Code.Top | 0x11f, num()],
  [Code.Top | 0x120, num()],
  [Code.Top | 0x121, num()],
  [Code.Top | 0x122, num()],
  [Code.Top | 0x123, num()],
  [Code.Top | 0x124, num((d, v) => (d.fdArrayOffset = v >>> 0))],
  [Code.Top | 0x125, num((d, v) => (d.fdSelectOffset = v >>> 0))],
  [Code.Top | 0x126, num()],
  [Code.Private | 6, {kind: Kind.Delta}],
  [Code.Private | 7, {kind: Kind.Delta}],
  [Code.Private | 8, {kind: Kind.Delta}],
  [Code.Private | 9, {kind: Kind.Delta}],
  [Code.Private | 0x109, {kind: Kind.Fixed1000}],
  [Code.Private | 0x10a, num()],
  [Code.Private | 0x10b, num()],
  [Code.Private | 10, num()],
  [Code.Private | 11, num()],
  [Code.Private | 0x10c, {kind: Kind.Delta}],
  [Code.Private | 0x10d, {kind: Kind.Delta}],
  [Code.Private | 0x10e, num()],
  [Code.Private | 0x10f, {kind: Kind.Fixed}],
  [Code.Private | 0x110, num()],
  [Code.Private | 0x111, num()],
  [Code.Private | 0x112, {kind: Kind.Fixed}],
  [Code.Private | 0x113, num()],
  [Code.Private | 19, num((d, v) => (d.localSubrsOffset = v >>> 0))],
  [Code.Private | 20, num((d, v) => (d.defaultWidth = v))],
  [Code.Private | 21, num((d, v) => (d.nominalWidth = v))],
]);

/** `cff_parser_run` over [start, limit). */
function parseDict(
  data: Uint8Array,
  start: number,
  limit: number,
  code: Code,
  dict: FontDict,
): void {
  const parser = new DictParser(data),
    stack = parser.stack;
  let p = start;
  while (p < limit) {
    let v = data[p]!;
    if (v >= 27 && v !== 31) {
      if (parser.top >= MAX_DICT_STACK) fail(FontErrorCode.InvalidArgument);
      stack[parser.top++] = p;
      if (v === 30) {
        p++;
        for (;;) {
          if (p >= limit) return;
          if (data[p]! >> 4 === 15 || (data[p]! & 0xf) === 15) break;
          p++;
        }
      } else if (v === 28) p += 2;
      else if (v === 29) p += 4;
      else if (v > 246) p += 1;
    } else {
      const numArgs = parser.top;
      stack[numArgs] = p;
      if (v === 12) {
        p++;
        if (p >= limit) fail(FontErrorCode.InvalidArgument);
        v = 0x100 | data[p]!;
      }
      const field = FIELDS.get(v | code);
      if (field) {
        if (field.kind !== Kind.Delta && numArgs < 1) fail(FontErrorCode.InvalidArgument);
        switch (field.kind) {
          case Kind.Num:
            field.store?.(dict, parser.num(0));
            break;
          case Kind.Callback:
            field.callback!(dict, parser);
            break;
        }
      }
      parser.top = 0;
    }
    p++;
  }
}

/** `cff_compute_bias`. */
const subrsBias = (charstringType: number, count: number): number =>
  charstringType === 1 ? 0 : count < 1240 ? 107 : count < 33900 ? 1131 : 32768;

/** `cff_builder_close_contour`. */
function closeContour(o: Outline): void {
  const first = o.nContours <= 1 ? 0 : o.contours[o.nContours - 2]! + 1;
  if (o.nPoints > 1) {
    const v = o.points,
      last = o.nPoints - 1;
    if (
      v[first * 2] === v[last * 2] &&
      v[first * 2 + 1] === v[last * 2 + 1] &&
      o.tags[last] === TAG_ON
    )
      o.nPoints--;
  }
  if (o.nContours > 0) {
    if (first === o.nPoints - 1) {
      o.nContours--;
      o.nPoints--;
    } else o.contours[o.nContours - 1] = o.nPoints - 1;
  }
}

/** `cff_builder_add_point` (16.16 position, stored in font units). */
function addPoint(o: Outline, x: number, y: number, on: boolean): void {
  const n = o.nPoints;
  o.points[n * 2] = x >> 16;
  o.points[n * 2 + 1] = y >> 16;
  o.tags[n] = on ? TAG_ON : TAG_CUBIC;
  o.nPoints = n + 1;
}

/** `cff_builder_add_contour`. */
function addContour(o: Outline): void {
  o.reserve(0, 1);
  if (o.nContours > 0) o.contours[o.nContours - 1] = o.nPoints - 1;
  o.nContours++;
}

const enum Op {
  Unknown,
  Rmoveto,
  Hmoveto,
  Vmoveto,
  Rlineto,
  Hlineto,
  Vlineto,
  Rrcurveto,
  Hhcurveto,
  Hvcurveto,
  Rcurveline,
  Rlinecurve,
  Vhcurveto,
  Vvcurveto,
  Flex,
  Hflex,
  Hflex1,
  Flex1,
  Endchar,
  Hstem,
  Vstem,
  Hstemhm,
  Vstemhm,
  Hintmask,
  Cntrmask,
  Dotsection,
  Abs,
  Add,
  Sub,
  Div,
  Neg,
  Random,
  Mul,
  Sqrt,
  Blend,
  Drop,
  Exch,
  Index,
  Roll,
  Dup,
  Put,
  Get,
  Store,
  Load,
  And,
  Or,
  Not,
  Eq,
  Ifelse,
  Callsubr,
  Callgsubr,
  Return,
  Hsbw,
  Closepath,
  Callothersubr,
  Pop,
  Seac,
  Sbw,
  Setcurrentpoint,
}

const CHECK_WIDTH = 0x80,
  EXACT = 0x40,
  CLEAR_STACK = 0x20;

/** `cff_argument_counts`, indexed by `Op`. */
const ARGUMENT_COUNTS = Uint8Array.of(
  0,
  2 | CHECK_WIDTH | EXACT,
  1 | CHECK_WIDTH | EXACT,
  1 | CHECK_WIDTH | EXACT,
  CLEAR_STACK,
  CLEAR_STACK,
  CLEAR_STACK,
  CLEAR_STACK,
  CLEAR_STACK,
  CLEAR_STACK,
  CLEAR_STACK,
  CLEAR_STACK,
  CLEAR_STACK,
  CLEAR_STACK,
  13,
  7,
  9,
  11,
  CHECK_WIDTH,
  2 | CHECK_WIDTH,
  2 | CHECK_WIDTH,
  2 | CHECK_WIDTH,
  2 | CHECK_WIDTH,
  CHECK_WIDTH,
  CHECK_WIDTH,
  0,
  1,
  2,
  2,
  2,
  1,
  0,
  2,
  1,
  1,
  1,
  2,
  1,
  2,
  1,
  2,
  1,
  4,
  3,
  2,
  2,
  1,
  2,
  4,
  1,
  1,
  0,
  2,
  0,
  0,
  0,
  5,
  4,
  2,
);

const OPS = new Uint8Array(32),
  ESCAPE_OPS = new Uint8Array(256);
for (const [byte, op] of [
  [1, Op.Hstem],
  [3, Op.Vstem],
  [4, Op.Vmoveto],
  [5, Op.Rlineto],
  [6, Op.Hlineto],
  [7, Op.Vlineto],
  [8, Op.Rrcurveto],
  [9, Op.Closepath],
  [10, Op.Callsubr],
  [11, Op.Return],
  [13, Op.Hsbw],
  [14, Op.Endchar],
  [16, Op.Blend],
  [18, Op.Hstemhm],
  [19, Op.Hintmask],
  [20, Op.Cntrmask],
  [21, Op.Rmoveto],
  [22, Op.Hmoveto],
  [23, Op.Vstemhm],
  [24, Op.Rcurveline],
  [25, Op.Rlinecurve],
  [26, Op.Vvcurveto],
  [27, Op.Hhcurveto],
  [29, Op.Callgsubr],
  [30, Op.Vhcurveto],
  [31, Op.Hvcurveto],
] as const)
  OPS[byte] = op;
for (const [byte, op] of [
  [0, Op.Dotsection],
  [1, Op.Vstem],
  [2, Op.Hstem],
  [3, Op.And],
  [4, Op.Or],
  [5, Op.Not],
  [6, Op.Seac],
  [7, Op.Sbw],
  [8, Op.Store],
  [9, Op.Abs],
  [10, Op.Add],
  [11, Op.Sub],
  [12, Op.Div],
  [13, Op.Load],
  [14, Op.Neg],
  [15, Op.Eq],
  [16, Op.Callothersubr],
  [17, Op.Pop],
  [18, Op.Drop],
  [20, Op.Put],
  [21, Op.Get],
  [22, Op.Ifelse],
  [23, Op.Random],
  [24, Op.Mul],
  [26, Op.Sqrt],
  [27, Op.Dup],
  [28, Op.Exch],
  [29, Op.Index],
  [30, Op.Roll],
  [33, Op.Setcurrentpoint],
  [34, Op.Hflex],
  [35, Op.Flex],
  [36, Op.Hflex1],
  [37, Op.Flex1],
] as const)
  ESCAPE_OPS[byte] = op;

/** Operand stack slots below the first operand; reads below the stack yield 0. */
const STACK_BASE = 2;

export class CffOutlines {
  readonly numGlyphs: number;
  private readonly data: Uint8Array;
  private readonly top: SubFont;
  private readonly subfonts: SubFont[] = [];
  private readonly charstrings: Index;
  private readonly globals: Int32Array | null;
  private readonly numGlobals: number;
  private readonly fdFormat: number = 0;
  private readonly fdData: number = 0;
  private readonly fdSize: number = 0;
  // FDSelect format 3 lookup cache (`cache_first`, `cache_count`, `cache_fd`).
  private fdCacheFirst = 0;
  private fdCacheCount = 0;
  private fdCacheFd = 0;
  private xScale = 0;
  private yScale = 0;
  private readonly stack = new Int32Array(STACK_BASE + MAX_OPERANDS + 1);
  private readonly buildchar = new Int32Array(MAX_TRANS_ELEMENTS);
  private readonly zoneCursor = new Int32Array(MAX_SUBRS_CALLS + 1);
  private readonly zoneLimit = new Int32Array(MAX_SUBRS_CALLS + 1);

  /** `cff_font_load` for an sfnt-wrapped CFF table, then the matrix setup of `cff_face_init`. */
  constructor(sfnt: Sfnt) {
    const data = (this.data = sfnt.bytes.data),
      size = data.length;
    const table = sfnt.find('CFF ');
    if (!table) fail(FontErrorCode.TableMissing);
    const base = table.offset;
    need(size, base, 4);
    if (data[base] !== 1 || data[base + 2]! < 4 || data[base + 3]! > 4)
      fail(FontErrorCode.UnknownFileFormat);
    seek(size, base + data[base + 2]!);
    const names = new Index(data, base + data[base + 2]!, false);
    const dicts = new Index(data, names.end, false);
    const strings = new Index(data, dicts.end, true);
    const globals = new Index(data, strings.end, true);
    const top = (this.top = this.loadSubfont(dicts, 0, base));
    const dict = top.dict;
    if (dict.cidRegistry === NO_SID) fail(FontErrorCode.UnimplementedFeature);
    const charstringsAt = (base + dict.charstringsOffset) >>> 0;
    seek(size, charstringsAt);
    const charstrings = (this.charstrings = new Index(data, charstringsAt, false));
    const fdArrayAt = (base + dict.fdArrayOffset) >>> 0;
    seek(size, fdArrayAt);
    const fdArray = new Index(data, fdArrayAt, false);
    if (fdArray.count <= MAX_CID_FONTS) {
      for (let i = 0; i < fdArray.count; i++)
        this.subfonts.push(this.loadSubfont(fdArray, i, base));
      // CFF_Load_FD_Select
      const at = (base + dict.fdSelectOffset) >>> 0;
      seek(size, at);
      need(size, at, 1);
      this.fdFormat = data[at]!;
      if (this.fdFormat === 0) {
        this.fdData = at + 1;
        this.fdSize = charstrings.count;
      } else if (this.fdFormat === 3) {
        need(size, at + 1, 2);
        this.fdData = at + 3;
        this.fdSize = ((data[at + 1]! << 8) | data[at + 2]!) * 3 + 2;
      } else fail(FontErrorCode.InvalidFileFormat);
      need(size, this.fdData, this.fdSize);
    }
    if (dict.charstringsOffset === 0) fail(FontErrorCode.UnknownFileFormat);
    this.numGlyphs = charstrings.count;
    this.globals = globals.pointers();
    this.numGlobals = globals.count;
    if (this.numGlyphs > 0) this.checkCharset(base + dict.charsetOffset, dict.charsetOffset);

    // cff_face_init: units per EM and the normalized font matrices.
    if (!dict.hasFontMatrix) dict.unitsPerEm = sfnt.unitsPerEm;
    normalize(dict);
    for (let i = this.subfonts.length; i > 0; i--) {
      const sub = this.subfonts[i - 1]!.dict;
      if (sub.hasFontMatrix) {
        if (dict.hasFontMatrix) {
          const scaling =
            dict.unitsPerEm > 1 && sub.unitsPerEm > 1
              ? Math.min(dict.unitsPerEm, sub.unitsPerEm)
              : 1;
          multiplyScaled(dict.matrix, sub.matrix, scaling);
          transformScaled(sub.offset, 0, dict.matrix, scaling);
          sub.unitsPerEm = mulDiv(sub.unitsPerEm | 0, dict.unitsPerEm | 0, scaling) >>> 0;
        }
      } else {
        sub.matrix = {...dict.matrix};
        sub.offset.set(dict.offset);
        sub.unitsPerEm = dict.unitsPerEm;
      }
      normalize(sub);
    }
  }

  /** `cff_subfont_load`. */
  private loadSubfont(index: Index, fontIndex: number, base: number): SubFont {
    const data = this.data,
      dict = newDict(),
      font: SubFont = {dict, locals: null, numLocals: 0};
    const [start, end] = index.element(fontIndex);
    parseDict(data, start, end, Code.Top, dict);
    if (dict.cidRegistry !== NO_SID) return font;
    if (dict.privateOffset && dict.privateSize) {
      const at = (base + dict.privateOffset) >>> 0;
      seek(data.length, at);
      need(data.length, at, dict.privateSize);
      parseDict(data, at, at + dict.privateSize, Code.Private, dict);
    }
    if (dict.localSubrsOffset) {
      const at = (base + dict.privateOffset + dict.localSubrsOffset) >>> 0;
      seek(data.length, at);
      const subrs = new Index(data, at, true);
      font.locals = subrs.pointers();
      font.numLocals = subrs.count;
    }
    return font;
  }

  /** The stream checks of `cff_charset_load` (the SIDs themselves are unused). */
  private checkCharset(at: number, offset: number): void {
    const data = this.data,
      size = data.length,
      n = this.numGlyphs;
    if (offset > 2) {
      at >>>= 0;
      seek(size, at);
      need(size, at, 1);
      const format = data[at]!;
      let p = at + 1;
      if (format === 0) need(size, p, (n - 1) * 2);
      else if (format === 1 || format === 2) {
        for (let j = 1; j < n;) {
          need(size, p, 2);
          const sid = (data[p]! << 8) | data[p + 1]!;
          p += 2;
          let left: number;
          if (format === 2) {
            need(size, p, 2);
            left = (data[p]! << 8) | data[p + 1]!;
            p += 2;
          } else {
            need(size, p, 1);
            left = data[p++]!;
          }
          if (sid > 0xffff - left) left = 0xffff - sid;
          j += Math.min(left + 1, n - j);
        }
      } else fail(FontErrorCode.InvalidFileFormat);
    } else if (n > [229, 166, 87][offset]!) fail(FontErrorCode.InvalidFileFormat);
  }

  /** `cff_fd_select_get`. */
  private fdSelect(glyph: number): number {
    const d = this.data;
    if (this.fdFormat === 0) return d[this.fdData + glyph]!;
    if (this.fdFormat !== 3) return 0;
    if ((glyph - this.fdCacheFirst) >>> 0 < this.fdCacheCount) return this.fdCacheFd;
    let p = this.fdData;
    const limit = p + this.fdSize;
    let first = ((d[p] ?? 0) << 8) | (d[p + 1] ?? 0);
    p += 2;
    do {
      if (glyph < first) break;
      const fd = d[p++] ?? 0;
      const next = ((d[p] ?? 0) << 8) | (d[p + 1] ?? 0);
      p += 2;
      if (glyph < next) {
        this.fdCacheFirst = first;
        this.fdCacheCount = next - first;
        this.fdCacheFd = fd;
        return fd;
      }
      first = next;
    } while (p < limit);
    return 0;
  }

  /** The size's 16.16 scales (`FT_Size_Metrics.x_scale`/`y_scale`). */
  setScale(xScale: number, yScale: number): void {
    this.xScale = xScale;
    this.yScale = yScale;
  }

  /** `cff_slot_load` without hinting into `outline` (26.6); returns the advance. */
  load(outline: Outline, index: number): number {
    if (index >= this.numGlyphs) fail(FontErrorCode.InvalidArgument);
    let xScale = this.xScale,
      yScale = this.yScale,
      font = this.top;
    const n = this.subfonts.length;
    if (n) {
      let fd = this.fdSelect(index);
      if (fd >= n) fd = n - 1;
      font = this.subfonts[fd]!;
      const topUpm = this.top.dict.unitsPerEm,
        subUpm = font.dict.unitsPerEm;
      if (topUpm !== subUpm) {
        xScale = mulDiv(xScale, topUpm | 0, subUpm | 0);
        yScale = mulDiv(yScale, topUpm | 0, subUpm | 0);
      }
    }
    const {matrix, offset} = font.dict;
    outline.reset();
    const [start, end] = this.charstrings.element(index);
    // cff_decoder_prepare
    let locals = this.top;
    if (n) {
      const fd = this.fdSelect(index);
      if (fd >= n) fail(FontErrorCode.InvalidFileFormat);
      locals = this.subfonts[fd]!;
    }
    let width = this.parse(outline, start, end, locals);
    const v = outline.points,
      count = outline.nPoints;
    if (!(matrix.xx === 0x10000 && matrix.yy === 0x10000 && matrix.xy === 0 && matrix.yx === 0))
      for (let i = 0; i < count; i++) transform(v, i * 2, matrix);
    outline.translate(offset[0]!, offset[1]!);
    width = (mulFix(width, matrix.xx) + offset[0]!) | 0;
    for (let i = 0; i < count * 2; i += 2) {
      v[i] = mulFix(v[i]!, xScale);
      v[i + 1] = mulFix(v[i + 1]!, yScale);
    }
    return mulFix(width, xScale);
  }

  /** `cff_decoder_parse_charstrings` without a hinter; returns the glyph width in font units.
   * The outline stays empty unless `endchar` is reached.
   */
  private parse(o: Outline, start: number, end: number, font: SubFont): number {
    const d = this.data,
      s = this.stack,
      buildchar = this.buildchar,
      zoneCursor = this.zoneCursor,
      zoneLimit = this.zoneLimit,
      charstringType = this.top.dict.charstringType,
      locals = font.locals,
      numLocals = font.numLocals,
      localsBias = subrsBias(charstringType, numLocals),
      globals = this.globals,
      numGlobals = this.numGlobals,
      globalsBias = subrsBias(charstringType, numGlobals),
      nominalWidth = font.dict.nominalWidth;
    s.fill(0);
    buildchar.fill(0);
    let glyphWidth = font.dict.defaultWidth,
      numHints = 0,
      readWidth = true,
      seed = RANDOM_SEED,
      pathBegun = false,
      x = 0,
      y = 0,
      top = STACK_BASE,
      zone = 0,
      ip = start,
      limit = end;
    zoneLimit[0] = end;
    const startPoint = (): void => {
      if (!pathBegun) {
        pathBegun = true;
        addContour(o);
        o.reserve(1, 0);
        addPoint(o, x, y, true);
      }
    };
    while (ip < limit) {
      let v = d[ip++]!;
      if (v >= 32 || v === 28) {
        let shift = 16,
          val: number;
        if (v === 28) {
          if (ip + 1 >= limit) fail(FontErrorCode.InvalidFileFormat);
          val = (((d[ip]! << 8) | d[ip + 1]!) << 16) >> 16;
          ip += 2;
        } else if (v < 247) val = v - 139;
        else if (v < 251) {
          if (ip >= limit) fail(FontErrorCode.InvalidFileFormat);
          val = (v - 247) * 256 + d[ip++]! + 108;
        } else if (v < 255) {
          if (ip >= limit) fail(FontErrorCode.InvalidFileFormat);
          val = -(v - 251) * 256 - d[ip++]! - 108;
        } else {
          if (ip + 3 >= limit) fail(FontErrorCode.InvalidFileFormat);
          val = (d[ip]! << 24) | (d[ip + 1]! << 16) | (d[ip + 2]! << 8) | d[ip + 3]!;
          ip += 4;
          if (charstringType === 2) shift = 0;
        }
        if (top - STACK_BASE >= MAX_OPERANDS) fail(FontErrorCode.StackOverflow);
        s[top++] = val << shift;
        continue;
      }
      let op: Op;
      if (v === 12) {
        if (ip >= limit) fail(FontErrorCode.InvalidFileFormat);
        v = d[ip++]!;
        op = ESCAPE_OPS[v]!;
      } else op = OPS[v]!;
      if (op === Op.Unknown) continue;
      let args = top,
        numArgs = top - STACK_BASE,
        req = ARGUMENT_COUNTS[op]!;
      if (req & CHECK_WIDTH) {
        if (numArgs > 0 && readWidth) {
          let ok: boolean;
          switch (op) {
            case Op.Hmoveto:
            case Op.Vmoveto:
              ok = (numArgs & 2) !== 0;
              break;
            case Op.Endchar:
              ok = numArgs === 5 || numArgs === 1;
              break;
            default:
              ok = (numArgs & 1) !== 0;
          }
          if (ok) {
            glyphWidth = (nominalWidth + (s[STACK_BASE]! >> 16)) | 0;
            numArgs--;
          }
        }
        readWidth = false;
        req = 0;
      }
      req &= 0xf;
      if (numArgs < req) fail(FontErrorCode.TooFewArguments);
      args -= req;
      numArgs -= req;
      switch (op) {
        case Op.Hstem:
        case Op.Vstem:
        case Op.Hstemhm:
        case Op.Vstemhm:
          numHints += numArgs >> 1;
          args = STACK_BASE;
          break;
        case Op.Hintmask:
        case Op.Cntrmask:
          if (numArgs > 0) numHints += numArgs >> 1;
          if (ip + ((numHints + 7) >> 3) >= limit) fail(FontErrorCode.InvalidFileFormat);
          ip += (numHints + 7) >> 3;
          args = STACK_BASE;
          break;
        case Op.Rmoveto:
          closeContour(o);
          pathBegun = false;
          x = (x + s[args - 2]!) | 0;
          y = (y + s[args - 1]!) | 0;
          args = STACK_BASE;
          break;
        case Op.Vmoveto:
          closeContour(o);
          pathBegun = false;
          y = (y + s[args - 1]!) | 0;
          args = STACK_BASE;
          break;
        case Op.Hmoveto:
          closeContour(o);
          pathBegun = false;
          x = (x + s[args - 1]!) | 0;
          args = STACK_BASE;
          break;
        case Op.Rlineto:
          startPoint();
          o.reserve(numArgs >> 1, 0);
          if (numArgs < 2) fail(FontErrorCode.TooFewArguments);
          args -= numArgs & ~1;
          while (args < top) {
            x = (x + s[args]!) | 0;
            y = (y + s[args + 1]!) | 0;
            addPoint(o, x, y, true);
            args += 2;
          }
          args = STACK_BASE;
          break;
        case Op.Hlineto:
        case Op.Vlineto: {
          let phase = op === Op.Hlineto;
          if (numArgs === 0) break;
          startPoint();
          o.reserve(numArgs, 0);
          args = STACK_BASE;
          while (args < top) {
            if (phase) x = (x + s[args]!) | 0;
            else y = (y + s[args]!) | 0;
            o.reserve(1, 0);
            addPoint(o, x, y, true);
            args++;
            phase = !phase;
          }
          args = STACK_BASE;
          break;
        }
        case Op.Rrcurveto: {
          if (numArgs < 6) fail(FontErrorCode.TooFewArguments);
          const nargs = numArgs - (numArgs % 6);
          startPoint();
          o.reserve(nargs >> 1, 0);
          args -= nargs;
          while (args < top) {
            x = (x + s[args]!) | 0;
            y = (y + s[args + 1]!) | 0;
            addPoint(o, x, y, false);
            x = (x + s[args + 2]!) | 0;
            y = (y + s[args + 3]!) | 0;
            addPoint(o, x, y, false);
            x = (x + s[args + 4]!) | 0;
            y = (y + s[args + 5]!) | 0;
            addPoint(o, x, y, true);
            args += 6;
          }
          args = STACK_BASE;
          break;
        }
        case Op.Vvcurveto:
        case Op.Hhcurveto: {
          if (numArgs < 4) fail(FontErrorCode.TooFewArguments);
          let nargs = numArgs - (numArgs % 4);
          if (numArgs - nargs > 0) nargs += 1;
          startPoint();
          args -= nargs;
          const vertical = op === Op.Vvcurveto;
          if (nargs & 1) {
            if (vertical) x = (x + s[args]!) | 0;
            else y = (y + s[args]!) | 0;
            args++;
            nargs--;
          }
          o.reserve(3 * (nargs >> 2), 0);
          while (args < top) {
            if (vertical) y = (y + s[args]!) | 0;
            else x = (x + s[args]!) | 0;
            addPoint(o, x, y, false);
            x = (x + s[args + 1]!) | 0;
            y = (y + s[args + 2]!) | 0;
            addPoint(o, x, y, false);
            if (vertical) y = (y + s[args + 3]!) | 0;
            else x = (x + s[args + 3]!) | 0;
            addPoint(o, x, y, true);
            args += 4;
          }
          args = STACK_BASE;
          break;
        }
        case Op.Vhcurveto:
        case Op.Hvcurveto: {
          startPoint();
          if (numArgs < 4) fail(FontErrorCode.TooFewArguments);
          let nargs = numArgs - (numArgs % 4);
          if (numArgs - nargs > 0) nargs += 1;
          args -= nargs;
          try {
            o.reserve((nargs >> 2) * 3, 0);
          } catch {
            fail(FontErrorCode.TooFewArguments);
          }
          let phase = op === Op.Hvcurveto;
          while (nargs >= 4) {
            nargs -= 4;
            if (phase) {
              x = (x + s[args]!) | 0;
              addPoint(o, x, y, false);
              x = (x + s[args + 1]!) | 0;
              y = (y + s[args + 2]!) | 0;
              addPoint(o, x, y, false);
              y = (y + s[args + 3]!) | 0;
              if (nargs === 1) x = (x + s[args + 4]!) | 0;
              addPoint(o, x, y, true);
            } else {
              y = (y + s[args]!) | 0;
              addPoint(o, x, y, false);
              x = (x + s[args + 1]!) | 0;
              y = (y + s[args + 2]!) | 0;
              addPoint(o, x, y, false);
              x = (x + s[args + 3]!) | 0;
              if (nargs === 1) y = (y + s[args + 4]!) | 0;
              addPoint(o, x, y, true);
            }
            args += 4;
            phase = !phase;
          }
          args = STACK_BASE;
          break;
        }
        case Op.Rlinecurve: {
          if (numArgs < 8) fail(FontErrorCode.TooFewArguments);
          const nargs = numArgs & ~1;
          let lines = (nargs - 6) >> 1;
          startPoint();
          o.reserve(lines + 3, 0);
          args -= nargs;
          for (; lines > 0; lines--) {
            x = (x + s[args]!) | 0;
            y = (y + s[args + 1]!) | 0;
            addPoint(o, x, y, true);
            args += 2;
          }
          x = (x + s[args]!) | 0;
          y = (y + s[args + 1]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 2]!) | 0;
          y = (y + s[args + 3]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 4]!) | 0;
          y = (y + s[args + 5]!) | 0;
          addPoint(o, x, y, true);
          args = STACK_BASE;
          break;
        }
        case Op.Rcurveline: {
          if (numArgs < 8) fail(FontErrorCode.TooFewArguments);
          let nargs = numArgs - 2;
          nargs = nargs - (nargs % 6) + 2;
          let curves = ((nargs - 2) / 6) | 0;
          startPoint();
          o.reserve(curves * 3 + 2, 0);
          args -= nargs;
          for (; curves > 0; curves--) {
            x = (x + s[args]!) | 0;
            y = (y + s[args + 1]!) | 0;
            addPoint(o, x, y, false);
            x = (x + s[args + 2]!) | 0;
            y = (y + s[args + 3]!) | 0;
            addPoint(o, x, y, false);
            x = (x + s[args + 4]!) | 0;
            y = (y + s[args + 5]!) | 0;
            addPoint(o, x, y, true);
            args += 6;
          }
          x = (x + s[args]!) | 0;
          y = (y + s[args + 1]!) | 0;
          addPoint(o, x, y, true);
          args = STACK_BASE;
          break;
        }
        case Op.Hflex1: {
          startPoint();
          o.reserve(6, 0);
          const startY = y;
          x = (x + s[args]!) | 0;
          y = (y + s[args + 1]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 2]!) | 0;
          y = (y + s[args + 3]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 4]!) | 0;
          addPoint(o, x, y, true);
          x = (x + s[args + 5]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 6]!) | 0;
          y = (y + s[args + 7]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 8]!) | 0;
          y = startY;
          addPoint(o, x, y, true);
          args = STACK_BASE;
          break;
        }
        case Op.Hflex: {
          startPoint();
          o.reserve(6, 0);
          const startY = y;
          x = (x + s[args]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 1]!) | 0;
          y = (y + s[args + 2]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 3]!) | 0;
          addPoint(o, x, y, true);
          x = (x + s[args + 4]!) | 0;
          addPoint(o, x, y, false);
          x = (x + s[args + 5]!) | 0;
          y = startY;
          addPoint(o, x, y, false);
          x = (x + s[args + 6]!) | 0;
          addPoint(o, x, y, true);
          args = STACK_BASE;
          break;
        }
        case Op.Flex1: {
          startPoint();
          o.reserve(6, 0);
          const startX = x,
            startY = y;
          let dx = 0,
            dy = 0;
          for (let i = 0; i < 10; i += 2) {
            dx = (dx + s[args + i]!) | 0;
            dy = (dy + s[args + i + 1]!) | 0;
          }
          if (dx < 0) dx = -dx | 0;
          if (dy < 0) dy = -dy | 0;
          const horizontal = dx > dy;
          for (let count = 5; count > 0; count--) {
            x = (x + s[args]!) | 0;
            y = (y + s[args + 1]!) | 0;
            addPoint(o, x, y, count === 3);
            args += 2;
          }
          if (horizontal) {
            x = (x + s[args]!) | 0;
            y = startY;
          } else {
            x = startX;
            y = (y + s[args]!) | 0;
          }
          addPoint(o, x, y, true);
          args = STACK_BASE;
          break;
        }
        case Op.Flex:
          startPoint();
          o.reserve(6, 0);
          for (let count = 6; count > 0; count--) {
            x = (x + s[args]!) | 0;
            y = (y + s[args + 1]!) | 0;
            addPoint(o, x, y, count === 4 || count === 1);
            args += 2;
          }
          args = STACK_BASE;
          break;
        case Op.Seac:
          return fail(FontErrorCode.UnimplementedFeature);
        case Op.Endchar:
          if (numArgs >= 4) fail(FontErrorCode.UnimplementedFeature);
          closeContour(o);
          return glyphWidth;
        case Op.Abs:
          if (s[args]! < 0) s[args] = -s[args]!;
          args++;
          break;
        case Op.Add:
          s[args] = s[args]! + s[args + 1]!;
          args++;
          break;
        case Op.Sub:
          s[args] = s[args]! - s[args + 1]!;
          args++;
          break;
        case Op.Div:
          s[args] = divFix(s[args]!, s[args + 1]!);
          args++;
          break;
        case Op.Neg:
          s[args] = -s[args]!;
          args++;
          break;
        case Op.Random:
          s[args] = seed >= 0x8000 ? seed + 1 : seed;
          seed = mulFix(seed, 0x10000 - seed);
          if (seed === 0) seed += 0x2873;
          args++;
          break;
        case Op.Mul:
          s[args] = mulFix(s[args]!, s[args + 1]!);
          args++;
          break;
        case Op.Sqrt:
          if (s[args]! > 0) {
            const value = s[args]!;
            let root = value,
              next = root;
            for (let i = 0; i < SQRT_ITERATIONS; i++) {
              next = (root + divFix(value, root) + 1) >> 1;
              if (next === root) break;
              root = next;
            }
            s[args] = next;
          } else s[args] = 0;
          args++;
          break;
        case Op.Drop:
          break;
        case Op.Exch: {
          const tmp = s[args]!;
          s[args] = s[args + 1]!;
          s[args + 1] = tmp;
          args += 2;
          break;
        }
        case Op.Index: {
          let idx = s[args]! >> 16;
          if (idx < 0) idx = 0;
          else if (idx > numArgs - 2) idx = numArgs - 2;
          s[args] = s[args - (idx + 1)]!;
          args++;
          break;
        }
        case Op.Roll: {
          let count = s[args]! >> 16,
            idx = s[args + 1]! >> 16;
          if (count <= 0) count = 1;
          args -= count;
          if (args < STACK_BASE) fail(FontErrorCode.TooFewArguments);
          for (; idx > 0; idx--) {
            const tmp = s[args + count - 1]!;
            s.copyWithin(args + 1, args, args + count - 1);
            s[args] = tmp;
          }
          for (; idx < 0; idx++) {
            const tmp = s[args]!;
            s.copyWithin(args, args + 1, args + count);
            s[args + count - 1] = tmp;
          }
          args += count;
          break;
        }
        case Op.Dup:
          s[args + 1] = s[args]!;
          args += 2;
          break;
        case Op.Put: {
          const idx = s[args + 1]! >> 16;
          if (idx >= 0 && idx < MAX_TRANS_ELEMENTS) buildchar[idx] = s[args]!;
          break;
        }
        case Op.Get: {
          const idx = s[args]! >> 16;
          s[args] = idx >= 0 && idx < MAX_TRANS_ELEMENTS ? buildchar[idx]! : 0;
          args++;
          break;
        }
        case Op.Dotsection:
          break;
        case Op.Closepath:
          args = STACK_BASE;
          break;
        case Op.Hsbw:
          glyphWidth = (nominalWidth + (s[args + 1]! >> 16)) | 0;
          x = s[args]!;
          y = 0;
          args = STACK_BASE;
          break;
        case Op.Sbw:
          glyphWidth = (nominalWidth + (s[args + 2]! >> 16)) | 0;
          x = s[args]!;
          y = s[args + 1]!;
          args = STACK_BASE;
          break;
        case Op.Setcurrentpoint:
          x = s[args]!;
          y = s[args + 1]!;
          args = STACK_BASE;
          break;
        case Op.Callothersubr:
          args -= 2 + (s[args - 2]! >> 16);
          if (args < STACK_BASE) fail(FontErrorCode.TooFewArguments);
          break;
        case Op.Pop:
          args++;
          break;
        case Op.And:
          s[args] = s[args] && s[args + 1] ? 0x10000 : 0;
          args++;
          break;
        case Op.Or:
          s[args] = s[args] || s[args + 1] ? 0x10000 : 0;
          args++;
          break;
        case Op.Eq:
          s[args] = !s[args] ? 0x10000 : 0;
          args++;
          break;
        case Op.Ifelse:
          if (!(s[args + 2]! <= s[args + 3]!)) s[args] = s[args + 1]!;
          args++;
          break;
        case Op.Callsubr:
        case Op.Callgsubr: {
          const local = op === Op.Callsubr;
          const idx = ((s[args]! >> 16) + (local ? localsBias : globalsBias)) >>> 0;
          if (idx >= (local ? numLocals : numGlobals)) fail(FontErrorCode.InvalidFileFormat);
          if (zone >= MAX_SUBRS_CALLS) fail(FontErrorCode.InvalidFileFormat);
          const table = (local ? locals : globals)!;
          zoneCursor[zone] = ip;
          zone++;
          ip = table[idx]!;
          limit = zoneLimit[zone] = table[idx + 1]!;
          if (limit === ip) fail(FontErrorCode.InvalidFileFormat);
          break;
        }
        case Op.Return:
          if (zone <= 0) fail(FontErrorCode.InvalidFileFormat);
          zone--;
          ip = zoneCursor[zone]!;
          limit = zoneLimit[zone]!;
          break;
        default:
          fail(FontErrorCode.UnimplementedFeature);
      }
      top = args;
      if (top - STACK_BASE >= MAX_OPERANDS) fail(FontErrorCode.StackOverflow);
    }
    o.reset();
    return glyphWidth;
  }
}

/** Divides a font matrix, offset and units per EM by |yy| and drops the offset's fraction. */
function normalize(dict: FontDict): void {
  const m = dict.matrix,
    o = dict.offset,
    temp = m.yy < 0 ? -m.yy | 0 : m.yy;
  if (temp !== 0x10000) {
    dict.unitsPerEm = divFix(dict.unitsPerEm | 0, temp) >>> 0;
    m.xx = divFix(m.xx, temp);
    m.yx = divFix(m.yx, temp);
    m.xy = divFix(m.xy, temp);
    m.yy = divFix(m.yy, temp);
    o[0] = divFix(o[0]!, temp);
    o[1] = divFix(o[1]!, temp);
  }
  o[0] = o[0]! >> 16;
  o[1] = o[1]! >> 16;
}
