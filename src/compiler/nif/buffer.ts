import {NO_POSITION, type NifPool} from './pool.js';
import type {NifTags} from './tags.js';

/** Token kinds, stored in the low 4 bits of a token. */
export const NifKind = {
  /** The empty node `.`. */
  Dot: 0,
  Ident: 1,
  /** A symbol use, `name.N` (local) or `name.N.module` (global). */
  Symbol: 2,
  /** A symbol definition, `:name.N`. Its parent node introduces the symbol. */
  SymbolDef: 3,
  Str: 4,
  /** A byte, `'c'`. */
  Char: 5,
  Int: 6,
  UInt: 7,
  Float: 8,
  /** A compound node: tag id in the token, subtree size in `jumps`. */
  Tag: 9,
} as const;
export type NifKind = (typeof NifKind)[keyof typeof NifKind];

const KIND_BITS = 4,
  KIND_MASK = 0xf,
  PAYLOAD_LIMIT = 1 << 28,
  /** Inline integers use 27 bits of payload; bit 0 marks the inline form. */
  INLINE_INT_MIN = -(1 << 26),
  INLINE_INT_MAX = (1 << 26) - 1;

function token(kind: NifKind, payload: number): number {
  if (payload < 0 || payload >= PAYLOAD_LIMIT)
    throw new RangeError(`NIF payload ${payload} out of range`);
  return ((payload << KIND_BITS) | kind) >>> 0;
}

/**
 * A NIF tree stored as a flat token stream, the in-memory form of nimony's NIF: a compound
 * node is one tag token followed by its children, and its size (the "jump") makes subtrees
 * skippable without a closing token. Every token carries a packed source position.
 *
 * Positions are plain indices. Children of the node at `pos` start at `pos + 1` and end at
 * `end(pos)`; `next(pos)` is the sibling after `pos` and works for atoms and nodes alike:
 *
 *   for (let c = pos + 1, end = buf.end(pos); c < end; c = buf.next(c)) …
 */
export class NifBuffer {
  #tokens: Uint32Array;
  /** Subtree size for tag tokens (tokens after the tag); 0 for atoms. */
  #jumps: Uint32Array;
  #infos: Uint32Array;
  #length = 0;
  /** Positions of the nodes opened and not yet closed, outermost first. */
  readonly #open: number[] = [];

  constructor(
    readonly pool: NifPool,
    readonly tags: NifTags,
    capacity = 256,
  ) {
    this.#tokens = new Uint32Array(capacity);
    this.#jumps = new Uint32Array(capacity);
    this.#infos = new Uint32Array(capacity);
  }

  get length(): number {
    return this.#length;
  }

  /** Number of nodes opened and not yet closed. */
  get openNodes(): number {
    return this.#open.length;
  }

