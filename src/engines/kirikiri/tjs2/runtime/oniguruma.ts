/**
 * Oniguruma regular expressions as TJS2 compiles them (`onig_new` with `ONIG_SYNTAX_PERL`,
 * UTF-16, `ONIG_OPTION_CAPTURE_GROUP | ONIG_OPTION_FIND_NOT_EMPTY`, optionally
 * `ONIG_OPTION_IGNORECASE`), translated to JavaScript regular expressions with the `u` and `d`
 * flags. The reference build links an Oniguruma 5.9-era library.
 *
 * Semantics kept from Oniguruma's Perl syntax where JavaScript differs:
 * - `^` and `$` are `\A` and `\Z` (`ONIG_OPTION_SINGLELINE`); `(?m)` makes them line anchors
 *   (`^` not after a final newline), `(?s)` lets `.` match a newline; `.` excludes only `\n`.
 * - `\d` is `\p{Nd}`, `\w` is alphabetic, mark, decimal number and connector punctuation, `\s`
 *   is Unicode White_Space; `\b` uses that `\w`.
 * - `\A`, `\z`, `\Z`, atomic groups `(?>…)` and possessive `*+ ++ ?+`, `\Q…\E`, `(?#…)`,
 *   option groups `(?imsx-imsx)` and `(?imsx-imsx:…)`, `\xHH`, `\x{…}`, `\0oo`, `\cX`, POSIX
 *   brackets and `\p{…}` properties.
 * - An empty match is never found (`FIND_NOT_EMPTY`): a pattern that can match empty gets a
 *   guard that rejects empty matches by backtracking, as Oniguruma does.
 * - Case-insensitivity applied to part of a pattern expands letters and classes to their case
 *   variants; back-references there compare case-sensitively.
 *
 * Not translated (compile errors): `\G`, nested classes and class set operations (`[a&&b]`,
 * treated as literal characters), named groups (not Perl syntax in this library).
 */
import {TjsError} from './errors.js';

/** A compiled pattern: search returns group offsets in UTF-16 units, -1 when unmatched. */
export class OnigRegex {
  readonly #re: RegExp;
  readonly #groupCount: number;

  constructor(pattern: string, ignoreCase: boolean) {
    const t = translate(pattern, ignoreCase);
    try {
      this.#re = new RegExp(t.source, t.flags);
    } catch (e) {
      throw new TjsError(`invalid pattern: ${(e as Error).message}`);
    }
    this.#groupCount = t.groupCount;
  }

  /** Number of regions of a match (`num_regs`): the groups plus the whole match. */
  get regionCount(): number {
    return this.#groupCount + 1;
  }

  /**
   * `onig_search(str = subject, start = subject)`: the first match, as begin/end pairs per
   * region, or null.
   */
  search(subject: string): number[] | null {
    this.#re.lastIndex = 0;
    const m = this.#re.exec(subject);
    if (!m) return null;
    const indices = m.indices!;
    const out: number[] = [indices[0]![0], indices[0]![1]];
    for (let n = 1; n <= this.#groupCount; n++) {
      const r = indices.groups![`g${n}`];
      if (r) out.push(r[0], r[1]);
      else out.push(-1, -1);
    }
    return out;
  }
}

// --- translation ------------------------------------------------------------------------

interface Options {
  /** IGNORECASE. */
  readonly i: boolean;
  /** MULTILINE: `.` matches newline. */
  readonly s: boolean;
  /** SINGLELINE cleared: `^`/`$` are line anchors. */
  readonly m: boolean;
  /** EXTEND. */
  readonly x: boolean;
}

/** A translated piece: JavaScript source, whether it may match empty, whether it is one atom. */
interface Piece {
  readonly src: string;
  readonly nullable: boolean;
  /** A single JavaScript atom a quantifier can follow. */
  readonly atom: boolean;
  /** An anchor or look-around: not a valid repeat target. */
  readonly anchor?: boolean;
}

