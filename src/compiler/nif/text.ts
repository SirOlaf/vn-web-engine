import {NifBuffer, NifKind} from './buffer.js';
import type {NifPool} from './pool.js';
import type {NifTags} from './tags.js';

/**
 * The NIF text form (nifspec, version 2027): `(tag@info child …)`, atoms with `@info`
 * suffixes, base-62 line-information diffs relative to the enclosing node.
 *
 * Positions: a suffix `@c,l` holds column and line differences to the enclosing node; a
 * suffix with a file name, `@c,l,file`, holds an absolute column and line. The writer uses the
 * absolute form for the root and wherever the enclosing node has no position or another file.
 * A token without a suffix has no position.
 *
 * Strings are JavaScript strings. Text is escaped per byte of its WTF-8 form, so lone
 * surrogates survive a round trip.
 */
export const NIF_VERSION_DIRECTIVE = '(.nif27)';

export interface NifWriteOptions {
  /** Emit position suffixes (default true). */
  readonly positions?: boolean;
}

export function writeNif(
  buf: NifBuffer,
  roots?: readonly number[],
  options: NifWriteOptions = {},
): string {
  const writer = new Writer(buf, options.positions ?? true);
  writer.out.push(NIF_VERSION_DIRECTIVE, '\n');
  const starts = roots ?? topLevel(buf);
  for (const pos of starts) {
    writer.node(pos, null, 0);
    writer.out.push('\n');
  }
  return writer.out.join('');
}

/** Writes one subtree without the version directive; positions are absolute at its root. */
export function writeNifTree(buf: NifBuffer, pos: number, options: NifWriteOptions = {}): string {
  const writer = new Writer(buf, options.positions ?? true);
  writer.node(pos, null, 0);
  return writer.out.join('');
}

function topLevel(buf: NifBuffer): number[] {
  const out: number[] = [];
  for (let p = 0; p < buf.length; p = buf.next(p)) out.push(p);
  return out;
}

type Position = [file: number, line: number, column: number];

class Writer {
  readonly out: string[] = [];

  constructor(
    readonly buf: NifBuffer,
    readonly positions: boolean,
  ) {}

  node(pos: number, parent: Position | null, depth: number): void {
    const buf = this.buf,
      kind = buf.kind(pos);
    if (kind !== NifKind.Tag) {
      this.out.push(atomText(buf, pos));
      this.#suffix(pos, parent);
      return;
    }
    this.out.push('(', buf.tagName(pos));
    const own = this.#suffix(pos, parent);
    for (let c = pos + 1, end = buf.end(pos); c < end; c = buf.next(c)) {
      if (buf.kind(c) === NifKind.Tag) this.out.push('\n', ' '.repeat(depth + 1));
      else this.out.push(' ');
      this.node(c, own, depth + 1);
    }
    this.out.push(')');
  }

  /** Writes the position suffix of `pos` and returns its unpacked position (or the parent's). */
  #suffix(pos: number, parent: Position | null): Position | null {
    const info = this.buf.info(pos);
    if (!this.positions || info === 0) return null;
    const here = this.buf.pool.unpack(info, [0, 0, 0]);
    const [file, line, column] = here;
    if (!parent || parent[0] !== file) {
      const name = file ? this.buf.pool.fileName(file) : '';
      this.out.push('@', base62(column), ',', base62(line), ',', escapeText(name, false));
    } else {
      const dc = column - parent[2],
        dl = line - parent[1];
      if (dl === 0) this.out.push(dc < 0 ? base62(dc) : '@' + base62(dc));
      else this.out.push(dc < 0 ? base62(dc) : '@' + base62(dc), ',', base62(dl));
    }
    return here;
  }
}