  /** Positions of the open nodes, outermost first. */
  openPositions(): readonly number[] {
    return this.#open;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  kind(pos: number): NifKind {
    return (this.#at(pos) & KIND_MASK) as NifKind;
  }

  /** Tag id of a compound node, or -1 for an atom. */
  tag(pos: number): number {
    const t = this.#at(pos);
    return (t & KIND_MASK) === NifKind.Tag ? t >>> KIND_BITS : -1;
  }

  tagName(pos: number): string {
    const tag = this.tag(pos);
    if (tag < 0) throw new Error(`NIF token ${pos} is not a node`);
    return this.tags.name(tag);
  }

  isNode(pos: number, tag?: number): boolean {
    const t = this.tag(pos);
    return tag === undefined ? t >= 0 : t === tag;
  }

  isDot(pos: number): boolean {
    return this.kind(pos) === NifKind.Dot;
  }

  /** Exclusive end of the subtree at `pos`. */
  end(pos: number): number {
    return pos + 1 + (this.kind(pos) === NifKind.Tag ? this.#jumps[pos]! : 0);
  }

  next(pos: number): number {
    return this.end(pos);
  }

  info(pos: number): number {
    this.#at(pos);
    return this.#infos[pos]!;
  }

  setInfo(pos: number, info: number): void {
    this.#at(pos);
    this.#infos[pos] = info;
  }

  /** Text of an identifier, symbol, symbol definition or string literal. */
  text(pos: number): string {
    const t = this.#at(pos),
      kind = t & KIND_MASK;
    if (
      kind !== NifKind.Ident &&
      kind !== NifKind.Symbol &&
      kind !== NifKind.SymbolDef &&
      kind !== NifKind.Str
    )
      throw new Error(`NIF token ${pos} has no text`);
    return this.pool.string(t >>> KIND_BITS);
  }

  /** Value of an Int or UInt literal. */
  integer(pos: number): bigint {
    const t = this.#at(pos),
      kind = t & KIND_MASK;
    if (kind !== NifKind.Int && kind !== NifKind.UInt)
      throw new Error(`NIF token ${pos} is not an integer`);
    const payload = t >>> KIND_BITS;
    if (!(payload & 1)) return this.pool.bigint(payload >>> 1);
    const value = payload >>> 1;
    return BigInt(kind === NifKind.Int && value & (1 << 26) ? value - (1 << 27) : value);
  }

  float(pos: number): number {
    const t = this.#at(pos);
    if ((t & KIND_MASK) !== NifKind.Float) throw new Error(`NIF token ${pos} is not a float`);
    return this.pool.float(t >>> KIND_BITS);
  }

  char(pos: number): number {
    const t = this.#at(pos);
    if ((t & KIND_MASK) !== NifKind.Char) throw new Error(`NIF token ${pos} is not a char`);
    return t >>> KIND_BITS;
  }

  /** Child positions of the node at `pos`. */
  children(pos: number): number[] {
    const out: number[] = [];
    for (let c = pos + 1, end = this.end(pos); c < end; c = this.next(c)) out.push(c);
    return out;
  }

  childCount(pos: number): number {
    let n = 0;
    for (let c = pos + 1, end = this.end(pos); c < end; c = this.next(c)) n++;
    return n;
  }

  /** The `index`-th child of the node at `pos`. */
  child(pos: number, index: number): number {
    let c = pos + 1;
    const end = this.end(pos);
    for (let i = 0; i < index && c < end; i++) c = this.next(c);
    if (c >= end) throw new RangeError(`NIF node ${pos} has no child ${index}`);
    return c;
  }

  /** Structural equality of two subtrees, ignoring positions. */
  sameTree(a: number, other: NifBuffer, b: number): boolean {
    const end = this.end(a);
    if (other.end(b) - b !== end - a) return false;
    for (let i = 0; a + i < end; i++) {
      if (this.#jumps[a + i] !== other.#jumps[b + i]) return false;
      if (!sameAtom(this, a + i, other, b + i)) return false;
    }
    return true;
  }

  // ── building ─────────────────────────────────────────────────────────────

  addDot(info = NO_POSITION): void {
    this.#push(NifKind.Dot, info);
  }

  addIdent(name: string, info = NO_POSITION): void {
    this.#push(token(NifKind.Ident, this.pool.intern(name)), info);
  }

  addSymbol(name: string, info = NO_POSITION): void {
    if (!isSymbolName(name)) throw new Error(`Invalid NIF symbol ${JSON.stringify(name)}`);
    this.#push(token(NifKind.Symbol, this.pool.intern(name)), info);
  }

  addSymbolDef(name: string, info = NO_POSITION): void {
    if (!isSymbolName(name)) throw new Error(`Invalid NIF symbol ${JSON.stringify(name)}`);
    this.#push(token(NifKind.SymbolDef, this.pool.intern(name)), info);
  }

  addString(text: string, info = NO_POSITION): void {
    this.#push(token(NifKind.Str, this.pool.intern(text)), info);
  }

  addChar(byte: number, info = NO_POSITION): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff)
      throw new RangeError(`NIF char ${byte} out of range`);
    this.#push(token(NifKind.Char, byte), info);
  }

  addInt(value: number | bigint, info = NO_POSITION): void {
    this.#pushInteger(NifKind.Int, value, info);
  }

  addUInt(value: number | bigint, info = NO_POSITION): void {
    if (value < 0) throw new RangeError(`NIF unsigned integer ${value} is negative`);
    this.#pushInteger(NifKind.UInt, value, info);
  }

  addFloat(value: number, info = NO_POSITION): void {
    this.#push(token(NifKind.Float, this.pool.addFloat(value)), info);
  }

  /** Opens a compound node and returns its position, to be passed to `close`. */
  open(tag: number, info = NO_POSITION): number {
    const pos = this.#length;
    this.#push(token(NifKind.Tag, tag), info);
    this.#open.push(pos);
    return pos;
  }

  close(pos: number): void {
    if (this.kind(pos) !== NifKind.Tag) throw new Error(`NIF token ${pos} is not a node`);
    if (this.#open.at(-1) !== pos)
      throw new Error(`NIF close of ${pos}, which is not the innermost open node`);
    this.#jumps[pos] = this.#length - pos - 1;
    this.#open.pop();
  }

  /**
   * Opens a node at `pos` whose first children are the complete trees already emitted from
   * `pos` to the end. Used for left operands that are parsed before their operator. Close the
   * returned position with `close`. Nodes still open must all precede `pos`.
   */
  openBefore(pos: number, tag: number, info = NO_POSITION): number {
    if (pos < 0 || pos > this.#length) throw new RangeError(`NIF position ${pos} out of range`);
    if ((this.#open.at(-1) ?? -1) >= pos) throw new Error('NIF openBefore across an open node');
    this.#reserve(1);
    this.#tokens.copyWithin(pos + 1, pos, this.#length);
    this.#jumps.copyWithin(pos + 1, pos, this.#length);
    this.#infos.copyWithin(pos + 1, pos, this.#length);
    this.#tokens[pos] = token(NifKind.Tag, tag);
    this.#jumps[pos] = 0;
    this.#infos[pos] = info;
    this.#length++;
    this.#open.push(pos);
    return pos;
  }

  /** Replaces the tag of the node at `pos`. */
  setTag(pos: number, tag: number): void {
    if (this.kind(pos) !== NifKind.Tag) throw new Error(`NIF token ${pos} is not a node`);
    this.#tokens[pos] = token(NifKind.Tag, tag);
  }

  /** Drops everything from `length` on, including nodes opened there. */
  truncate(length: number): void {
    if (length > this.#length) throw new RangeError('NIF truncate beyond the end');
    this.#length = length;
    while (this.#open.length && this.#open.at(-1)! >= length) this.#open.pop();
  }

  /**
   * Appends a copy of the subtree at `pos` of `source`. Both buffers must share a pool; tags are
   * remapped by name when the tag registries differ.
   */
  copyTree(source: NifBuffer, pos: number): void {
    if (source.pool !== this.pool)
      throw new Error('NIF trees can only be copied between buffers sharing a pool');
    const end = source.end(pos),
      n = end - pos,
      start = this.#length;
    this.#reserve(n);
    this.#tokens.set(source.#tokens.subarray(pos, end), start);
    this.#jumps.set(source.#jumps.subarray(pos, end), start);
    this.#infos.set(source.#infos.subarray(pos, end), start);
    this.#length += n;
    if (source.tags === this.tags) return;
    for (let i = start; i < this.#length; i++) {
      const t = this.#tokens[i]!;
      if ((t & KIND_MASK) === NifKind.Tag)
        this.#tokens[i] = token(NifKind.Tag, this.tags.register(source.tags.name(t >>> KIND_BITS)));
    }
  }

  #pushInteger(kind: NifKind, value: number | bigint, info: number): void {
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw new RangeError(`NIF integer ${value} is not a safe integer`);
    const n = typeof value === 'bigint' ? value : BigInt(value);
    if (
      n >= INLINE_INT_MIN &&
      n <= (kind === NifKind.Int ? INLINE_INT_MAX : 2 * INLINE_INT_MAX + 1)
    ) {
      const v = Number(n);
      this.#push(token(kind, (((v < 0 ? v + (1 << 27) : v) << 1) | 1) >>> 0), info);
    } else {
      this.#push(token(kind, this.pool.addBigInt(n) << 1), info);
    }
  }

  #push(word: number, info: number): void {
    this.#reserve(1);
    const i = this.#length++;
    this.#tokens[i] = word;
    this.#jumps[i] = 0;
    this.#infos[i] = info;
  }

  #reserve(n: number): void {
    const need = this.#length + n;
    if (need <= this.#tokens.length) return;
    const capacity = Math.max(need, this.#tokens.length * 2);
    const grow = (a: Uint32Array) => {
      const b = new Uint32Array(capacity);
      b.set(a.subarray(0, this.#length));
      return b;
    };
    this.#tokens = grow(this.#tokens);
    this.#jumps = grow(this.#jumps);
    this.#infos = grow(this.#infos);
  }

  #at(pos: number): number {
    if (!(pos >= 0 && pos < this.#length)) throw new RangeError(`NIF position ${pos} out of range`);
    return this.#tokens[pos]!;
  }
}

function sameAtom(a: NifBuffer, i: number, b: NifBuffer, j: number): boolean {
  if (a.kind(i) !== b.kind(j)) return false;
  switch (a.kind(i)) {
    case NifKind.Dot:
      return true;
    case NifKind.Tag:
      return a.tagName(i) === b.tagName(j);
    case NifKind.Ident:
    case NifKind.Symbol:
    case NifKind.SymbolDef:
    case NifKind.Str:
      return a.text(i) === b.text(j);
    case NifKind.Char:
      return a.char(i) === b.char(j);
    case NifKind.Int:
    case NifKind.UInt:
      return a.integer(i) === b.integer(j);
    case NifKind.Float:
      return Object.is(a.float(i), b.float(j));
  }
}

/** A NIF symbol is a name with a dot that is not its first character (`x.0`, `f.2.mod`). */
export function isSymbolName(name: string): boolean {
  const dot = name.indexOf('.');
  return dot > 0;
}
