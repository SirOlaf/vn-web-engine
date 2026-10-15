import {isTjsAlpha, isTjsDigit, isTjsSpace, parseNumber} from './literals.js';

/** TJS version reported by the preprocessor value `version` (`TJSVersionHex`). */
export function tjsVersionHex(major: number, minor: number, release: number): number {
  return major * 0x1000000 + minor * 0x10000 + release;
}

/**
 * Conditional-compilation values (`tTJS::PPValues`). They belong to the script engine, not to
 * a script block: `@set` in one file is visible to every file compiled after it.
 */
export class PreprocessorValues {
  readonly #values = new Map<string, number>();

  constructor(initial: Iterable<[string, number]> = []) {
    for (const [name, value] of initial) this.set(name, value);
  }

  set(name: string, value: number): void {
    this.#values.set(name, value | 0);
  }

  /** Undefined names read as 0. */
  get(name: string): number {
    return this.#values.get(name) ?? 0;
  }

  entries(): IterableIterator<[string, number]> {
    return this.#values.entries();
  }
}

export class PreprocessorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreprocessorError';
  }
}

/**
 * Evaluates a `@set` / `@if` expression (`tjspp.y`): 32-bit integers, names, `=` assignment,
 * C operators without bitwise not or shifts, comma. Division by zero is an error.
 */
export function evaluatePreprocessorExpression(text: string, values: PreprocessorValues): number {
  const tokens = tokenize(text);
  let i = 0;
  const peek = () => tokens[i];
  const fail = (): never => {
    throw new PreprocessorError(`Invalid preprocessor expression: ${text}`);
  };

  // Precedence from the grammar, lowest first; all binary operators are left-associative.
  const levels: readonly (readonly string[])[] = [
    [','],
    ['||'],
    ['&&'],
    ['|'],
    ['^'],
    ['&'],
    ['='],
    ['!=', '=='],
    ['<', '>', '<=', '>='],
    ['+', '-'],
    ['%', '/', '*'],
  ];
  const ASSIGN_LEVEL = 6;

  const binary = (op: string, a: number, b: number): number => {
    switch (op) {
      case ',':
        return b;
      case '||':
        return a || b ? 1 : 0;
      case '&&':
        return a && b ? 1 : 0;
      case '|':
        return a | b;
      case '^':
        return a ^ b;
      case '&':
        return a & b;
      case '!=':
        return a !== b ? 1 : 0;
      case '==':
        return a === b ? 1 : 0;
      case '<':
        return a < b ? 1 : 0;
      case '>':
        return a > b ? 1 : 0;
      case '<=':
        return a <= b ? 1 : 0;
      case '>=':
        return a >= b ? 1 : 0;
      case '+':
        return (a + b) | 0;
      case '-':
        return (a - b) | 0;
      case '*':
        return Math.imul(a, b);
      case '/':
        if (b === 0) fail();
        return (a / b) | 0;
      case '%':
        if (b === 0) fail();
        return (a % b) | 0;
    }
    return fail();
  };

  const expr = (level: number): number => {
    if (level === levels.length) return unary();
    let left: number;
    const t = peek();
    // `name = expr` is a primary form at the `=` level; its right side binds tighter operators.
    if (level === ASSIGN_LEVEL && t?.kind === 'name' && tokens[i + 1]?.text === '=') {
      i += 2;
      left = expr(ASSIGN_LEVEL);
      values.set(t.text, left);
    } else {
      left = expr(level + 1);
    }
    for (;;) {
      const op = peek();
      if (op?.kind !== 'op' || !levels[level]!.includes(op.text) || op.text === '=') return left;
      i++;
      left = binary(op.text, left, expr(level + 1));
    }
  };

  const unary = (): number => {
    const t = tokens[i++] ?? fail();
    if (t.kind === 'num') return t.value;
    if (t.kind === 'name') return values.get(t.text);
    switch (t.text) {
      case '!':
        return unary() ? 0 : 1;
      case '+':
        return unary();
      case '-':
        return -unary() | 0;
      case '(': {
        const v = expr(0);
        if (tokens[i++]?.text !== ')') fail();
        return v;
      }
    }
    return fail();
  };

  const result = expr(0);
  if (i !== tokens.length) fail();
  return result;
}

type PpToken =
  | {kind: 'num'; value: number; text: string}
  | {kind: 'name'; text: string}
  | {kind: 'op'; text: string};

function tokenize(text: string): PpToken[] {
  const out: PpToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (isTjsSpace(c)) {
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['==', '!=', '||', '&&', '<=', '>='].includes(two)) {
      out.push({kind: 'op', text: two});
      i += 2;
      continue;
    }
    if ('(),=!|&^+-*/%<>'.includes(text[i]!)) {
      out.push({kind: 'op', text: text[i]!});
      i++;
      continue;
    }
    if (isTjsDigit(c)) {
      const r = parseNumber(text, i);
      if (!r) throw new PreprocessorError(`Invalid number in preprocessor expression: ${text}`);
      const v =
        r.value.type === 'int'
          ? Number(BigInt.asIntN(32, r.value.value))
          : Math.trunc(r.value.value) | 0;
      out.push({kind: 'num', value: v, text: text.slice(i, r.end)});
      i = r.end;
      continue;
    }
    if (!isTjsAlpha(c) && c !== 0x5f)
      throw new PreprocessorError(`Invalid character in preprocessor expression: ${text}`);
    const s = i;
    while (
      i < text.length &&
      (isTjsAlpha(text.charCodeAt(i)) || isTjsDigit(text.charCodeAt(i)) || text[i] === '_')
    )
      i++;
    out.push({kind: 'name', text: text.slice(s, i)});
  }
  return out;
}