const WORD = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}';
const SPACE = '\\t-\\r \\x85\\xa0\\u1680\\u180e\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const DIGIT = '\\p{Nd}';

/** Class contents of the POSIX bracket classes (`[:name:]`) for Unicode encodings. */
const POSIX: Readonly<Record<string, string>> = {
  alnum: '\\p{Alphabetic}\\p{Nd}',
  alpha: '\\p{Alphabetic}',
  ascii: '\\0-\\x7f',
  blank: '\\t\\p{Zs}',
  cntrl: '\\p{Cc}',
  digit: DIGIT,
  lower: '\\p{Lowercase}',
  punct: '\\p{P}',
  space: SPACE,
  upper: '\\p{Uppercase}',
  xdigit: '0-9A-Fa-f',
  word: WORD,
};
/** Complements expressed as negated JavaScript classes. */
const POSIX_NEGATED: Readonly<Record<string, string>> = {
  graph: `${SPACE}\\p{Cc}\\p{Cn}\\p{Cs}`,
  print: '\\p{Cc}\\p{Cn}\\p{Cs}\\n\\v\\f\\r\\x85\\u2028\\u2029',
};

function fail(message: string): never {
  throw new TjsError(message);
}

/** A literal code point as a JavaScript escape (or itself, for ASCII letters and digits). */
function lit(cp: number): string {
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a))
    return String.fromCharCode(cp);
  return `\\u{${cp.toString(16)}}`;
}

/** The case variants of a code point (simple case mappings, closed over two steps). */
function caseVariants(cp: number): number[] {
  const set = new Set([cp]);
  for (let round = 0; round < 2; round++)
    for (const c of [...set]) {
      const s = String.fromCodePoint(c);
      for (const v of [s.toLowerCase(), s.toUpperCase()]) {
        const p = v.codePointAt(0)!;
        if (String.fromCodePoint(p) === v) set.add(p);
      }
    }
  return [...set];
}

/** Matches a class item set: ranges, plus class escapes in source form. */
interface ClassSet {
  ranges: [number, number][];
  /** Contents that go inside `[…]` as they are (`\p{…}`, POSIX contents). */
  positive: string[];
  /** Contents of sets that match by complement (`\W`, `[:^alpha:]`): `[^…]`. */
  negative: string[];
}

function rangeSource(ranges: readonly [number, number][]): string {
  return ranges.map(([a, b]) => (a === b ? lit(a) : `${lit(a)}-${lit(b)}`)).join('');
}

/** Adds the case variants of every range (applied to a class under scoped ignore-case). */
function caseClose(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [...ranges];
  for (const [a, b] of ranges)
    for (let c = a; c <= b; c++) for (const v of caseVariants(c)) if (v !== c) out.push([v, v]);
  return out;
}

/** The JavaScript source of a class: a single class when possible, else an alternation. */
function classSource(set: ClassSet, negated: boolean): Piece {
  const inner = rangeSource(set.ranges) + set.positive.join('');
  if (!set.negative.length) {
    if (!inner)
      return negated ? {src: '[\\s\\S]', nullable: false, atom: true} : fail('empty char-class');
    return {src: `[${negated ? '^' : ''}${inner}]`, nullable: false, atom: true};
  }
  const alts = [...(inner ? [`[${inner}]`] : []), ...set.negative.map((n) => `[^${n}]`)];
  if (!negated) return {src: `(?:${alts.join('|')})`, nullable: false, atom: true};
  return {src: `(?:(?!${alts.join('|')})[\\s\\S])`, nullable: false, atom: true};
}