function atomText(buf: NifBuffer, pos: number): string {
  switch (buf.kind(pos)) {
    case NifKind.Dot:
      return '.';
    case NifKind.Ident:
      return escapeName(buf.text(pos), false);
    case NifKind.Symbol:
      return escapeName(buf.text(pos), true);
    case NifKind.SymbolDef:
      return ':' + escapeName(buf.text(pos), true);
    case NifKind.Str:
      return '"' + escapeText(buf.text(pos), true) + '"';
    case NifKind.Char: {
      const b = buf.char(pos);
      return "'" + escapeByte(b, false) + "'";
    }
    case NifKind.Int:
      return buf.integer(pos).toString();
    case NifKind.UInt:
      return buf.integer(pos).toString() + 'u';
    case NifKind.Float:
      return floatText(buf.float(pos));
    case NifKind.Tag:
      throw new Error('not an atom');
  }
}

function floatText(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`NIF float atoms are finite; got ${value}`);
  if (Object.is(value, -0)) return '-0.0';
  let s = String(value).replace('e', 'E');
  if (!/[.E]/.test(s)) s += '.0';
  // JavaScript writes 1e21 as "1e+21"; NIF requires digits before the exponent only.
  return s;
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62(n: number): string {
  if (n < 0) return '~' + base62(-n);
  if (n === 0) return '0';
  let s = '';
  while (n > 0) {
    s = B62[n % 62]! + s;
    n = Math.floor(n / 62);
  }
  return s;
}

const CONTROL = new Set([...'()[]{}~#\'"\\:@']);

function escapeByte(b: number, inString: boolean): string {
  const ch = String.fromCharCode(b);
  if (b === 0x0a) return inString ? '\\n' : '\\0A';
  if (b === 0x09) return inString ? '\\t' : '\\09';
  if (b === 0x0d) return inString ? '\\r' : '\\0D';
  if (b === 0x5c) return '\\|';
  if (b === 0x22) return '\\^';
  if (b < 0x20 || b === 0x7f || CONTROL.has(ch) || (!inString && b === 0x20))
    return '\\' + b.toString(16).toUpperCase().padStart(2, '0');
  return ch;
}

/** Escapes text for a string literal (`inString`) or a file name in a position suffix. */
function escapeText(text: string, inString: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      out += !inString && c === 0x2c ? '\\2C' : escapeByte(c, inString);
    } else if (c >= 0xd800 && c <= 0xdfff && !isPairedSurrogate(text, i)) {
      out += wtf8Escape(c);
    } else {
      out += text[i];
    }
  }
  return out;
}

function isPairedSurrogate(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  if (c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    return d >= 0xdc00 && d <= 0xdfff;
  }
  const p = text.charCodeAt(i - 1);
  return p >= 0xd800 && p <= 0xdbff;
}

function wtf8Escape(c: number): string {
  const bytes = [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)];
  return bytes.map((b) => '\\' + b.toString(16).toUpperCase()).join('');
}

function isIdentChar(c: number, first: boolean): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f ||
    (!first && c >= 0x30 && c <= 0x39) ||
    c >= 0x80
  );
}

/** Identifiers escape every non-identifier byte; symbols keep their dots. */
function escapeName(name: string, symbol: boolean): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff && !isPairedSurrogate(name, i)) out += wtf8Escape(c);
    else if (isIdentChar(c, i === 0) || (symbol && c === 0x2e && i > 0)) out += name[i];
    else if (c < 0x80) out += '\\' + c.toString(16).toUpperCase().padStart(2, '0');
    else out += name[i];
  }
  return out;
}

// ── reading ────────────────────────────────────────────────────────────────

export class NifSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = 'NifSyntaxError';
  }
}

export interface NifReadResult {
  readonly buffer: NifBuffer;
  /** Positions of the top-level nodes (directives excluded). */
  readonly roots: number[];
  /** Directives as written, without parentheses, e.g. `.nif27`. */
  readonly directives: string[];
}

/** Parses NIF text into a new buffer. Unknown tags are registered with `tags`. */
export function readNif(text: string, pool: NifPool, tags: NifTags): NifReadResult {
  const reader = new Reader(text, new NifBuffer(pool, tags, Math.max(64, text.length >> 2)));
  return reader.module();
}

class Reader {
  #i = 0;
  readonly roots: number[] = [];
  readonly directives: string[] = [];

  constructor(
    readonly text: string,
    readonly buf: NifBuffer,
  ) {}

