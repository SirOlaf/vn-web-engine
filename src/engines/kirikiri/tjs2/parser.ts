import {NifBuffer} from '../../../compiler/nif/buffer.js';
import type {SourceText} from '../../../compiler/source.js';
import {T} from './dialect.js';
import {LexError, Lexer, type Constant, type Token} from './lexer.js';
import type {Tjs2MessageName} from './messages.js';
import {Tok} from './tokens.js';

/**
 * A syntax or lexical error: the native message name, the offset where the native lexer
 * stood when the error was raised, and the `%1` argument of the message.
 */
export class Tjs2SyntaxError extends Error {
  constructor(
    readonly code: Tjs2MessageName,
    readonly offset: number,
    readonly argument?: string,
  ) {
    super(code);
    this.name = 'Tjs2SyntaxError';
  }
}

/** Key of a node in the code-generation point maps: its source line and column. */
export function pointKey(tree: NifBuffer, pos: number): number {
  const [, line, column] = tree.pool.unpack(tree.info(pos), [0, 0, 0]);
  return line * 0x200000 + column;
}

/**
 * Where the native compiler generates code, as source offsets of its lexer at that moment.
 * The generator runs while the parser reduces, so it reports errors there and in that order.
 */
export interface CodegenPoints {
  /** Units compiled at once (a statement, a condition, a variable, a default value, …). */
  readonly units: Map<number, number>;
  /** Node positions of assignments (`MakeNP` for `=`), used by the boolean-context warning. */
  readonly assignments: Map<number, number>;
}

/** A statement being parsed, for recovering the completed part after an error. */
interface Frame {
  /** Output length when the statement started. */
  readonly start: number;
  /** Number of open nodes when the statement started. */
  readonly open: number;
  /** The statement's own node, or -1. */
  node: number;
  /** Set once the native generator has compiled the statement's header. */
  committed: boolean;
  /** Set once the statement's last token has been read. */
  done: boolean;
}

const ASSIGN_OPS = new Map<number, number>([
  [Tok.Equal, T.asgn],
  [Tok.AmpersandEqual, T.bitandasgn],
  [Tok.VertLineEqual, T.bitorasgn],
  [Tok.ChevronEqual, T.bitxorasgn],
  [Tok.MinusEqual, T.subasgn],
  [Tok.PlusEqual, T.addasgn],
  [Tok.PercentEqual, T.modasgn],
  [Tok.SlashEqual, T.divasgn],
  [Tok.BackslashEqual, T.idivasgn],
  [Tok.AsteriskEqual, T.mulasgn],
  [Tok.LogicalOrEqual, T.orasgn],
  [Tok.LogicalAndEqual, T.andasgn],
  [Tok.RArithShiftEqual, T.sarasgn],
  [Tok.LArithShiftEqual, T.shlasgn],
  [Tok.RBitShiftEqual, T.shrasgn],
  [Tok.Swap, T.swap],
]);

/** Binary precedence levels from `logical_or_expr` down to `mul_div_expr`, all left-associative. */
const BINARY_LEVELS: readonly ReadonlyMap<number, number>[] = [
  new Map([[Tok.LogicalOr, T.or]]),
  new Map([[Tok.LogicalAnd, T.and]]),
  new Map([[Tok.VertLine, T.bitor]]),
  new Map([[Tok.Chevron, T.bitxor]]),
  new Map([[Tok.Ampersand, T.bitand]]),
  new Map([
    [Tok.NotEqual, T.neq],
    [Tok.EqualEqual, T.eq],
    [Tok.DiscNotEqual, T.dneq],
    [Tok.DiscEqual, T.deq],
  ]),
  new Map([
    [Tok.Lt, T.lt],
    [Tok.Gt, T.gt],
    [Tok.LtOrEqual, T.le],
    [Tok.GtOrEqual, T.ge],
  ]),
  new Map([
    [Tok.RArithShift, T.sar],
    [Tok.LArithShift, T.shl],
    [Tok.RBitShift, T.shr],
  ]),
  new Map([
    [Tok.Plus, T.add],
    [Tok.Minus, T.sub],
  ]),
  new Map([
    [Tok.Percent, T.mod],
    [Tok.Slash, T.div],
    [Tok.Backslash, T.idiv],
    [Tok.Asterisk, T.mul],
  ]),
];
const MUL_LEVEL = BINARY_LEVELS.length - 1;

const PREFIX_OPS = new Map<number, number>([
  [Tok.Exclamation, T.not],
  [Tok.Tilde, T.bitnot],
  [Tok.Decrement, T.predec],
  [Tok.Increment, T.preinc],
  [Tok.Invalidate, T.invalidate],
  [Tok.Isvalid, T.isvalid],
  [Tok.Delete, T.delete],
  [Tok.Typeof, T.typeof],
  [Tok.Sharp, T.asc],
  [Tok.Dollar, T.chr],
  [Tok.Plus, T.pos],
  [Tok.Minus, T.neg],
  [Tok.Ampersand, T.ignoreprop],
  [Tok.Asterisk, T.propaccess],
  [Tok.Int, T.toint],
  [Tok.Real, T.toreal],
  [Tok.String, T.tostr],
]);

