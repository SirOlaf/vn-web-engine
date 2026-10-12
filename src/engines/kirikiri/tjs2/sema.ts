import {NifBuffer, NifKind} from '../../../compiler/nif/buffer.js';
import {T} from './dialect.js';
import type {Tjs2MessageName} from './messages.js';
import {pointKey, type CodegenPoints} from './parser.js';

/**
 * Semantic analysis of a parsed TJS2 script block, following the code generator of TJS 2.4
 * (`tjsInterCodeGen.cpp`), which resolves names while it emits code:
 *
 * - Every function, expression function, property, getter, setter and class is a context with
 *   its own local namespace. There are no closures: a name that is not a local of the current
 *   context goes through the this-proxy (`this`, then `global`) at run time.
 * - Names resolve in compilation order. A local is visible from its declaration on; `delete`
 *   of a local removes it from the namespace; a `for` step is compiled after the loop body.
 * - `var` creates a local when the namespace depth is at least 1 (2 in a class), and a member
 *   of `this` otherwise (top level, class body).
 * - Declared functions, properties and classes are registered by context: hoisted onto `this`
 *   at the top level, members of an enclosing function or class object, and additionally a
 *   local variable for a function declared in a function.
 *
 * It also reports what the native generator rejects: assignment to a non-lvalue, a value taken
 * from a statement-only operator, `super` without a single base class, misplaced
 * `break`/`continue`/`case`. Each report carries the offset where the native lexer stood when
 * the generator compiled the enclosing unit (`LEX_POS`), which decides the reported line and
 * the order of reports.
 */
export function analyze(src: NifBuffer, root: number, options: AnalyzeOptions): AnalyzeResult {
  return new Analyzer(src, options).script(root);
}

export interface AnalyzeOptions {
  /** Code-generation points recorded by the parser. */
  readonly points: CodegenPoints;
  /** Loops whose step the native generator never compiled (the script ended in their body). */
  readonly truncatedLoops?: ReadonlySet<number>;
  /** `-unaryaster=compat`: unary `*` ignores property handlers and unary `&` reads them. */
  readonly unaryAsteriskIgnoresPropAccess?: boolean;
  /** `-evalcontext=global`: warns about the post-`!` operator outside the top level. */
  readonly evalOperatorIsOnGlobal?: boolean;
}

export interface SemaDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: Tjs2MessageName;
  /** Source offset whose line is reported. */
  readonly offset: number;
  /** Source offset of the lexer when the report was made; orders reports. */
  readonly order: number;
}

export interface AnalyzeResult {
  readonly tree: NifBuffer;
  readonly root: number;
  readonly diagnostics: SemaDiagnostic[];
}

type ContextKind =
  'toplevel' | 'function' | 'exprfunction' | 'property' | 'getter' | 'setter' | 'class';

type NestKind =
  'block' | 'while' | 'dowhile' | 'for' | 'switch' | 'with' | 'try' | 'catch' | 'if' | 'else';

interface Nest {
  readonly kind: NestKind;
  readonly withSymbol?: string;
}

interface Context {
  readonly kind: ContextKind;
  readonly parent: Context | null;
  /** Namespace levels (`tTJSLocalNamespace`), innermost last: name → symbol. */
  readonly levels: Map<string, string>[];
  readonly nest: Nest[];
  /** Parsed position of the only base-class expression (`SuperClassExpr`), or -1. */
  superExpr: number;
}

/**
 * How the generator uses a node (`restype` and `tSubParam::SubType`): whether its value is
 * needed, whether as a condition, and which modification is applied to it.
 */
const enum Sub {
  None,
  Equal,
  Op,
  Inc,
  Delete,
  TypeOf,
  FuncCall,
  IgnorePropGet,
  IgnorePropSet,
}

const CONSTANT_TAGS = new Set<number>([
  T.nan,
  T.inf,
  T.neginf,
  T.null,
  T.octet,
  T.carr,
  T.cdict,
  T.fn,
]);

const BINARY = new Set<number>([
  T.add,
  T.sub,
  T.mul,
  T.div,
  T.idiv,
  T.mod,
  T.shl,
  T.sar,
  T.shr,
  T.bitand,
  T.bitor,
  T.bitxor,
  T.eq,
  T.neq,
  T.deq,
  T.dneq,
  T.lt,
  T.gt,
  T.le,
  T.ge,
]);

