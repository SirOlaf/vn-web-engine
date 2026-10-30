/** CCompute expression evaluator 0x140157ff0 with CVariant values (vtable 0x140368fd8).
 * Inputs and results are byte strings; the code page global 0x140485434 is 2 (UTF-8)
 * and the only quote character is "'" (0x1400afd90 from script initialization).
 */
export type ArtemisExpressionValue =
  | {readonly kind: 'integer'; readonly value: number}
  | {readonly kind: 'string'; readonly bytes: Uint8Array};

export interface ArtemisExpressionVariables {
  /** Variable leaf 0x140157fa0: an absent name is created as integer zero. */
  expressionValue(name: string): ArtemisExpressionValue;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const QUOTE = 0x27;
const MUL = 0x4,
  DIV = 0x8,
  MOD = 0x10,
  ADD = 0x20,
  SUB = 0x40,
  LT = 0x200,
  GT = 0x400,
  LE = 0x800,
  GE = 0x1000,
  EQ = 0x2000,
  NE = 0x4000,
  AND = 0x40000,
  OR = 0x80000;
/** Flags whose spelling has two characters (mask 0x1fec7983). */
const TWO_CHARACTER = 0x1fec7983;

const isSpace = (byte: number) => byte === 9 || byte === 10 || byte === 13 || byte === 32;
const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const isHexLetter = (byte: number) =>
  (byte >= 0x61 && byte <= 0x66) || (byte >= 0x41 && byte <= 0x46);

/** Operator table 0x1401593a0: the second character selects the two-character forms. */
function operator(bytes: Uint8Array, index: number): number {
  const first = bytes[index] ?? 0,
    second = bytes[index + 1] ?? 0;
  if (second === 0x26) return first === 0x26 ? AND : 0;
  if (second === 0x3d)
    return first === 0x21
      ? NE
      : first === 0x3c
        ? LE
        : first === 0x3d
          ? EQ
          : first === 0x3e
            ? GE
            : 0;
  if (second === 0x7c) return first === 0x7c ? OR : 0;
  switch (first) {
    case 0x25:
      return MOD;
    case 0x2a:
      return MUL;
    case 0x2b:
      return ADD;
    case 0x2d:
      return SUB;
    case 0x2f:
      return DIV;
    case 0x3c:
      return LT;
    case 0x3e:
      return GT;
  }
  return 0;
}

const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0;

/** C strto(u)l over a NUL-terminated byte string with a 32-bit Windows long. */
function strto(bytes: Uint8Array, base: number, signed: boolean): number {
  let index = 0;
  while (
    index < bytes.length &&
    (isSpace(at(bytes, index)) || at(bytes, index) === 11 || at(bytes, index) === 12)
  )
    index++;
  let negative = false;
  if (at(bytes, index) === 0x2b || at(bytes, index) === 0x2d)
    negative = at(bytes, index++) === 0x2d;
  if (
    base === 16 &&
    at(bytes, index) === 0x30 &&
    (at(bytes, index + 1) | 0x20) === 0x78 &&
    index + 2 < bytes.length &&
    digit(at(bytes, index + 2)) < 16
  )
    index += 2;
  let value = 0n,
    overflow = false;
  for (; index < bytes.length; index++) {
    const d = digit(at(bytes, index));
    if (d >= base) break;
    value = value * BigInt(base) + BigInt(d);
    if (value > 0xffffffffn) overflow = true;
  }
  if (signed) {
    const limit = negative ? 0x80000000n : 0x7fffffffn;
    if (overflow || value > limit) return negative ? -0x80000000 : 0x7fffffff;
    return Number(negative ? -value : value) | 0;
  }
  if (overflow) return -1;
  return Number(BigInt.asIntN(32, negative ? -value : value));
}
function digit(byte: number): number {
  if (isDigit(byte)) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x7a) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x37;
  return 99;
}
function cString(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
}