const CASTS = new Map<number, number>([
  [Tok.Int, T.toint],
  [Tok.Real, T.toreal],
  [Tok.String, T.tostr],
]);

/** Tokens that continue a `priority_expr`, so a call before them is not the `new` call. */
const POSTFIX_TOKENS = new Set<number>([
  Tok.LParen,
  Tok.LBracket,
  Tok.Dot,
  Tok.Increment,
  Tok.Decrement,
  Tok.Exclamation,
]);

const TYPE_NAMES = new Set<number>([
  Tok.Symbol,
  Tok.Void,
  Tok.Int,
  Tok.Real,
  Tok.String,
  Tok.Octet,
]);

/**
 * Recursive-descent parser for the TJS2 grammar (`tjs.y` of TJS 2.4.28). It writes the parsed
 * stage of the TJS2 NIF dialect: syntax only, names unresolved. Parentheses leave no node,
 * as in the native expression tree.
 */
export class Parser {
  #tok!: Token;
  readonly #ahead: Token[] = [];
  /** Sequence number of `#tok`, used to find the top of a call argument. */
  #index = 0;
  /** Index of the token that starts the call argument being parsed, or -1. */
  #argStart = -1;
  /** Set when a call argument ended in `expr*` (`mul_div_expr_and_asterisk`). */
  #expandArg = false;
  /** End offset of the last consumed token. */
  #lastEnd = 0;
  readonly #frames: Frame[] = [];
  readonly points: CodegenPoints = {units: new Map(), assignments: new Map()};

  constructor(
    readonly lexer: Lexer,
    readonly out: NifBuffer,
    readonly source: SourceText,
    readonly file: number,
  ) {
    this.#tok = this.#read();
  }

  /** `program`: the statements of a script block, as `(stmts …)`. */
  parseProgram(): void {
    const node = this.out.open(T.stmts, this.#at(this.#tok));
    while (this.#tok.type !== Tok.Eof) this.#statement();
    this.out.close(node);
  }

  // ── tokens ───────────────────────────────────────────────────────────────

  #read(): Token {
    try {
      return this.lexer.next();
    } catch (e) {
      if (e instanceof LexError) throw new Tjs2SyntaxError(e.code, e.offset, e.argument);
      throw e;
    }
  }

  #advance(): Token {
    const t = this.#tok;
    this.#lastEnd = t.end;
    this.#tok = this.#ahead.shift() ?? this.#read();
    this.#index++;
    return t;
  }

  #peek(n = 1): Token {
    while (this.#ahead.length < n) this.#ahead.push(this.#read());
    return this.#ahead[n - 1]!;
  }