const OP_ASSIGN = new Set<number>([
  T.addasgn,
  T.subasgn,
  T.mulasgn,
  T.divasgn,
  T.idivasgn,
  T.modasgn,
  T.shlasgn,
  T.sarasgn,
  T.shrasgn,
  T.bitandasgn,
  T.bitorasgn,
  T.bitxorasgn,
  T.andasgn,
  T.orasgn,
]);

const VALUE_UNARY = new Set<number>([
  T.bitnot,
  T.neg,
  T.pos,
  T.isvalid,
  T.invalidate,
  T.eval,
  T.chr,
  T.asc,
  T.toint,
  T.toreal,
  T.tostr,
]);

const MODIFY_UNARY = new Map<number, Sub>([
  [T.delete, Sub.Delete],
  [T.preinc, Sub.Inc],
  [T.predec, Sub.Inc],
  [T.postinc, Sub.Inc],
  [T.postdec, Sub.Inc],
]);

class Analyzer {
  #out: NifBuffer;
  #ctx: Context = {kind: 'toplevel', parent: null, levels: [], nest: [], superExpr: -1};
  #serial = 0;
  /** Top-level declarations in registration order. */
  readonly #hoisted: string[] = [];
  /** `AsGlobalContextMode`: set while compiling the base-class expression for `super`. */
  #globalMode = false;
  /** Lexer offset of the unit being compiled (`LEX_POS`). */
  #at = 0;
  /** Reports are suppressed while > 0: code the native generator skips. */
  #mute = 0;
  readonly diagnostics: SemaDiagnostic[] = [];

  constructor(
    readonly src: NifBuffer,
    readonly options: AnalyzeOptions,
  ) {
    this.#out = new NifBuffer(src.pool, src.tags, src.length + 64);
  }

  script(root: number): AnalyzeResult {
    const src = this.src;
    const body = this.#out;
    for (let c = root + 1, end = src.end(root); c < end; c = src.next(c)) this.#statement(c);
    const out = new NifBuffer(src.pool, src.tags, body.length + this.#hoisted.length + 8);
    const script = out.open(T.script, src.info(root));
    const hoist = out.open(T.hoist, src.info(root));
    for (const symbol of this.#hoisted) out.addSymbol(symbol);
    out.close(hoist);
    for (let c = 0; c < body.length; c = body.next(c)) out.copyTree(body, c);
    out.close(script);
    return {tree: out, root: script, diagnostics: this.diagnostics};
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** `_yyerror` from the generator: reported at the current lexer offset. */
  #error(code: Tjs2MessageName, severity: 'error' | 'warning' = 'error', offset = this.#at): void {
    if (this.#mute) return;
    this.diagnostics.push({severity, code, offset, order: this.#at});
  }

  #cannotModify(): void {
    this.#error('TJSCannotModifyLHS');
  }

  /** Compiles the unit rooted at `pos` with the lexer offset the parser recorded for it. */
  #unit(pos: number, compile: () => void): void {
    const saved = this.#at;
    this.#at = this.options.points.units.get(pointKey(this.src, pos)) ?? saved;
    try {
      compile();
    } finally {
      this.#at = saved;
    }
  }

  #symbol(base: string): string {
    return `${base}.${this.#serial++}`;
  }

  #open(tag: number, from: number): number {
    return this.#out.open(tag, this.src.info(from));
  }

  /** Copies an atom or a subtree that analysis does not change. */
  #copy(pos: number): void {
    this.#out.copyTree(this.src, pos);
  }