/** CVariant toInt 0x1400af4c0: strings use strtoul, base 16 only after a leading 0x/0X. */
export function artemisVariantInteger(value: ArtemisExpressionValue): number {
  if (value.kind === 'integer') return value.value;
  const bytes = cString(value.bytes);
  const hex = at(bytes, 0) === 0x30 && (at(bytes, 1) === 0x58 || at(bytes, 1) === 0x78);
  return strto(bytes, hex ? 16 : 10, false);
}
/** CVariant toString 0x1400af400: integers use signed decimal formatting. */
export function artemisVariantBytes(value: ArtemisExpressionValue): Uint8Array {
  return value.kind === 'string' ? value.bytes : encoder.encode(String(value.value));
}
/** CVariant isNumeric 0x1400af5d0. */
function numeric(value: ArtemisExpressionValue): boolean {
  if (value.kind === 'integer') return true;
  if (!value.bytes.length) return false;
  const bytes = cString(value.bytes);
  let index = 0,
    hex = false;
  if (bytes.length >= 2 && at(bytes, 0) === 0x30 && (at(bytes, 1) | 0x20) === 0x78) {
    index = 2;
    hex = true;
  } else if (at(bytes, 0) === 0x2d) index = 1;
  for (; index < bytes.length; index++)
    if (!isDigit(at(bytes, index)) && !(hex && isHexLetter(at(bytes, index)))) return false;
  return true;
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const integer = (value: number): ArtemisExpressionValue => ({kind: 'integer', value: value | 0});

type Node = {readonly operator: number} | {value: ArtemisExpressionValue | null};
class Failure extends Error {}

class Parser {
  index = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly variables: ArtemisExpressionVariables,
  ) {}
  private byte(index = this.index): number {
    return this.bytes[index] ?? 0;
  }
  private variable(name: Uint8Array): ArtemisExpressionValue {
    let text: string;
    try {
      text = decoder.decode(name);
    } catch {
      throw new Error('Unsupported Artemis expression variable name encoding');
    }
    return this.variables.expressionValue(text);
  }
  /** One parenthesis level of 0x140157ff0; returns null where the native returns no node. */
  level(): ArtemisExpressionValue | null {
    const nodes: Node[] = [];
    const lastIsOperator = () => {
      const last = nodes.at(-1);
      return !last || 'operator' in last;
    };
    const requireOperator = () => {
      if (!lastIsOperator()) throw new Failure();
    };
    let identifier = false,
      start = 0,
      prefix: Uint8Array = new Uint8Array();
    const name = (end: number) => concat(prefix, this.bytes.subarray(start, end));
    scan: while (this.byte() !== 0) {
      const byte = this.byte();
      if (identifier) {
        if (isSpace(byte)) {
          requireOperator();
          nodes.push({value: this.variable(name(this.index))});
          identifier = false;
          this.index++;
        } else if (byte === QUOTE) throw new Failure();
        else if (byte === 0x28) {
          prefix = name(this.index);
          this.index++;
          const inner = this.level();
          if (!inner) throw new Failure();
          prefix = concat(prefix, artemisVariantBytes(inner));
          start = this.index;
        } else if (byte === 0x29) {
          requireOperator();
          nodes.push({value: this.variable(name(this.index))});
          this.index++;
          return reduce(nodes);
        } else if (operator(this.bytes, this.index)) {
          requireOperator();
          nodes.push({value: this.variable(name(this.index))});
          identifier = false;
        } else this.index++;
        continue;
      }
      if (isSpace(byte)) this.index++;
      else if (isDigit(byte)) {
        const begin = this.index;
        let base = 10,
          end = begin;
        for (;;) {
          do end++;
          while (isDigit(this.byte(end)) || (base === 16 && isHexLetter(this.byte(end))));
          if (end - begin !== 1 || byte !== 0x30 || (this.byte(end) | 0x20) !== 0x78) break;
          base = 16;
        }
        this.index = end;
        let negate = false;
        if (nodes.length) {
          const last = nodes.at(-1)!,
            previous = nodes.at(-2);
          if (!('operator' in last)) throw new Failure();
          if (!previous || 'operator' in previous) {
            if (last.operator & SUB) negate = true;
            else if (!(last.operator & ADD)) throw new Failure();
            nodes.pop();
          }
        }
        const value = strto(this.bytes.subarray(begin, end), base, true);
        nodes.push({value: integer(negate ? -value : value)});
      } else if (byte === QUOTE) {
        const parts: Uint8Array[] = [];
        let segment = ++this.index;
        while (this.byte() !== 0) {
          const current = this.byte();
          if (current >= 0x80) {
            // Lead-byte length from the native sign-extended bit scan (0x40, 0x20, ...).
            let extra = 0;
            for (let bit = 0x40; bit && current & bit; bit >>= 1) extra++;
            this.index = Math.min(this.index + extra, this.bytes.length - 1);
          } else if (current === 0x5c) {
            parts.push(this.bytes.subarray(segment, this.index));
            segment = ++this.index;
            if (this.byte() === 0) break;
          } else if (current === QUOTE) {
            requireOperator();
            parts.push(this.bytes.subarray(segment, this.index));
            this.index++;
            nodes.push({value: {kind: 'string', bytes: concat(...parts)}});
            continue scan;
          }
          this.index++;
        }
        // An unterminated string produces no node.
      } else {
        const flags = operator(this.bytes, this.index);
        if (flags) {
          this.index += flags & TWO_CHARACTER ? 2 : 1;
          nodes.push({operator: flags});
        } else if (byte === 0x28) {
          this.index++;
          requireOperator();
          nodes.push({value: this.level()});
        } else if (byte === 0x29) {
          this.index++;
          return reduce(nodes);
        } else {
          identifier = true;
          prefix = new Uint8Array();
          start = this.index++;
        }
      }
    }
    if (identifier) {
      requireOperator();
      nodes.push({value: this.variable(name(this.bytes.length))});
    }
    return reduce(nodes);
  }
}