/** `\p{…}` contents for a property name (Oniguruma ignores case, spaces, `_` and `-`). */
function propertySource(name: string): {src: string; negated: boolean} {
  const key = name.replace(/[\s_-]/g, '').toLowerCase();
  if (key in POSIX) return {src: POSIX[key]!, negated: false};
  if (key in POSIX_NEGATED) return {src: POSIX_NEGATED[key]!, negated: true};
  if (key === 'any') return {src: '\\s\\S', negated: false};
  if (key === 'assigned') return {src: '\\p{Cn}', negated: true};
  for (const candidate of [
    `\\p{${name}}`,
    `\\p{Script=${name}}`,
    `\\p{General_Category=${name}}`,
  ]) {
    try {
      new RegExp(candidate, 'u');
      return {src: candidate, negated: false};
    } catch {
      // try the next form
    }
  }
  return fail(`invalid character property name {${name}}`);
}

/**
 * Oniguruma group n becomes the named group `g<n>`; atomic groups and possessive quantifiers
 * use helper groups `a<k>`, the empty-match guard the group `rest`.
 */
interface Translation {
  readonly source: string;
  readonly flags: string;
  readonly groupCount: number;
}

/** Translates a pattern. `ignoreCase` is the compile option (flag `i`). */
export function translate(pattern: string, ignoreCase: boolean): Translation {
  return new Translator(pattern, ignoreCase).run();
}

class Translator {
  readonly #cps: number[];
  #pos = 0;
  /** Whether any inline option changes `i`: then case-insensitivity is expanded by hand. */
  readonly #scopedCase: boolean;
  readonly #baseIgnoreCase: boolean;
  #groupCount = 0;
  #helperCount = 0;
  #backrefs: number[] = [];

  constructor(pattern: string, ignoreCase: boolean) {
    this.#cps = Array.from(pattern, (c) => c.codePointAt(0)!);
    this.#scopedCase = /\(\?[imsx]*-?[msx]*i/.test(pattern);
    this.#baseIgnoreCase = ignoreCase;
  }

  run(): Translation {
    const opts: Options = {i: this.#baseIgnoreCase, s: false, m: false, x: false};
    const body = this.#alternation(opts);
    if (this.#pos < this.#cps.length) fail('unmatched close parenthesis');
    for (const n of this.#backrefs) if (n > this.#groupCount) fail('invalid backref number/name');
    // FIND_NOT_EMPTY: `rest` holds the subject from the match start on; the match cannot end
    // where all of it is still ahead.
    const src = body.nullable ? `(?=(?<rest>[\\s\\S]*))(?:${body.src})(?!\\k<rest>$)` : body.src;
    const flags = 'du' + (this.#baseIgnoreCase && !this.#scopedCase ? 'i' : '');
    return {source: src, flags, groupCount: this.#groupCount};
  }

  #peek(offset = 0): number | undefined {
    return this.#cps[this.#pos + offset];
  }

  #eat(ch: string): boolean {
    if (this.#peek() === ch.codePointAt(0)) {
      this.#pos++;
      return true;
    }
    return false;
  }

  /** Whether letters must be expanded to case variants here. */
  #expandCase(o: Options): boolean {
    return o.i && this.#scopedCase;
  }

  #alternation(opts: Options): Piece {
    const alts: Piece[] = [];
    let o = opts;
    for (;;) {
      const seq = this.#sequence(o);
      alts.push(seq.piece);
      o = seq.options;
      if (!this.#eat('|')) break;
    }
    if (alts.length === 1) return alts[0]!;
    return {
      src: alts.map((a) => a.src).join('|'),
      nullable: alts.some((a) => a.nullable),
      atom: false,
    };
  }

  /** A sequence up to `|` or `)`. Inline `(?imsx)` changes the options for the rest. */
  #sequence(opts: Options): {piece: Piece; options: Options} {
    let o = opts;
    const parts: Piece[] = [];
    for (;;) {
      if (o.x) this.#skipExtended();
      const c = this.#peek();
      if (c === undefined || c === 0x7c /* | */ || c === 0x29 /* ) */) break;
      const atom = this.#atom(o);
      if ('options' in atom) {
        o = atom.options;
        continue;
      }
      if ('quote' in atom) {
        parts.push(...atom.quote);
        continue;
      }
      parts.push(this.#quantified(atom, o));
    }
    return {
      piece: {
        src: parts.map((p) => p.src).join(''),
        nullable: parts.every((p) => p.nullable),
        atom: parts.length === 1 && parts[0]!.atom,
      },
      options: o,
    };
  }

  #skipExtended(): void {
    for (;;) {
      const c = this.#peek();
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b)
        this.#pos++;
      else if (c === 0x23 /* # */) {
        while (this.#peek() !== undefined && this.#peek() !== 0x0a) this.#pos++;
      } else return;
    }
  }

  /** Quantifiers after an atom: greedy, lazy, possessive; repeated ones nest. */
  #quantified(atom: Piece, o: Options): Piece {
    let piece = atom;
    for (;;) {
      if (o.x) this.#skipExtended();
      const q = this.#quantifier();
      if (!q) return piece;
      if (piece.anchor) fail('target of repeat operator is invalid');
      const target = piece.atom ? piece.src : `(?:${piece.src})`;
      const nullable = q.min === 0 || piece.nullable;
      if (q.possessive) {
        // Atomic: the look-ahead takes the greedy match, the back-reference consumes it.
        const a = `a${++this.#helperCount}`;
        piece = {src: `(?:(?=(?<${a}>${target}${q.src}))\\k<${a}>)`, nullable, atom: true};
      } else {
        piece = {src: target + q.src + (q.lazy ? '?' : ''), nullable, atom: false};
      }
    }
  }