  module(): NifReadResult {
    for (;;) {
      this.#space();
      if (this.#i >= this.text.length) break;
      if (this.text[this.#i] === '(' && this.text[this.#i + 1] === '.') {
        this.#directive();
        continue;
      }
      this.roots.push(this.buf.length);
      this.#node(null);
    }
    if (this.buf.openNodes) throw new NifSyntaxError('Unclosed node', this.#i);
    return {buffer: this.buf, roots: this.roots, directives: this.directives};
  }

  #directive(): void {
    const start = this.#i;
    let depth = 0;
    for (; this.#i < this.text.length; this.#i++) {
      const ch = this.text[this.#i];
      if (ch === '"') this.#skipQuoted('"');
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) {
        this.#i++;
        this.directives.push(this.text.slice(start + 1, this.#i - 1).trim());
        return;
      }
    }
    throw new NifSyntaxError('Unterminated directive', start);
  }

  #skipQuoted(q: string): void {
    for (this.#i++; this.#i < this.text.length && this.text[this.#i] !== q; this.#i++);
  }

  #space(): void {
    const t = this.text;
    while (this.#i < t.length) {
      const c = t.charCodeAt(this.#i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.#i++;
      else break;
    }
  }

  #node(parent: Position | null): void {
    this.#space();
    const t = this.text,
      start = this.#i,
      ch = t[this.#i];
    if (ch === undefined) throw new NifSyntaxError('Unexpected end of input', start);
    const buf = this.buf;
    if (ch === '(') {
      this.#i++;
      const nameStart = this.#i;
      while (this.#i < t.length && isIdentChar(t.charCodeAt(this.#i), this.#i === nameStart))
        this.#i++;
      const name = t.slice(nameStart, this.#i);
      if (!name) throw new NifSyntaxError('Missing tag name', nameStart);
      const pos = buf.open(buf.tags.register(name));
      const here = this.#suffix(pos, parent);
      for (;;) {
        this.#space();
        if (t[this.#i] === ')') {
          this.#i++;
          break;
        }
        if (this.#i >= t.length) throw new NifSyntaxError('Unclosed node', start);
        this.#node(here);
      }
      buf.close(pos);
      return;
    }
    if (ch === ')') throw new NifSyntaxError('Unexpected )', start);
    const pos = buf.length;
    if (ch === '.') {
      this.#i++;
      buf.addDot();
    } else if (ch === '"') {
      this.#i++;
      const s = this.#i;
      while (this.#i < t.length && t[this.#i] !== '"') this.#i++;
      if (this.#i >= t.length) throw new NifSyntaxError('Unterminated string', start);
      buf.addString(decodeEscaped(t, s, this.#i, start));
      this.#i++;
    } else if (ch === "'") {
      this.#i++;
      const s = this.#i;
      while (this.#i < t.length && t[this.#i] !== "'") this.#i++;
      const bytes = decodeBytes(t, s, this.#i, start);
      if (bytes.length !== 1) throw new NifSyntaxError('Char literal is not one byte', start);
      buf.addChar(bytes[0]!);
      this.#i++;
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      this.#number();
    } else {
      const def = ch === ':';
      if (def) this.#i++;
      const s = this.#i;
      while (this.#i < t.length) {
        const c = t.charCodeAt(this.#i);
        if (c === 0x5c) this.#i += t[this.#i + 1] && /[0-9A-F]/.test(t[this.#i + 1]!) ? 3 : 2;
        else if (isIdentChar(c, false) || c === 0x2e) this.#i++;
        else break;
      }
      if (this.#i === s)
        throw new NifSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, start);
      const name = decodeEscaped(t, s, this.#i, start);
      if (def) buf.addSymbolDef(name);
      else if (rawHasDot(t, s, this.#i)) buf.addSymbol(name);
      else buf.addIdent(name);
    }
    this.#suffix(pos, parent);
  }

  #number(): void {
    const t = this.text,
      start = this.#i;
    if (t[this.#i] === '-') this.#i++;
    const m = /^[0-9]+(\.[0-9]+)?(E[+-]?[0-9]+)?(u)?/.exec(t.slice(this.#i, this.#i + 64));
    if (!m) throw new NifSyntaxError('Malformed number', start);
    this.#i += m[0].length;
    const literal = t.slice(start, this.#i);
    if (m[3]) this.buf.addUInt(BigInt(literal.slice(0, -1)));
    else if (m[1] || m[2]) this.buf.addFloat(Number(literal));
    else this.buf.addInt(BigInt(literal));
  }

  /** Reads an optional `@info` / `~info` and `#comment#` suffix for the token at `pos`. */
  #suffix(pos: number, parent: Position | null): Position | null {
    const t = this.text;
    let here: Position | null = null;
    if (t[this.#i] === '@' || t[this.#i] === '~') {
      if (t[this.#i] === '@') this.#i++;
      const col = this.#diff();
      let line = 0,
        file: string | null = null;
      if (t[this.#i] === ',') {
        this.#i++;
        line = this.#diff();
        if (t[this.#i] === ',') {
          this.#i++;
          const s = this.#i;
          while (this.#i < t.length && !/[\s()#]/.test(t[this.#i]!)) this.#i++;
          file = decodeEscaped(t, s, this.#i, s);
        }
      }
      const pool = this.buf.pool;
      if (file !== null) here = [file ? pool.file(file) : 0, line, col];
      else if (parent) here = [parent[0], parent[1] + line, parent[2] + col];
      else throw new NifSyntaxError('Relative position without an enclosing position', this.#i);
      if (here[1] >= 1) this.buf.setInfo(pos, pool.position(here[0], here[1], here[2]));
    }
    if (t[this.#i] === '#') {
      const end = t.indexOf('#', this.#i + 1);
      if (end < 0) throw new NifSyntaxError('Unterminated comment', this.#i);
      this.#i = end + 1;
    }
    return here ?? parent;
  }

  #diff(): number {
    const t = this.text;
    let sign = 1;
    if (t[this.#i] === '~') {
      sign = -1;
      this.#i++;
    }
    let n = 0;
    for (;;) {
      const d = B62.indexOf(t[this.#i] ?? ' ');
      if (d < 0 || t[this.#i] === undefined) break;
      n = n * 62 + d;
      this.#i++;
    }
    return sign * n;
  }
}

function rawHasDot(t: string, s: number, e: number): boolean {
  for (let i = s; i < e; i++) {
    if (t[i] === '\\') i += /[0-9A-F]/.test(t[i + 1] ?? '') ? 2 : 1;
    else if (t[i] === '.') return true;
  }
  return false;
}

function decodeBytes(t: string, s: number, e: number, at: number): number[] {
  const text = decodeEscaped(t, s, e, at);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff);
  return out;
}

const SHORT: Record<string, number> = {n: 0x0a, t: 0x09, r: 0x0d, '|': 0x5c, '^': 0x22};

/** Decodes escapes; runs of escaped bytes are read as WTF-8. */
function decodeEscaped(t: string, s: number, e: number, at: number): string {
  if (t.indexOf('\\', s) < 0 || t.indexOf('\\', s) >= e) return t.slice(s, e);
  let out = '';
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) out += decodeWtf8(bytes);
    bytes = [];
  };
  for (let i = s; i < e; i++) {
    const ch = t[i]!;
    if (ch !== '\\') {
      flush();
      out += ch;
      continue;
    }
    const n = t[i + 1];
    if (n !== undefined && n in SHORT) {
      bytes.push(SHORT[n]!);
      i++;
    } else if (/^[0-9A-F]{2}$/.test(t.slice(i + 1, i + 3))) {
      bytes.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      throw new NifSyntaxError('Invalid escape sequence', at);
    }
  }
  flush();
  return out;
}

function decodeWtf8(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    let cp: number, n: number;
    if (b < 0x80) [cp, n] = [b, 1];
    else if (b >= 0xf0) [cp, n] = [b & 0x07, 4];
    else if (b >= 0xe0) [cp, n] = [b & 0x0f, 3];
    else if (b >= 0xc0) [cp, n] = [b & 0x1f, 2];
    else [cp, n] = [b, 1];
    for (let k = 1; k < n; k++) cp = (cp << 6) | ((bytes[i + k] ?? 0x80) & 0x3f);
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}