  /** Runs `emit` against a scratch buffer and returns it. */
  #capture(emit: () => void): NifBuffer {
    const saved = this.#out;
    const scratch = new NifBuffer(this.src.pool, this.src.tags);
    this.#out = scratch;
    try {
      emit();
    } finally {
      this.#out = saved;
    }
    return scratch;
  }

  #paste(scratch: NifBuffer): void {
    for (let c = 0; c < scratch.length; c = scratch.next(c)) this.#out.copyTree(scratch, c);
  }

  // ── namespaces ───────────────────────────────────────────────────────────

  #enterBlock(): void {
    this.#ctx.levels.push(new Map());
    this.#ctx.nest.push({kind: 'block'});
  }

  #exitBlock(): void {
    this.#ctx.levels.pop();
    this.#ctx.nest.pop();
  }

  #find(name: string): string | undefined {
    const levels = this.#ctx.levels;
    for (let i = levels.length - 1; i >= 0; i--) {
      const symbol = levels[i]!.get(name);
      if (symbol !== undefined) return symbol;
    }
    return undefined;
  }

  /** `Namespace.Add`: a name already in the innermost level keeps its symbol. */
  #declare(name: string): {symbol: string; fresh: boolean} {
    const top = this.#ctx.levels.at(-1);
    if (!top) throw new Error('declaration outside a namespace level');
    const existing = top.get(name);
    if (existing !== undefined) return {symbol: existing, fresh: false};
    const symbol = this.#symbol(name);
    top.set(name, symbol);
    return {symbol, fresh: true};
  }

  #remove(name: string): void {
    const levels = this.#ctx.levels;
    for (let i = levels.length - 1; i >= 0; i--) if (levels[i]!.delete(name)) return;
  }

  /** `AddLocalVariable`: a local at namespace depth ≥ 1 (≥ 2 in a class), else a member of `this`. */
  #isLocalLevel(): boolean {
    return this.#ctx.levels.length >= (this.#ctx.kind === 'class' ? 2 : 1);
  }

  /** Emits `(local :x.N init)` or `(member "x" init)`; `init` emits the initial value or nothing. */
  #variable(name: string, at: number, init: (() => void) | null): void {
    const value = init ? this.#capture(init) : null;
    const out = this.#out;
    if (this.#isLocalLevel()) {
      const {symbol, fresh} = this.#declare(name);
      const node = this.#open(T.local, at);
      if (fresh) out.addSymbolDef(symbol, this.src.info(at));
      else out.addSymbol(symbol, this.src.info(at));
      if (value) this.#paste(value);
      else out.addDot();
      out.close(node);
    } else {
      const node = this.#open(T.member, at);
      out.addString(name, this.src.info(at));
      if (value) this.#paste(value);
      else out.addDot();
      out.close(node);
    }
  }

  // ── statements ───────────────────────────────────────────────────────────

  #statement(pos: number): void {
    const src = this.src,
      out = this.#out,
      tag = src.tag(pos);
    if (src.isDot(pos)) {
      out.addDot(src.info(pos));
      return;
    }
    switch (tag) {
      case T.block:
        this.#block(pos);
        return;
      case T.var:
      case T.const:
        for (let c = pos + 1, end = src.end(pos); c < end; c = src.next(c)) this.#vdef(c);
        return;
      case T.if: {
        const [cond, then, otherwise] = src.children(pos);
        const node = this.#open(T.if, pos);
        this.#ctx.nest.push({kind: 'if'});
        this.#unitExpr(cond!, true, true);
        this.#statement(then!);
        this.#ctx.nest.pop();
        if (src.isDot(otherwise!)) out.addDot();
        else {
          this.#ctx.nest.push({kind: 'else'});
          this.#statement(otherwise!);
          this.#ctx.nest.pop();
        }
        out.close(node);
        return;
      }
      case T.while: {
        const [cond, body] = src.children(pos);
        const node = this.#open(T.while, pos);
        this.#ctx.nest.push({kind: 'while'});
        this.#unitExpr(cond!, true, true);
        this.#statement(body!);
        this.#ctx.nest.pop();
        out.close(node);
        return;
      }
      case T.dowhile: {
        const [body, cond] = src.children(pos);
        const node = this.#open(T.dowhile, pos);
        this.#ctx.nest.push({kind: 'dowhile'});
        this.#statement(body!);
        this.#unitExpr(cond!, true, true);
        this.#ctx.nest.pop();
        out.close(node);
        return;
      }
      case T.for:
        this.#for(pos);
        return;
      case T.brk:
      case T.cont: {
        const loops: readonly NestKind[] =
          tag === T.brk ? ['while', 'dowhile', 'for', 'switch'] : ['while', 'dowhile', 'for'];
        if (!this.#ctx.nest.some((n) => loops.includes(n.kind)))
          this.#unit(pos, () => this.#error('TJSMisplacedBreakContinue'));
        this.#copy(pos);
        return;
      }
      case T.debugger:
        this.#copy(pos);
        return;
      case T.func:
        this.#function(pos, 'function');
        return;
      case T.prop:
        this.#property(pos);
        return;
      case T.class:
        this.#class(pos);
        return;
      case T.ret: {
        const value = pos + 1;
        const node = this.#open(T.ret, pos);
        if (src.isDot(value)) out.addDot();
        else this.#unit(pos, () => this.#expr(value, true, false, Sub.None));
        out.close(node);
        return;
      }
      case T.switch:
        this.#switch(pos);
        return;
      case T.with: {
        const [value, body] = src.children(pos);
        const symbol = this.#symbol('with');
        const node = this.#open(T.with, pos);
        out.addSymbolDef(symbol, src.info(pos));
        this.#unitExpr(value!, true, false);
        this.#ctx.nest.push({kind: 'with', withSymbol: symbol});
        this.#enterBlock();
        this.#statement(body!);
        this.#exitBlock();
        this.#ctx.nest.pop();
        out.close(node);
        return;
      }
      case T.case:
      case T.default:
        this.#unit(pos, () => this.#error('TJSMisplacedCase'));
        return;
      case T.try:
        this.#try(pos);
        return;
      case T.throw: {
        const node = this.#open(T.throw, pos);
        this.#unit(pos, () => this.#expr(pos + 1, true, false, Sub.None));
        out.close(node);
        return;
      }
    }
    this.#unitExpr(pos, false, false);
  }

  #unitExpr(pos: number, needed: boolean, cond: boolean): void {
    this.#unit(pos, () => this.#expr(pos, needed, cond, Sub.None));
  }

  #block(pos: number): void {
    const src = this.src;
    const node = this.#open(T.block, pos);
    this.#enterBlock();
    for (let c = pos + 1, end = src.end(pos); c < end; c = src.next(c)) this.#statement(c);
    this.#exitBlock();
    this.#out.close(node);
  }

  /** `(vdef name init)`: the initial value is compiled before the variable is declared. */
  #vdef(pos: number): void {
    const [name, init] = this.src.children(pos);
    this.#unit(pos, () =>
      this.#variable(
        this.src.text(name!),
        name!,
        this.src.isDot(init!) ? null : () => this.#expr(init!, true, false, Sub.None),
      ),
    );
  }

  /** `(for init cond body step)`: the step follows the body, the order in which it is compiled. */
  #for(pos: number): void {
    const src = this.src,
      out = this.#out;
    const [init, cond, step, body] = src.children(pos);
    const node = this.#open(T.for, pos);
    this.#ctx.nest.push({kind: 'for'});
    this.#enterBlock();
    if (src.isDot(init!)) out.addDot();
    else if (src.isNode(init!, T.var) || src.isNode(init!, T.const)) {
      const list = this.#open(T.stmts, init!);
      this.#statement(init!);
      out.close(list);
    } else this.#unitExpr(init!, false, false);
    if (src.isDot(cond!)) out.addDot();
    else this.#unitExpr(cond!, true, true);
    this.#statement(body!);
    if (src.isDot(step!) || this.options.truncatedLoops?.has(pos)) out.addDot();
    else this.#unitExpr(step!, false, false);
    this.#exitBlock();
    this.#ctx.nest.pop();
    out.close(node);
  }

  /**
   * `(switch value (block pre…) (case e (block …)) (default (block …)))`. Each section is its
   * own scope; a case expression is compiled after the previous section's scope is closed.
   */
  #switch(pos: number): void {
    const src = this.src,
      out = this.#out;
    const [value, block] = src.children(pos);
    const node = this.#open(T.switch, pos);
    this.#unitExpr(value!, true, false);
    this.#ctx.nest.push({kind: 'switch'});
    this.#enterBlock();
    this.#enterBlock();
    let section = this.#open(T.block, block!);
    let label = -1;
    for (let c = block! + 1, end = src.end(block!); c < end; c = src.next(c)) {
      const tag = src.tag(c);
      if (tag !== T.case && tag !== T.default) {
        this.#statement(c);
        continue;
      }
      out.close(section);
      if (label >= 0) out.close(label);
      this.#exitBlock();
      label = this.#open(tag, c);
      if (tag === T.case) this.#unitExpr(c + 1, true, false);
      this.#enterBlock();
      section = this.#open(T.block, c);
    }
    out.close(section);
    if (label >= 0) out.close(label);
    this.#exitBlock();
    this.#exitBlock();
    this.#ctx.nest.pop();
    out.close(node);
  }

  #try(pos: number): void {
    const src = this.src,
      out = this.#out;
    const [body, handler, recovery] = src.children(pos);
    const node = this.#open(T.try, pos);
    const nest: {kind: NestKind} = {kind: 'try'};
    this.#ctx.nest.push(nest);
    this.#statement(body!);
    this.#ctx.nest.pop();
    this.#ctx.nest.push({kind: 'catch'});
    const name = handler! + 1;
    const c = this.#open(T.catch, handler!);
    const named = !src.isDot(name);
    if (named) {
      this.#enterBlock();
      out.addSymbolDef(this.#declare(src.text(name)).symbol, src.info(name));
    } else out.addDot();
    out.close(c);
    this.#statement(recovery!);
    if (named) this.#exitBlock();
    this.#ctx.nest.pop();
    out.close(node);
  }

  // ── contexts ─────────────────────────────────────────────────────────────

  /**
   * How a declared context is made reachable (`RegisterFunction`): `hoist` onto `this` before
   * the top level runs, `member` of the enclosing function or class object, `local` (a function
   * in a function: a local variable and a member of the enclosing function), or `none`.
   */
  #registration(kind: ContextKind): 'hoist' | 'member' | 'local' | 'none' {
    const parent = this.#ctx.kind;
    if (kind !== 'function' && kind !== 'property' && kind !== 'class') return 'none';
    if (parent === 'toplevel') return 'hoist';
    if (kind === 'function' && parent === 'function') return 'local';
    if (parent === 'function' || parent === 'class') return 'member';
    return 'none';
  }

  #push(kind: ContextKind): void {
    this.#ctx = {kind, parent: this.#ctx, levels: [], nest: [], superExpr: -1};
  }

  #pop(): void {
    this.#ctx = this.#ctx.parent!;
  }

  /** `(func :f.N "f" reg (params …) (block …))` and `(fn :anon.N (params …) (block …))`. */
  #function(pos: number, kind: 'function' | 'exprfunction'): void {
    const src = this.src,
      out = this.#out;
    const children = src.children(pos);
    const named = kind === 'function';
    const name = named ? src.text(children[0]!) : '(anonymous)';
    const [params, body] = named ? children.slice(1) : children;
    const registration = this.#registration(kind);
    const symbol = this.#symbol(named ? name : 'anon');
    const node = this.#open(named ? T.func : T.fn, pos);
    out.addSymbolDef(symbol, src.info(pos));
    if (named) {
      out.addString(name, src.info(children[0]!));
      out.addIdent(registration);
    }
    // The body is compiled while parsing, whatever the enclosing expression's generator skips.
    const mute = this.#mute;
    this.#mute = 0;
    this.#push(kind);
    this.#enterBlock();
    this.#params(params!);
    this.#block(body!);
    this.#exitBlock();
    this.#pop();
    this.#mute = mute;
    out.close(node);
    this.#register(registration, symbol, name, pos);
  }

  /** Parameters are locals of the first level; a default value sees its own parameter. */
  #params(pos: number): void {
    const src = this.src,
      out = this.#out;
    const node = this.#open(T.params, pos);
    for (let c = pos + 1, end = src.end(pos); c < end; c = src.next(c)) {
      const [name, init] = src.children(c);
      const p = this.#open(src.tag(c), c);
      if (src.isDot(name!)) out.addDot();
      else {
        const {symbol, fresh} = this.#declare(src.text(name!));
        if (fresh) out.addSymbolDef(symbol, src.info(name!));
        else out.addSymbol(symbol, src.info(name!));
      }
      if (init !== undefined) {
        if (src.isDot(init)) out.addDot();
        else this.#unitExpr(init, true, false);
      }
      out.close(p);
    }
    out.close(node);
  }

  #register(registration: string, symbol: string, name: string, pos: number): void {
    if (registration === 'hoist') this.#hoisted.push(symbol);
    else if (registration === 'local')
      this.#variable(name, pos, () => this.#out.addSymbol(symbol, this.src.info(pos)));
  }

  /** `(prop :p.N "p" reg (getter :getter.N (block …)) (setter :setter.N (param :v.N) (block …)))`. */
  #property(pos: number): void {
    const src = this.src,
      out = this.#out;
    const [nameAt, ...handlers] = src.children(pos);
    const name = src.text(nameAt!);
    const registration = this.#registration('property');
    const symbol = this.#symbol(name);
    const node = this.#open(T.prop, pos);
    out.addSymbolDef(symbol, src.info(pos));
    out.addString(name, src.info(nameAt!));
    out.addIdent(registration);
    this.#push('property');
    for (const h of handlers) {
      const getter = src.isNode(h, T.getter);
      const handler = this.#open(getter ? T.getter : T.setter, h);
      out.addSymbolDef(this.#symbol(getter ? 'getter' : 'setter'), src.info(h));
      this.#push(getter ? 'getter' : 'setter');
      this.#enterBlock();
      if (!getter) {
        const v = h + 1;
        const param = this.#open(T.param, v);
        out.addSymbolDef(this.#declare(src.text(v)).symbol, src.info(v));
        out.addDot();
        out.close(param);
      }
      this.#block(src.children(h).at(-1)!);
      this.#exitBlock();
      this.#pop();
      out.close(handler);
    }
    this.#pop();
    out.close(node);
    this.#register(registration, symbol, name, pos);
  }

  /** `(class :C.N "C" reg (extends e…) (block …))`; a single base class is what `super` reads. */
  #class(pos: number): void {
    const src = this.src,
      out = this.#out;
    const [nameAt, ext, body] = src.children(pos);
    const name = src.text(nameAt!);
    const registration = this.#registration('class');
    const symbol = this.#symbol(name);
    const node = this.#open(T.class, pos);
    out.addSymbolDef(symbol, src.info(pos));
    out.addString(name, src.info(nameAt!));
    out.addIdent(registration);
    this.#push('class');
    const bases = src.children(ext!);
    const e = this.#open(T.extends, ext!);
    for (const base of bases) this.#unitExpr(base, true, false);
    out.close(e);
    this.#ctx.superExpr = bases.length === 1 ? bases[0]! : -1;
    this.#block(body!);
    this.#pop();
    out.close(node);
    this.#register(registration, symbol, name, pos);
  }

  // ── expressions ──────────────────────────────────────────────────────────

  /**
   * Analyses the expression at `pos` (`GenNodeCode`): `needed` when its value is used, `cond`
   * when as a condition, `sub` the modification applied to it.
   */
  #expr(pos: number, needed: boolean, cond: boolean, sub: Sub): void {
    const src = this.src,
      out = this.#out;
    const kind = src.kind(pos);
    if (kind !== NifKind.Tag) {
      if (kind === NifKind.Ident) {
        this.#name(pos, sub);
        return;
      }
      if (sub !== Sub.None) this.#cannotModify();
      this.#copy(pos);
      return;
    }
    const tag = src.tag(pos);
    if (CONSTANT_TAGS.has(tag)) {
      if (sub !== Sub.None) this.#cannotModify();
      if (tag === T.fn) this.#function(pos, 'exprfunction');
      else this.#copy(pos);
      return;
    }
    if (BINARY.has(tag)) {
      if (sub !== Sub.None) this.#cannotModify();
      this.#children(pos, tag, true, false, Sub.None);
      return;
    }
    if (VALUE_UNARY.has(tag)) {
      if (sub !== Sub.None) this.#cannotModify();
      this.#children(pos, tag, true, false, Sub.None);
      if (tag === T.eval && this.options.evalOperatorIsOnGlobal && this.#ctx.kind !== 'toplevel')
        this.#error('TJSWarnEvalOperator', 'warning');
      return;
    }
    if (OP_ASSIGN.has(tag)) {
      if (sub !== Sub.None) this.#cannotModify();
      const [target, value] = src.children(pos);
      const node = this.#open(tag, pos);
      // The value is compiled before the target.
      const valueTree = this.#capture(() => this.#expr(value!, true, false, Sub.None));
      this.#expr(target!, false, false, Sub.Op);
      this.#paste(valueTree);
      out.close(node);
      return;
    }
    const modify = MODIFY_UNARY.get(tag);
    if (modify !== undefined) {
      if (sub !== Sub.None) this.#cannotModify();
      const operand = pos + 1;
      if (modify === Sub.Delete && src.kind(operand) === NifKind.Ident && !this.#globalMode) {
        const name = src.text(operand);
        const symbol = this.#find(name);
        if (symbol !== undefined) {
          // Deleting a local removes it from the namespace; the value of `delete x` is true.
          this.#remove(name);
          const node = this.#open(T.dellocal, pos);
          out.addSymbol(symbol, src.info(operand));
          out.close(node);
          return;
        }
      }
      this.#children(pos, tag, false, false, modify);
      return;
    }
    switch (tag) {
      case T.this:
      case T.global:
      case T.void:
        if (sub !== Sub.None) this.#cannotModify();
        this.#copy(pos);
        return;
      case T.regexp:
      case T.arr:
      case T.dict:
        this.#children(pos, tag, true, false, Sub.None);
        return;
      case T.kv:
        this.#children(pos, tag, true, false, Sub.None);
        return;
      case T.super:
        this.#super(pos, needed, cond, sub);
        return;
      case T.wdot: {
        const node = this.#open(T.wdot, pos);
        const nest = this.#ctx.nest;
        let withSymbol: string | undefined;
        for (let i = nest.length - 1; i >= 0 && !withSymbol; i--) withSymbol = nest[i]!.withSymbol;
        if (withSymbol) out.addSymbol(withSymbol, src.info(pos));
        else out.addDot();
        this.#copy(pos + 1);
        out.close(node);
        return;
      }
      case T.dot: {
        const [object, name] = src.children(pos);
        const node = this.#open(T.dot, pos);
        this.#expr(object!, true, false, Sub.None);
        this.#copy(name!);
        out.close(node);
        return;
      }
      case T.at:
        this.#children(pos, tag, true, false, Sub.None);
        return;
      case T.call:
      case T.new: {
        const [callee, ...args] = src.children(pos);
        const node = this.#open(tag, pos);
        const calleeTag = src.tag(callee!);
        const direct =
          tag === T.call &&
          (calleeTag === T.dot ||
            calleeTag === T.at ||
            (src.kind(callee!) === NifKind.Ident &&
              (this.#globalMode || this.#find(src.text(callee!)) === undefined)));
        // Arguments are compiled before the callee.
        const argTrees = this.#capture(() => {
          for (const a of args) this.#argument(a);
        });
        this.#expr(callee!, true, false, direct ? Sub.FuncCall : Sub.None);
        this.#paste(argTrees);
        out.close(node);
        return;
      }
      case T.instanceof:
        this.#children(pos, tag, true, false, Sub.None);
        return;
      case T.incontextof: {
        const [fn, context] = src.children(pos);
        // Without a use for its value the generator compiles neither operand.
        if (!needed) this.#mute++;
        const node = this.#open(tag, pos);
        this.#expr(fn!, true, false, sub);
        this.#expr(context!, true, false, Sub.None);
        out.close(node);
        if (!needed) this.#mute--;
        return;
      }
      case T.comma: {
        const [left, right] = src.children(pos);
        const node = this.#open(tag, pos);
        this.#expr(left!, false, false, Sub.None);
        this.#expr(right!, needed, cond, sub);
        out.close(node);
        return;
      }
      case T.and:
      case T.or:
        if (sub !== Sub.None) this.#cannotModify();
        this.#children(pos, tag, true, true, Sub.None);
        return;
      case T.not: {
        if (sub !== Sub.None) this.#cannotModify();
        const node = this.#open(tag, pos);
        this.#expr(pos + 1, needed, cond, Sub.None);
        out.close(node);
        return;
      }
      case T.asgn: {
        if (sub !== Sub.None) this.#cannotModify();
        // Reported at the node's own position: the lexer offset when the parser made it.
        if (cond)
          this.#error(
            'TJSSubstitutionInBooleanContext',
            'warning',
            this.options.points.assignments.get(pointKey(src, pos)) ?? this.#at,
          );
        const [target, value] = src.children(pos);
        const node = this.#open(tag, pos);
        // The value is compiled before the assignment target.
        const valueTree = this.#capture(() => this.#expr(value!, true, false, Sub.None));
        this.#expr(target!, false, false, Sub.Equal);
        this.#paste(valueTree);
        out.close(node);
        return;
      }
      case T.swap: {
        if (needed) this.#error('TJSCannotGetResult');
        if (sub !== Sub.None) this.#cannotModify();
        const [left, right] = src.children(pos);
        const node = this.#open(tag, pos);
        this.#expr(left!, true, false, Sub.Equal);
        this.#expr(right!, true, false, Sub.Equal);
        out.close(node);
        return;
      }
      case T.cond: {
        const [test, yes, no] = src.children(pos);
        const node = this.#open(tag, pos);
        this.#expr(test!, true, true, Sub.None);
        this.#expr(yes!, needed, cond, sub);
        this.#expr(no!, needed, cond, sub);
        out.close(node);
        return;
      }
      case T.postif: {
        if (needed) this.#error('TJSCannotGetResult');
        const [body, test] = src.children(pos);
        const node = this.#open(tag, pos);
        // The condition is compiled first.
        const testTree = this.#capture(() => this.#expr(test!, true, true, Sub.None));
        this.#expr(body!, false, false, sub);
        this.#paste(testTree);
        out.close(node);
        return;
      }
      case T.typeof: {
        if (sub !== Sub.None) this.#cannotModify();
        const operand = pos + 1;
        const t = src.tag(operand);
        const node = this.#open(tag, pos);
        this.#expr(
          operand,
          true,
          false,
          t === T.dot || t === T.at || t === T.wdot ? Sub.TypeOf : Sub.None,
        );
        out.close(node);
        return;
      }
      case T.ignoreprop:
      case T.propaccess:
        if ((tag === T.ignoreprop) !== !!this.options.unaryAsteriskIgnoresPropAccess)
          this.#ignoreProp(pos, needed, cond, sub);
        else this.#propAccess(pos, sub);
        return;
    }
    throw new Error(`Unexpected TJS2 node ${src.tagName(pos)}`);
  }

  /** Substance access (unary `&`, or `*` with `-unaryaster=compat`): skips property handlers. */
  #ignoreProp(pos: number, needed: boolean, cond: boolean, sub: Sub): void {
    const inner =
      sub === Sub.None ? Sub.IgnorePropGet : sub === Sub.Equal ? Sub.IgnorePropSet : null;
    if (inner === null) this.#cannotModify();
    const node = this.#open(this.src.tag(pos), pos);
    this.#expr(pos + 1, needed, cond, inner ?? sub);
    this.#out.close(node);
  }

  /** Property-object access (unary `*`, or `&` with `-unaryaster=compat`). */
  #propAccess(pos: number, sub: Sub): void {
    if (sub !== Sub.None && sub !== Sub.Equal && sub !== Sub.Op && sub !== Sub.Inc)
      this.#cannotModify();
    const node = this.#open(this.src.tag(pos), pos);
    this.#expr(pos + 1, true, false, Sub.None);
    this.#out.close(node);
  }

  /** Analyses every child of `pos` the same way under a copy of its tag. */
  #children(pos: number, tag: number, needed: boolean, cond: boolean, sub: Sub): void {
    const src = this.src;
    const node = this.#open(tag, pos);
    for (let c = pos + 1, end = src.end(pos); c < end; c = src.next(c)) {
      if (src.isDot(c)) this.#out.addDot(src.info(c));
      else if (src.kind(c) === NifKind.Str && (tag === T.regexp || tag === T.kv)) this.#copy(c);
      else this.#expr(c, needed, cond, sub);
    }
    this.#out.close(node);
  }

  #argument(pos: number): void {
    const src = this.src;
    if (src.isNode(pos, T.omit)) {
      // `AddOmitArg`: only a function passes its arguments on.
      if (this.#ctx.kind !== 'function' && this.#ctx.kind !== 'exprfunction')
        this.#error('TJSCannotOmit');
      this.#copy(pos);
    } else if (src.isDot(pos)) {
      this.#copy(pos);
    } else if (src.isNode(pos, T.expand)) {
      const node = this.#open(T.expand, pos);
      if (src.end(pos) > pos + 1) this.#expr(pos + 1, true, false, Sub.None);
      this.#out.close(node);
    } else {
      this.#expr(pos, true, false, Sub.None);
    }
  }

  /** A name: a local symbol, or `(proxy "x")` / `(gproxy "x")` resolved at run time. */
  #name(pos: number, sub: Sub): void {
    const src = this.src,
      out = this.#out;
    const name = src.text(pos);
    const symbol = this.#globalMode ? undefined : this.#find(name);
    if (symbol === undefined) {
      const node = this.#open(this.#globalMode ? T.gproxy : T.proxy, pos);
      out.addString(name, src.info(pos));
      out.close(node);
      return;
    }
    if (
      sub === Sub.IgnorePropGet ||
      sub === Sub.IgnorePropSet ||
      sub === Sub.TypeOf ||
      sub === Sub.FuncCall
    )
      this.#cannotModify();
    out.addSymbol(symbol, src.info(pos));
  }

  /**
   * `super`: the base-class expression of the enclosing class (through the property for a
   * getter or setter), compiled again here with every name resolved on `global`.
   */
  #super(pos: number, needed: boolean, cond: boolean, sub: Sub): void {
    const parent = this.#ctx.parent;
    const owner = parent?.kind === 'property' ? parent.parent : parent;
    const base = owner?.kind === 'class' ? owner.superExpr : -1;
    const node = this.#open(T.super, pos);
    if (base < 0) {
      this.#error('TJSCannotGetSuper');
    } else {
      const saved = this.#globalMode;
      this.#globalMode = true;
      try {
        this.#expr(base, needed, cond, sub);
      } finally {
        this.#globalMode = saved;
      }
    }
    this.#out.close(node);
  }
}