  #quantifier(): {src: string; min: number; lazy: boolean; possessive: boolean} | null {
    const c = this.#peek();
    let src: string, min: number;
    if (c === 0x2a /* * */) ((src = '*'), (min = 0), this.#pos++);
    else if (c === 0x2b /* + */) ((src = '+'), (min = 1), this.#pos++);
    else if (c === 0x3f /* ? */) ((src = '?'), (min = 0), this.#pos++);
    else if (c === 0x7b /* { */) {
      const interval = this.#interval();
      if (!interval) return null;
      ({src, min} = interval);
      // `{n,m}+` is a nested repeat in this syntax, not possessive.
      return {src, min, lazy: this.#eat('?'), possessive: false};
    } else return null;
    if (this.#eat('?')) return {src, min, lazy: true, possessive: false};
    if (this.#eat('+')) return {src, min, lazy: false, possessive: true};
    return {src, min, lazy: false, possessive: false};
  }

  /** `{n}`, `{n,}`, `{n,m}`; anything else leaves `{` a literal. */
  #interval(): {src: string; min: number} | null {
    const start = this.#pos;
    this.#pos++;
    const num = () => {
      let s = '';
      while (this.#peek() !== undefined && this.#peek()! >= 0x30 && this.#peek()! <= 0x39)
        s += String.fromCharCode(this.#cps[this.#pos++]!);
      return s;
    };
    const lo = num();
    let hi: string | null = lo;
    if (lo === '') {
      this.#pos = start;
      return null;
    }
    if (this.#eat(',')) hi = num() || null;
    if (!this.#eat('}')) {
      this.#pos = start;
      return null;
    }
    const min = +lo;
    if (min > 100000 || (hi !== null && +hi > 100000)) fail('too big number for repeat range');
    if (hi !== null && +hi < min) fail('upper is smaller than lower in repeat range');
    return {src: hi === lo ? `{${lo}}` : `{${lo},${hi ?? ''}}`, min};
  }

  /** One atom, an option change, or the literal pieces of `\Q…\E`. */
  #atom(o: Options): Piece | {options: Options} | {quote: Piece[]} {
    const c = this.#cps[this.#pos++]!;
    switch (c) {
      case 0x28 /* ( */:
        return this.#group(o);
      case 0x5b /* [ */:
        return this.#class(o);
      case 0x2e /* . */:
        return {src: o.s ? '[\\s\\S]' : '[^\\n]', nullable: false, atom: true};
      case 0x5e /* ^ */:
        return {src: o.m ? '(?:^|(?<=\\n)(?!$))' : '^', nullable: true, atom: false, anchor: true};
      case 0x24 /* $ */:
        return {src: o.m ? '(?=\\n|$)' : '(?=\\n?$)', nullable: true, atom: false, anchor: true};
      case 0x5c /* \ */:
        return this.#escape(o);
      case 0x2a:
      case 0x2b:
      case 0x3f:
        return fail('target of repeat operator is not specified');
      case 0x7b /* { */:
        this.#pos--;
        if (this.#interval()) fail('target of repeat operator is not specified');
        this.#pos++;
        return this.#literal(c, o);
      default:
        return this.#literal(c, o);
    }
  }

  #literal(cp: number, o: Options): Piece {
    if (this.#expandCase(o)) {
      const v = caseVariants(cp);
      if (v.length > 1) return {src: `[${v.map(lit).join('')}]`, nullable: false, atom: true};
    }
    return {src: lit(cp), nullable: false, atom: true};
  }

  #group(o: Options): Piece | {options: Options} {
    if (!this.#eat('?')) {
      const n = ++this.#groupCount;
      const inner = this.#groupBody(o);
      return {src: `(?<g${n}>${inner.src})`, nullable: inner.nullable, atom: true};
    }
    const c = this.#cps[this.#pos++];
    switch (c) {
      case 0x3a /* : */: {
        const inner = this.#groupBody(o);
        return {src: `(?:${inner.src})`, nullable: inner.nullable, atom: true};
      }
      case 0x3d /* = */:
      case 0x21 /* ! */: {
        const inner = this.#groupBody(o);
        return {
          src: `(?${String.fromCharCode(c)}${inner.src})`,
          nullable: true,
          atom: false,
          anchor: true,
        };
      }
      case 0x3c /* < */: {
        const d = this.#cps[this.#pos++];
        if (d !== 0x3d && d !== 0x21) return fail('undefined group option');
        const inner = this.#groupBody(o);
        return {
          src: `(?<${String.fromCharCode(d)}${inner.src})`,
          nullable: true,
          atom: false,
          anchor: true,
        };
      }
      case 0x3e /* > */: {
        const a = `a${++this.#helperCount}`;
        const inner = this.#groupBody(o);
        return {
          src: `(?:(?=(?<${a}>${inner.src}))\\k<${a}>)`,
          nullable: inner.nullable,
          atom: true,
        };
      }
      case 0x23 /* # */: {
        while (this.#peek() !== undefined && this.#peek() !== 0x29) this.#pos++;
        if (!this.#eat(')')) fail('end pattern in group');
        return {src: '', nullable: true, atom: false};
      }
      default: {
        this.#pos--;
        return this.#optionGroup(o);
      }
    }
  }

  /** `(?imsx-imsx)` or `(?imsx-imsx:…)`. */
  #optionGroup(o: Options): Piece | {options: Options} {
    const next = {i: o.i, s: o.s, m: o.m, x: o.x};
    let neg = false;
    for (;;) {
      const c = this.#cps[this.#pos++];
      if (c === undefined) return fail('end pattern in group');
      const ch = String.fromCharCode(c);
      if (ch === '-') neg = true;
      else if (ch === 'i' || ch === 's' || ch === 'm' || ch === 'x') next[ch] = !neg;
      else if (ch === ')') return {options: next};
      else if (ch === ':') {
        const inner = this.#groupBody(next);
        return {src: `(?:${inner.src})`, nullable: inner.nullable, atom: true};
      } else return fail('undefined group option');
    }
  }

  #groupBody(o: Options): Piece {
    const inner = this.#alternation(o);
    if (!this.#eat(')')) fail('end pattern with unmatched parenthesis');
    return inner;
  }

  #escape(o: Options): Piece | {quote: Piece[]} {
    const c = this.#cps[this.#pos++];
    if (c === undefined) return fail('end pattern at escape');
    const ch = String.fromCodePoint(c);
    const cls = (inner: string, negated: boolean): Piece => ({
      src: `[${negated ? '^' : ''}${inner}]`,
      nullable: false,
      atom: true,
    });
    const anchor = (src: string): Piece => ({src, nullable: true, atom: false, anchor: true});
    switch (ch) {
      case 'w':
        return cls(WORD, false);
      case 'W':
        return cls(WORD, true);
      case 's':
        return cls(SPACE, false);
      case 'S':
        return cls(SPACE, true);
      case 'd':
        return cls(DIGIT, false);
      case 'D':
        return cls(DIGIT, true);
      case 'b':
        return anchor(`(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`);
      case 'B':
        return anchor(`(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`);
      case 'A':
        return anchor('^');
      case 'z':
        return anchor('$');
      case 'Z':
        return anchor('(?=\\n?$)');
      case 'G':
        return fail('\\G is not supported');
      case 'Q': {
        const quote: Piece[] = [];
        while (this.#pos < this.#cps.length) {
          if (this.#peek() === 0x5c && this.#peek(1) === 0x45 /* E */) {
            this.#pos += 2;
            break;
          }
          quote.push(this.#literal(this.#cps[this.#pos++]!, o));
        }
        return {quote};
      }
      case 'p':
      case 'P': {
        const p = this.#property(ch === 'P');
        return p.negated ? cls(p.src, true) : cls(p.src, false);
      }
      default: {
        if (c >= 0x31 && c <= 0x39) {
          const backref = this.#backref(c);
          if (backref !== null) return backref;
        }
        return this.#literal(this.#escapedChar(c), o);
      }
    }
  }

  /** `\1`…: a back-reference, or null for an octal escape. */
  #backref(first: number): Piece | null {
    const start = this.#pos - 1;
    let s = String.fromCharCode(first);
    while (this.#peek() !== undefined && this.#peek()! >= 0x30 && this.#peek()! <= 0x39)
      s += String.fromCharCode(this.#cps[this.#pos++]!);
    const n = +s;
    if (n <= 9 || n <= this.#groupCount) {
      this.#backrefs.push(n);
      return {src: `\\k<g${n}>`, nullable: true, atom: true};
    }
    this.#pos = start;
    return null;
  }

  /** The code point of an escape that stands for one character (shared with classes). */
  #escapedChar(c: number): number {
    switch (String.fromCodePoint(c)) {
      case 't':
        return 0x09;
      case 'n':
        return 0x0a;
      case 'r':
        return 0x0d;
      case 'f':
        return 0x0c;
      case 'v':
        return 0x0b;
      case 'a':
        return 0x07;
      case 'e':
        return 0x1b;
      case 'x': {
        if (this.#eat('{')) {
          let s = '';
          while (this.#peek() !== undefined && this.#peek() !== 0x7d)
            s += String.fromCodePoint(this.#cps[this.#pos++]!);
          if (!this.#eat('}') || !/^[0-9a-fA-F]{1,8}$/.test(s)) fail('invalid code point value');
          const v = parseInt(s, 16);
          if (v > 0x10ffff) fail('too big wide-char value');
          return v;
        }
        return this.#digits(16, 2);
      }
      case 'c': {
        const d = this.#cps[this.#pos++];
        if (d === undefined) fail('end pattern at control');
        return d & 0x1f;
      }
      case '0':
        return this.#digits(8, 2);
      default:
        if (c >= 0x31 && c <= 0x37) {
          this.#pos--;
          return this.#digits(8, 3);
        }
        return c;
    }
  }

  #digits(radix: number, max: number): number {
    let v = 0;
    for (let i = 0; i < max; i++) {
      const c = this.#peek();
      if (c === undefined) break;
      const d = parseInt(String.fromCharCode(c), radix);
      if (Number.isNaN(d)) break;
      v = v * radix + d;
      this.#pos++;
    }
    return v;
  }

  /** `\p{Name}`, `\p{^Name}`, `\P{Name}`. */
  #property(negated: boolean): {src: string; negated: boolean} {
    if (!this.#eat('{')) fail('invalid character property name {}');
    if (this.#eat('^')) negated = !negated;
    let name = '';
    while (this.#peek() !== undefined && this.#peek() !== 0x7d)
      name += String.fromCodePoint(this.#cps[this.#pos++]!);
    if (!this.#eat('}')) fail(`invalid character property name {${name}}`);
    const p = propertySource(name);
    return {src: p.src, negated: p.negated !== negated};
  }

  /** A bracket class `[…]`. */
  #class(o: Options): Piece {
    const negated = this.#eat('^');
    const set: ClassSet = {ranges: [], positive: [], negative: []};
    let first = true;
    for (;;) {
      const c = this.#cps[this.#pos++];
      if (c === undefined) return fail('premature end of char-class');
      if (c === 0x5d /* ] */ && !first) break;
      first = false;
      let lo: number | null;
      if (c === 0x5b /* [ */ && this.#peek() === 0x3a /* : */) {
        if (this.#posixBracket(set)) continue;
        lo = c;
      } else if (c === 0x5c) {
        lo = this.#classEscape(set);
        if (lo === null) continue;
      } else lo = c;
      // A range, unless `-` ends the class.
      if (this.#peek() === 0x2d && this.#peek(1) !== undefined && this.#peek(1) !== 0x5d) {
        this.#pos++;
        let hi: number | null;
        const d = this.#cps[this.#pos++]!;
        if (d === 0x5c) {
          const save = set.positive.length + set.negative.length;
          hi = this.#classEscape(set);
          if (hi === null || set.positive.length + set.negative.length !== save)
            fail('char-class value at end of range');
        } else hi = d;
        if (hi! < lo) fail('empty range in char class');
        set.ranges.push([lo, hi!]);
      } else set.ranges.push([lo, lo]);
    }
    if (this.#expandCase(o)) set.ranges = caseClose(set.ranges);
    return classSource(set, negated);
  }

  /** `[:name:]` / `[:^name:]` at `[`; false when it is not a POSIX bracket. */
  #posixBracket(set: ClassSet): boolean {
    const save = this.#pos;
    this.#pos++;
    const neg = this.#eat('^');
    let name = '';
    while (this.#peek() !== undefined && this.#peek()! >= 0x61 && this.#peek()! <= 0x7a)
      name += String.fromCharCode(this.#cps[this.#pos++]!);
    if (!(this.#eat(':') && this.#eat(']'))) {
      this.#pos = save;
      return false;
    }
    let p: {src: string; negated: boolean};
    if (name in POSIX) p = {src: POSIX[name]!, negated: false};
    else if (name in POSIX_NEGATED) p = {src: POSIX_NEGATED[name]!, negated: true};
    else return fail('invalid POSIX bracket type');
    (p.negated !== neg ? set.negative : set.positive).push(p.src);
    return true;
  }

  /** An escape inside a class: a set (added, returns null) or a character. */
  #classEscape(set: ClassSet): number | null {
    const c = this.#cps[this.#pos++];
    if (c === undefined) return fail('premature end of char-class');
    switch (String.fromCodePoint(c)) {
      case 'w':
        return (set.positive.push(WORD), null);
      case 'W':
        return (set.negative.push(WORD), null);
      case 's':
        return (set.positive.push(SPACE), null);
      case 'S':
        return (set.negative.push(SPACE), null);
      case 'd':
        return (set.positive.push(DIGIT), null);
      case 'D':
        return (set.negative.push(DIGIT), null);
      case 'p':
      case 'P': {
        const p = this.#property(c === 0x50);
        (p.negated ? set.negative : set.positive).push(p.src);
        return null;
      }
      case 'b':
        return 0x08;
      default:
        return this.#escapedChar(c);
    }
  }
}