  #is(type: number): boolean {
    return this.#tok.type === type;
  }

  #accept(type: number): Token | null {
    return this.#tok.type === type ? this.#advance() : null;
  }

  #expect(type: number): Token {
    if (this.#tok.type !== type) this.#unexpected();
    return this.#advance();
  }

  /**
   * Expects the token that completes a unit of code generation: records the unit at `key`
   * (when given) and the frame's progress before reading further, as the native generator
   * runs before the lexer reads the next token.
   */
  #expectAt(type: number, key: number | null, frame?: Frame, state?: 'committed' | 'done'): Token {
    if (this.#tok.type !== type) this.#unexpected();
    if (key !== null) this.#unit(key, this.#tok.end);
    if (frame && state === 'committed') frame.committed = true;
    if (frame && state === 'done') frame.done = true;
    return this.#advance();
  }

  #unit(pos: number, offset: number): void {
    this.points.units.set(pointKey(this.out, pos), offset);
  }

  /** Bison's message is `syntax error`; the native lexer stands after the offending token. */
  #unexpected(): never {
    throw new Tjs2SyntaxError('TJSSyntaxError', this.#tok.end, 'syntax error');
  }

  #at(t: Token): number {
    const offset = Math.min(t.start, this.source.text.length);
    return this.out.pool.position(this.file, this.source.line(offset), this.source.column(offset));
  }

  #symbol(): Token {
    if (this.#tok.type !== Tok.Symbol) this.#unexpected();
    return this.#advance();
  }

  // ── statements ───────────────────────────────────────────────────────────

  /** A loop, `if`, `with` or `try` body; an empty statement (`;`) is written as `.`. */
  #blockOrStatement(): void {
    if (this.#is(Tok.Semicolon)) this.out.addDot(this.#at(this.#advance()));
    else this.#statement();
  }

  #block(): void {
    const node = this.out.open(T.block, this.#at(this.#expect(Tok.LBrace)));
    while (!this.#is(Tok.RBrace)) {
      if (this.#is(Tok.Eof)) this.#unexpected();
      this.#statement();
    }
    this.#advance();
    this.out.close(node);
  }

  #statement(): void {
    const frame: Frame = {
      start: this.out.length,
      open: this.out.openNodes,
      node: -1,
      committed: false,
      done: false,
    };
    this.#frames.push(frame);
    this.#statementBody(frame);
    frame.done = true;
    this.#frames.pop();
  }

  #statementBody(frame: Frame): void {
    const t = this.#tok,
      out = this.out;
    switch (t.type) {
      case Tok.Semicolon:
        this.#expectAt(Tok.Semicolon, null, frame, 'done');
        return;
      case Tok.LBrace:
        frame.node = out.length;
        this.#block();
        return;
      case Tok.If: {
        const node = (frame.node = out.open(T.if, this.#at(this.#advance())));
        this.#expect(Tok.LParen);
        const cond = out.length;
        this.#expr();
        this.#expectAt(Tok.RParen, cond, frame, 'committed');
        this.#blockOrStatement();
        if (this.#accept(Tok.Else)) this.#blockOrStatement();
        else out.addDot();
        out.close(node);
        return;
      }
      case Tok.While: {
        const node = (frame.node = out.open(T.while, this.#at(this.#advance())));
        this.#expect(Tok.LParen);
        const cond = out.length;
        this.#expr();
        this.#expectAt(Tok.RParen, cond, frame, 'committed');
        this.#blockOrStatement();
        out.close(node);
        return;
      }
      case Tok.Do: {
        const node = (frame.node = out.open(T.dowhile, this.#at(this.#advance())));
        this.#blockOrStatement();
        this.#expect(Tok.While);
        this.#expect(Tok.LParen);
        const cond = out.length;
        this.#expr();
        this.#expectAt(Tok.RParen, cond);
        this.#expectAt(Tok.Semicolon, null, frame, 'done');
        out.close(node);
        return;
      }
      case Tok.For:
        this.#for(frame);
        return;
      case Tok.Break:
      case Tok.Continue:
      case Tok.Debugger: {
        const node = out.open(
          t.type === Tok.Break ? T.brk : t.type === Tok.Continue ? T.cont : T.debugger,
          this.#at(t),
        );
        out.close(node);
        this.#advance();
        this.#expectAt(Tok.Semicolon, node, frame, 'done');
        return;
      }
      case Tok.Var:
      case Tok.Const:
        frame.node = out.length;
        this.#variableDef();
        this.#expectAt(Tok.Semicolon, null, frame, 'done');
        return;
      case Tok.Function:
        if (this.#peek().type === Tok.Symbol) {
          frame.node = out.length;
          this.#function();
          return;
        }
        break;
      case Tok.Property:
        frame.node = out.length;
        this.#property(frame);
        return;
      case Tok.Class:
        frame.node = out.length;
        this.#class();
        return;
      case Tok.Return:
      case Tok.Throw: {
        const node = (frame.node = out.open(
          t.type === Tok.Return ? T.ret : T.throw,
          this.#at(this.#advance()),
        ));
        if (t.type === Tok.Return && this.#is(Tok.Semicolon)) out.addDot();
        else this.#expr();
        this.#expectAt(Tok.Semicolon, node, frame, 'done');
        out.close(node);
        return;
      }
      case Tok.Switch:
      case Tok.With: {
        const node = (frame.node = out.open(
          t.type === Tok.Switch ? T.switch : T.with,
          this.#at(this.#advance()),
        ));
        this.#expect(Tok.LParen);
        const value = out.length;
        this.#expr();
        this.#expectAt(Tok.RParen, value, frame, 'committed');
        if (t.type === Tok.Switch) this.#block();
        else this.#blockOrStatement();
        out.close(node);
        return;
      }
      case Tok.Case: {
        const node = (frame.node = out.open(T.case, this.#at(this.#advance())));
        const value = out.length;
        this.#expr();
        if (!this.#is(Tok.Colon)) this.#unexpected();
        this.#unit(value, this.#tok.end);
        this.#unit(node, this.#tok.end);
        frame.done = true;
        this.#advance();
        out.close(node);
        return;
      }
      case Tok.Default: {
        const node = (frame.node = out.open(T.default, this.#at(this.#advance())));
        out.close(node);
        this.#expectAt(Tok.Colon, node, frame, 'done');
        return;
      }
      case Tok.Try:
        frame.node = out.length;
        this.#try();
        return;
    }
    const start = out.length;
    this.#expr();
    this.#expectAt(Tok.Semicolon, start, frame, 'done');
  }

  /**
   * `(for init cond step body)`. The native generator compiles the first clause at the first
   * `;`, the condition at the second, and the step after the body.
   */
  #for(frame: Frame): void {
    const out = this.out;
    const node = (frame.node = out.open(T.for, this.#at(this.#advance())));
    this.#expect(Tok.LParen);
    const init = out.length;
    if (this.#is(Tok.Semicolon)) out.addDot();
    else if (this.#is(Tok.Var) || this.#is(Tok.Const)) this.#variableDef();
    else this.#expr();
    this.#expectAt(Tok.Semicolon, init, frame, 'committed');
    const cond = out.length;
    if (this.#is(Tok.Semicolon)) out.addDot();
    else this.#expr();
    this.#expectAt(Tok.Semicolon, cond);
    const step = out.length;
    if (this.#is(Tok.RParen)) out.addDot();
    else this.#expr();
    this.#expect(Tok.RParen);
    this.#blockOrStatement();
    this.#unit(step, this.#lastEnd);
    out.close(node);
  }

  /** `variable_def_inner`: `(var (vdef name init|.)…)` or `(const …)`. */
  #variableDef(): void {
    const t = this.#advance();
    const node = this.out.open(t.type === Tok.Var ? T.var : T.const, this.#at(t));
    do {
      const name = this.#symbol();
      const def = this.out.open(T.vdef, this.#at(name));
      this.out.addIdent(name.word!, this.#at(name));
      this.#variableType();
      if (this.#accept(Tok.Equal)) this.#assign();
      else this.out.addDot();
      this.out.close(def);
      // Compiled when the reduction sees the following token.
      this.#unit(def, this.#tok.end);
    } while (this.#accept(Tok.Comma));
    this.out.close(node);
  }

  /** `variable_type`: an ignored `: type` annotation. */
  #variableType(): void {
    if (!this.#accept(Tok.Colon)) return;
    if (!TYPE_NAMES.has(this.#tok.type)) this.#unexpected();
    this.#advance();
  }

  /** `(func name (params …) (block …))`. */
  #function(): void {
    const node = this.out.open(T.func, this.#at(this.#advance()));
    const name = this.#symbol();
    this.out.addIdent(name.word!, this.#at(name));
    this.#functionRest();
    this.out.close(node);
  }

  /** `func_decl_arg_opt variable_type block`. */
  #functionRest(): void {
    const out = this.out;
    const params = out.open(T.params, this.#at(this.#tok));
    if (this.#accept(Tok.LParen)) {
      if (!this.#is(Tok.RParen)) {
        for (;;) {
          if (this.#is(Tok.Asterisk)) {
            const rest = out.open(T.rest, this.#at(this.#advance()));
            out.addDot();
            out.close(rest);
            break;
          }
          const name = this.#symbol();
          this.#variableType();
          if (this.#is(Tok.Asterisk)) {
            const rest = out.open(T.rest, this.#at(name));
            out.addIdent(name.word!, this.#at(name));
            this.#advance();
            out.close(rest);
            break;
          }
          const param = out.open(T.param, this.#at(name));
          out.addIdent(name.word!, this.#at(name));
          if (this.#accept(Tok.Equal)) {
            const value = out.length;
            this.#assign();
            this.#unit(value, this.#tok.end);
          } else out.addDot();
          out.close(param);
          if (!this.#accept(Tok.Comma)) break;
        }
      }
      this.#expect(Tok.RParen);
    }
    out.close(params);
    this.#variableType();
    this.#block();
  }

  /** `(prop name (getter (block …)) (setter v (block …)))`, handlers in source order. */
  #property(frame: Frame): void {
    const out = this.out;
    const node = out.open(T.prop, this.#at(this.#advance()));
    const name = this.#symbol();
    out.addIdent(name.word!, this.#at(name));
    this.#expectAt(Tok.LBrace, null, frame, 'committed');
    let getter = false,
      setter = false;
    while (!this.#is(Tok.RBrace)) {
      if (this.#is(Tok.Getter) && !getter) {
        getter = true;
        const h = out.open(T.getter, this.#at(this.#advance()));
        if (this.#accept(Tok.LParen)) this.#expect(Tok.RParen);
        this.#variableType();
        this.#block();
        out.close(h);
      } else if (this.#is(Tok.Setter) && !setter) {
        setter = true;
        const h = out.open(T.setter, this.#at(this.#advance()));
        this.#expect(Tok.LParen);
        const v = this.#symbol();
        out.addIdent(v.word!, this.#at(v));
        this.#variableType();
        this.#expect(Tok.RParen);
        this.#block();
        out.close(h);
      } else {
        this.#unexpected();
      }
    }
    if (!getter && !setter) this.#unexpected();
    this.#advance();
    out.close(node);
  }

  /** `(class name (extends e…) (block …))`. */
  #class(): void {
    const out = this.out;
    const node = out.open(T.class, this.#at(this.#advance()));
    const name = this.#symbol();
    out.addIdent(name.word!, this.#at(name));
    const ext = out.open(T.extends, this.#at(this.#tok));
    if (this.#accept(Tok.Extends)) {
      do {
        const base = out.length;
        this.#assign();
        this.#unit(base, this.#tok.end);
      } while (this.#accept(Tok.Comma));
    }
    out.close(ext);
    this.#block();
    out.close(node);
  }

  /** `(try body (catch name|.) handler)`. */
  #try(): void {
    const out = this.out;
    const node = out.open(T.try, this.#at(this.#advance()));
    this.#blockOrStatement();
    const c = out.open(T.catch, this.#at(this.#expect(Tok.Catch)));
    if (this.#accept(Tok.LParen)) {
      if (this.#is(Tok.Symbol)) {
        const name = this.#advance();
        out.addIdent(name.word!, this.#at(name));
      } else out.addDot();
      this.#expect(Tok.RParen);
    } else {
      out.addDot();
    }
    out.close(c);
    this.#blockOrStatement();
    out.close(node);
  }

  // ── recovery ─────────────────────────────────────────────────────────────

  /**
   * After an error, reduces the output to what the native generator had compiled: statements
   * and headers that reached their code-generation point stay, incomplete ones are dropped,
   * and open nodes are closed with empty parts. Expression functions inside dropped code are
   * kept as statements, since the native compiler compiles their bodies while parsing.
   * Returns the positions of loops closed this way (their step was never compiled).
   */
  recover(): Set<number> {
    const out = this.out;
    const truncated = new Set<number>();
    const pending = new NifBuffer(out.pool, out.tags);
    const top = () => out.openPositions().at(-1)!;
    for (let f = this.#frames.length - 1; f >= 0; f--) {
      const frame = this.#frames[f]!;
      let kept = frame.done;
      while (out.openNodes > frame.open) {
        const pos = top();
        const own = pos === frame.node;
        if (own ? this.#keepStatement(frame, pos) : this.#keepPart(pos)) {
          this.#forceClose(pos, pending, truncated);
          kept ||= own;
        } else this.#drop(own ? frame.start : pos, pending);
      }
      // A statement whose node is complete but whose last token is missing (`var a = 1 b`).
      const closed = frame.node >= 0 && frame.node < out.length && out.isNode(frame.node);
      if (!kept && !(closed && this.#keepStatement(frame, frame.node)))
        this.#drop(frame.start, pending);
    }
    while (out.openNodes) this.#forceClose(top(), pending, truncated);
    this.#frames.length = 0;
    return truncated;
  }

  /** Whether lexing stopped where the native parser could accept the end of the script. */
  atStatementBoundary(): boolean {
    const open = this.out.openPositions();
    const frames = this.#frames;
    if (!frames.length) return open.length === 1;
    if (!frames.at(-1)!.done) return false;
    // Only statements that may end after their body enclose the last one.
    const enclosing = frames.slice(0, -1);
    return (
      open.length === enclosing.length + 1 &&
      enclosing.every((fr) => [T.if, T.while, T.for, T.with].includes(this.out.tag(fr.node)))
    );
  }

  #keepStatement(frame: Frame, pos: number): boolean {
    const tag = this.out.tag(pos);
    switch (tag) {
      case T.if:
      case T.while:
      case T.switch:
      case T.with:
      case T.for:
      case T.prop:
        return frame.committed;
      case T.dowhile:
      case T.try:
      case T.block:
        return true;
      case T.func:
      case T.class:
      case T.var:
      case T.const:
        return this.#childCount(pos) > 0;
    }
    return false;
  }

  #keepPart(pos: number): boolean {
    const tag = this.out.tag(pos);
    switch (tag) {
      case T.block:
      case T.stmts:
      case T.params:
      case T.extends:
      case T.getter:
      case T.fn:
        return true;
      case T.setter:
      case T.var:
      case T.const:
        return this.#childCount(pos) > 0;
    }
    return false;
  }

  /** Children of a node; an open node's children run to the end of the output. */
  #childCount(pos: number): number {
    const out = this.out;
    if (out.openPositions().at(-1) !== pos) return out.childCount(pos);
    let n = 0;
    for (let c = pos + 1; c < out.length; c = out.next(c)) n++;
    return n;
  }

  #drop(from: number, pending: NifBuffer): void {
    const out = this.out;
    for (let c = from; c < out.length;) {
      if (out.tag(c) === T.fn) {
        pending.copyTree(out, c);
        c = out.end(c);
      } else c++;
    }
    out.truncate(from);
  }

  #forceClose(pos: number, pending: NifBuffer, truncated: Set<number>): void {
    const out = this.out,
      n = this.#childCount(pos),
      info = out.info(pos);
    const dots = (count: number) => {
      for (let i = n; i < count; i++) out.addDot(info);
    };
    const empty = (tag: number) => out.close(out.open(tag, info));
    switch (out.tag(pos)) {
      case T.if:
        dots(3);
        break;
      case T.while:
      case T.dowhile:
      case T.with:
        dots(2);
        break;
      case T.for:
        dots(4);
        truncated.add(pos);
        break;
      case T.switch:
        if (n < 2) empty(T.block);
        break;
      case T.try:
        if (n < 1) out.addDot(info);
        if (n < 2) {
          const c = out.open(T.catch, info);
          out.addDot(info);
          out.close(c);
        }
        if (n < 3) out.addDot(info);
        break;
      case T.func:
      case T.class:
        if (n < 2) empty(out.tag(pos) === T.func ? T.params : T.extends);
        if (n < 3) empty(T.block);
        break;
      case T.fn:
        if (n < 1) empty(T.params);
        if (n < 2) empty(T.block);
        break;
      case T.getter:
        if (n < 1) empty(T.block);
        break;
      case T.setter:
        if (n < 2) empty(T.block);
        break;
      case T.block:
      case T.stmts:
        for (let c = 0; c < pending.length; c = pending.next(c)) out.copyTree(pending, c);
        pending.truncate(0);
        break;
    }
    out.close(pos);
  }

  // ── expressions ──────────────────────────────────────────────────────────

  /** `expr`: a comma expression, optionally followed by `if expr` (postfix if). */
  #expr(): void {
    const start = this.out.length;
    this.#comma();
    if (this.#is(Tok.If)) {
      const node = this.out.openBefore(start, T.postif, this.#at(this.#advance()));
      this.#expr();
      this.out.close(node);
    }
  }

  #comma(): void {
    const start = this.out.length;
    this.#assign();
    while (this.#is(Tok.Comma)) {
      const node = this.out.openBefore(start, T.comma, this.#at(this.#advance()));
      this.#assign();
      this.out.close(node);
    }
  }

  /** `assign_expr` (`expr_no_comma`): right-associative assignments over `cond_expr`. */
  #assign(): void {
    const start = this.out.length;
    this.#cond();
    const tag = ASSIGN_OPS.get(this.#tok.type);
    if (tag === undefined) return;
    const node = this.out.openBefore(start, tag, this.#at(this.#advance()));
    this.#assign();
    this.out.close(node);
    // The node gets its position when the rule reduces, after the following token is read.
    if (tag === T.asgn) this.points.assignments.set(pointKey(this.out, node), this.#tok.end);
  }

  #cond(): void {
    const start = this.out.length;
    this.#binary(0);
    if (!this.#is(Tok.Question)) return;
    const node = this.out.openBefore(start, T.cond, this.#at(this.#advance()));
    this.#cond();
    this.#expect(Tok.Colon);
    this.#cond();
    this.out.close(node);
  }

  #binary(level: number): void {
    if (level === BINARY_LEVELS.length) {
      this.#unary();
      return;
    }
    const start = this.out.length,
      startIndex = this.#index,
      ops = BINARY_LEVELS[level]!;
    this.#binary(level + 1);
    for (;;) {
      const tag = ops.get(this.#tok.type);
      if (tag === undefined) return;
      if (level === MUL_LEVEL && this.#tok.type === Tok.Asterisk && startIndex === this.#argStart) {
        const after = this.#peek().type;
        if (after === Tok.Comma || after === Tok.RParen) {
          // `call_arg: mul_div_expr_and_asterisk` — the argument is expanded.
          this.#advance();
          this.#expandArg = true;
          return;
        }
      }
      const node = this.out.openBefore(start, tag, this.#at(this.#advance()));
      this.#binary(level + 1);
      this.out.close(node);
    }
  }

  /** `unary_expr`. */
  #unary(): void {
    const out = this.out,
      t = this.#tok;
    if (t.type === Tok.LParen) {
      const inner = this.#peek().type;
      const cast = CASTS.get(inner);
      if (cast !== undefined && this.#peek(2).type === Tok.RParen) {
        const node = out.open(cast, this.#at(t));
        this.#advance();
        this.#advance();
        this.#advance();
        this.#unary();
        out.close(node);
        return;
      }
    }
    if (t.type === Tok.New) {
      this.#advance();
      this.#priority(this.#at(t));
      return;
    }
    const prefix = PREFIX_OPS.get(t.type);
    if (prefix !== undefined) {
      const node = out.open(prefix, this.#at(this.#advance()));
      this.#unary();
      out.close(node);
      return;
    }
    const start = out.length;
    this.#incontextof();
    if (this.#is(Tok.Isvalid)) {
      out.close(out.openBefore(start, T.isvalid, this.#at(this.#advance())));
    } else if (this.#is(Tok.Instanceof)) {
      const node = out.openBefore(start, T.instanceof, this.#at(this.#advance()));
      this.#unary();
      out.close(node);
    }
  }

  #incontextof(): void {
    const start = this.out.length;
    this.#priority();
    if (!this.#is(Tok.Incontextof)) return;
    const node = this.out.openBefore(start, T.incontextof, this.#at(this.#advance()));
    this.#incontextof();
    this.out.close(node);
  }

  /**
   * `priority_expr`: a primary followed by member, index, call and postfix operators. With
   * `newAt`, parses `new func_call_expr`: the last call of the chain becomes the `new` node.
   */
  #priority(newAt?: number): void {
    const out = this.out,
      start = out.length,
      t = this.#tok;
    if (t.type === Tok.LParen && this.#peek().type !== Tok.Const) {
      this.#advance();
      const saved = this.#argStart;
      this.#argStart = -1;
      this.#expr();
      this.#argStart = saved;
      this.#expect(Tok.RParen);
    } else if (t.type === Tok.Dot) {
      this.#advance();
      const name = this.#bareWord();
      const node = out.open(T.wdot, this.#at(t));
      out.addString(name.word!, this.#at(name));
      out.close(node);
    } else {
      this.#factor();
    }
    for (;;) {
      const op = this.#tok;
      switch (op.type) {
        case Tok.LBracket: {
          const node = out.openBefore(start, T.at, this.#at(this.#advance()));
          const saved = this.#argStart;
          this.#argStart = -1;
          this.#expr();
          this.#argStart = saved;
          this.#expect(Tok.RBracket);
          out.close(node);
          continue;
        }
        case Tok.Dot: {
          const node = out.openBefore(start, T.dot, this.#at(this.#advance()));
          const name = this.#bareWord();
          out.addString(name.word!, this.#at(name));
          out.close(node);
          continue;
        }
        case Tok.LParen: {
          const node = out.openBefore(start, T.call, this.#at(op));
          this.#callArgs();
          out.close(node);
          if (newAt !== undefined && !POSTFIX_TOKENS.has(this.#tok.type)) {
            out.setTag(node, T.new);
            out.setInfo(node, newAt);
            return;
          }
          continue;
        }
        case Tok.Increment:
        case Tok.Decrement:
        case Tok.Exclamation:
          out.close(
            out.openBefore(
              start,
              op.type === Tok.Increment
                ? T.postinc
                : op.type === Tok.Decrement
                  ? T.postdec
                  : T.eval,
              this.#at(this.#advance()),
            ),
          );
          continue;
      }
      break;
    }
    if (newAt !== undefined) this.#unexpected();
  }

  /** A member name after `.`: any word, reserved or not (`SetNextIsBareWord`). */
  #bareWord(): Token {
    if (this.#tok.word === undefined) this.#unexpected();
    return this.#advance();
  }

  /** `( call_arg_list )`: `.` for an omitted argument, `(expand e)`, `(expand)`, `(omit)`. */
  #callArgs(): void {
    const out = this.out;
    this.#expect(Tok.LParen);
    if (this.#is(Tok.Omit)) {
      out.close(out.open(T.omit, this.#at(this.#advance())));
      this.#expect(Tok.RParen);
      return;
    }
    const savedStart = this.#argStart,
      savedExpand = this.#expandArg;
    const first = out.length;
    let count = 0;
    for (;;) {
      const t = this.#tok;
      if (t.type === Tok.Comma || t.type === Tok.RParen) {
        out.addDot(this.#at(t));
      } else if (
        t.type === Tok.Asterisk &&
        (this.#peek().type === Tok.Comma || this.#peek().type === Tok.RParen)
      ) {
        out.close(out.open(T.expand, this.#at(this.#advance())));
      } else {
        const start = out.length;
        this.#argStart = this.#index;
        this.#expandArg = false;
        this.#assign();
        if (this.#expandArg) out.close(out.openBefore(start, T.expand, this.#at(t)));
      }
      count++;
      if (!this.#accept(Tok.Comma)) break;
    }
    this.#argStart = savedStart;
    this.#expandArg = savedExpand;
    this.#expect(Tok.RParen);
    // A single empty argument is no argument: `f()`.
    if (count === 1 && out.length === first + 1 && out.isDot(first)) out.truncate(first);
  }

  /** `factor_expr`. */
  #factor(): void {
    const out = this.out,
      t = this.#tok,
      at = this.#at(t);
    switch (t.type) {
      case Tok.ConstVal:
        this.#advance();
        this.#constant(t.value!, at);
        return;
      case Tok.Symbol:
        this.#advance();
        out.addIdent(t.word!, at);
        return;
      case Tok.This:
      case Tok.Super:
      case Tok.Global:
      case Tok.Void:
        this.#advance();
        out.close(
          out.open(
            t.type === Tok.This
              ? T.this
              : t.type === Tok.Super
                ? T.super
                : t.type === Tok.Global
                  ? T.global
                  : T.void,
            at,
          ),
        );
        return;
      case Tok.Function: {
        this.#advance();
        const node = out.open(T.fn, at);
        this.#functionRest();
        out.close(node);
        return;
      }
      case Tok.LBracket:
        this.#inlineArray();
        return;
      case Tok.Percent:
        if (this.#peek().type === Tok.LBracket) {
          this.#inlineDictionary();
          return;
        }
        break;
      case Tok.LParen:
        if (this.#peek().type === Tok.Const && this.#peek(2).type === Tok.RParen) {
          this.#advance();
          this.#advance();
          this.#advance();
          this.#constLiteral();
          return;
        }
        break;
      case Tok.Slash:
      case Tok.SlashEqual: {
        this.#ahead.length = 0;
        let r: Token;
        try {
          r = this.lexer.rescanRegExp(t);
        } catch (e) {
          if (e instanceof LexError) throw new Tjs2SyntaxError(e.code, e.offset, e.argument);
          throw e;
        }
        this.#tok = r;
        this.#advance();
        const node = out.open(T.regexp, at);
        out.addString(r.regexp!.pattern, at);
        out.addString(r.regexp!.flags, at);
        out.close(node);
        return;
      }
    }
    this.#unexpected();
  }

  #constant(value: Constant, at: number): void {
    const out = this.out;
    switch (value.type) {
      case 'int':
        out.addInt(value.value, at);
        return;
      case 'real':
        if (Number.isNaN(value.value)) out.close(out.open(T.nan, at));
        else if (value.value === Infinity) out.close(out.open(T.inf, at));
        else if (value.value === -Infinity) out.close(out.open(T.neginf, at));
        else out.addFloat(value.value, at);
        return;
      case 'string':
        out.addString(value.value, at);
        return;
      case 'octet': {
        const node = out.open(T.octet, at);
        out.addString(Array.from(value.value, (b) => b.toString(16).padStart(2, '0')).join(''), at);
        out.close(node);
        return;
      }
      case 'null':
        out.close(out.open(T.null, at));
        return;
    }
  }

  /** `[ … ]`: `(arr e|.…)`; `[]` is the empty array. */
  #inlineArray(): void {
    const out = this.out;
    const node = out.open(T.arr, this.#at(this.#advance()));
    const saved = this.#argStart;
    this.#argStart = -1;
    const first = out.length;
    let count = 0;
    for (;;) {
      if (this.#is(Tok.Comma) || this.#is(Tok.RBracket)) out.addDot(this.#at(this.#tok));
      else this.#assign();
      count++;
      if (!this.#accept(Tok.Comma)) break;
    }
    this.#argStart = saved;
    this.#expect(Tok.RBracket);
    if (count === 1 && out.length === first + 1 && out.isDot(first)) out.truncate(first);
    out.close(node);
  }

  /** `%[ … ]`: `(dict (kv k v)…)`; `name: v` keys become strings. */
  #inlineDictionary(): void {
    const out = this.out;
    const node = out.open(T.dict, this.#at(this.#advance()));
    this.#advance();
    const saved = this.#argStart;
    this.#argStart = -1;
    let count = 0;
    for (;;) {
      if (this.#is(Tok.RBracket)) break;
      if (count === 0 && this.#is(Tok.Comma) && this.#peek().type === Tok.RBracket) {
        this.#advance();
        break;
      }
      const t = this.#tok;
      const kv = out.open(T.kv, this.#at(t));
      if (t.type === Tok.Symbol && this.#peek().type === Tok.Colon) {
        this.#advance();
        this.#advance();
        out.addString(t.word!, this.#at(t));
      } else {
        this.#assign();
        this.#expect(Tok.Comma);
      }
      this.#assign();
      out.close(kv);
      count++;
      if (!this.#accept(Tok.Comma)) break;
    }
    this.#argStart = saved;
    this.#expect(Tok.RBracket);
    out.close(node);
  }

  /** `(const) [ … ]` and `(const) %[ … ]`: `(carr …)`, `(cdict (kv k v)…)`. */
  #constLiteral(): void {
    const out = this.out;
    if (this.#is(Tok.LBracket)) {
      const node = out.open(T.carr, this.#at(this.#advance()));
      if (!this.#is(Tok.RBracket)) {
        do this.#constElement();
        while (this.#accept(Tok.Comma));
      }
      this.#expect(Tok.RBracket);
      out.close(node);
      return;
    }
    if (this.#is(Tok.Percent) && this.#peek().type === Tok.LBracket) {
      const node = out.open(T.cdict, this.#at(this.#advance()));
      this.#advance();
      if (!this.#is(Tok.RBracket)) {
        do {
          const key = this.#expect(Tok.ConstVal);
          const kv = out.open(T.kv, this.#at(key));
          this.#constant(key.value!, this.#at(key));
          this.#expect(Tok.Comma);
          this.#constElement();
          out.close(kv);
        } while (this.#accept(Tok.Comma));
      }
      this.#expect(Tok.RBracket);
      out.close(node);
      return;
    }
    this.#unexpected();
  }

  /** `const_array_elm`: a constant, `-`/`+` constant, `void`, or a nested const literal. */
  #constElement(): void {
    const out = this.out,
      t = this.#tok;
    if (t.type === Tok.Minus || t.type === Tok.Plus) {
      const node = out.open(t.type === Tok.Minus ? T.neg : T.pos, this.#at(this.#advance()));
      const c = this.#expect(Tok.ConstVal);
      this.#constant(c.value!, this.#at(c));
      out.close(node);
    } else if (t.type === Tok.ConstVal) {
      this.#advance();
      this.#constant(t.value!, this.#at(t));
    } else if (t.type === Tok.Void) {
      out.close(out.open(T.void, this.#at(this.#advance())));
    } else if (
      t.type === Tok.LParen &&
      this.#peek().type === Tok.Const &&
      this.#peek(2).type === Tok.RParen
    ) {
      this.#advance();
      this.#advance();
      this.#advance();
      this.#constLiteral();
    } else {
      this.#unexpected();
    }
  }
}