function reduce(nodes: Node[]): ArtemisExpressionValue | null {
  if (!nodes.length) return null;
  if (nodes.some((node) => 'value' in node && !node.value)) throw new Failure();
  const pass = (
    mask: number,
    apply: (
      flags: number,
      left: ArtemisExpressionValue,
      right: ArtemisExpressionValue,
    ) => ArtemisExpressionValue,
    skipFirst = false,
  ) => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (!('operator' in node) || !(node.operator & mask) || (skipFirst && index === 0)) continue;
      const left = nodes[index - 1],
        right = nodes[index + 1];
      if (!left || !right || !('value' in left) || !('value' in right)) throw new Failure();
      left.value = apply(node.operator, left.value!, right.value!);
      nodes.splice(index, 2);
      index--;
    }
  };
  const int = artemisVariantInteger;
  pass(MUL | DIV | MOD, (flags, left, right) => {
    if (flags & MUL) return integer(Math.imul(int(left), int(right)));
    const divisor = int(right);
    if (!divisor) throw new Failure();
    return integer(flags & DIV ? Math.trunc(int(left) / divisor) : int(left) % divisor);
  });
  pass(
    ADD | SUB,
    (flags, left, right) => {
      if (flags & ADD) {
        if (numeric(left) && numeric(right)) return integer(int(left) + int(right));
        return {
          kind: 'string',
          bytes: concat(artemisVariantBytes(left), artemisVariantBytes(right)),
        };
      }
      return integer(int(left) - int(right));
    },
    true,
  );
  pass(LT | GT | LE | GE, (flags, left, right) => {
    const a = int(left),
      b = int(right);
    return integer(Number(flags & LT ? a < b : flags & GT ? a > b : flags & LE ? a <= b : a >= b));
  });
  pass(EQ | NE, (flags, left, right) => {
    const equal =
      left.kind === 'string' || right.kind === 'string'
        ? sameBytes(artemisVariantBytes(left), artemisVariantBytes(right))
        : int(left) === int(right);
    return integer(Number(flags & EQ ? equal : !equal));
  });
  pass(AND, (_flags, left, right) => integer(Number(int(left) !== 0 && int(right) !== 0)));
  pass(OR, (_flags, left, right) => integer(Number(int(left) !== 0 || int(right) !== 0)));
  const first = nodes[0]!;
  return 'value' in first ? first.value : null;
}

/** Native 0x140157ff0. Returns null where the native evaluator fails. */
export function evaluateArtemisExpression(
  expression: Uint8Array | string,
  variables: ArtemisExpressionVariables,
): ArtemisExpressionValue | null {
  const source = typeof expression === 'string' ? encoder.encode(expression) : expression;
  try {
    return new Parser(cString(source), variables).level();
  } catch (error) {
    if (error instanceof Failure) return null;
    throw error;
  }
}

/** Argument substitution 0x1400afc60: the result bytes, or empty when evaluation fails. */
export function artemisExpressionBytes(
  expression: Uint8Array | string,
  variables: ArtemisExpressionVariables,
): Uint8Array {
  const value = evaluateArtemisExpression(expression, variables);
  return value ? artemisVariantBytes(value) : new Uint8Array();
}
