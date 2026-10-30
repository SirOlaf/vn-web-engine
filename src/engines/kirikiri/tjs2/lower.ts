import {NifBuffer, NifKind} from '../../../compiler/nif/buffer.js';
import type {DataItem} from './code-block.js';
import {T} from './dialect.js';
import {L, OP_TAG, TJS2VM_TAGS} from './lowered.js';
import {ArgType, Op, OP_OPERANDS} from './opcodes.js';
import * as V from './runtime/variant.js';

/**
 * Lowering of an analysed TJS2 script block (`sema.ts`) to the `tjs2vm` stage: one flat list
 * of VM instructions per context, registers and data as the native code generator assigns
 * them (krkrz `tjsInterCodeGen.cpp`, `GenNodeCode` and the statement generators called from
 * `tjs.y`). Evaluation order, register reuse and the order in which conversion errors and
 * property handlers happen are those of the native code:
 *
 * - Temporaries are numbered from the frame base (1; each enclosing `switch` and `with` holds
 *   one more) and released per statement. Locals are numbered by the native local namespace
 *   (`tTJSLocalNamespace`), arguments first; register -n-3 holds local n.
 * - Register 0 is void, -1 is `this`, -2 the this-proxy (`this`, then `global`).
 * - Constant subexpressions are folded as the native parser folds them (`MakeNP1`/`MakeNP2`).
 *
 * Jumps target symbolic labels; the code generator (`codegen.ts`) resolves them and builds the
 * data areas. Lowering is a compiler stage only: nothing executes this tree.
 */
export function lowerScriptBlock(
  analysed: NifBuffer,
  root: number,
  options: LowerOptions = {},
): {tree: NifBuffer; root: number} {
  return new Lowering(analysed, options).script(root);
}

export interface LowerOptions {
  /** `-unaryaster=compat`: unary `*` ignores property handlers and unary `&` reads them. */
  readonly unaryAsteriskIgnoresPropAccess?: boolean;
}

// --- Native code generator constants -------------------------------------------------------

const RT_NEEDED = 1;
const RT_CFLAG = 2;
/** `TJS_GNC_CFLAG`: the result is the condition flag. */
const CFLAG = -0x80000000;
/** `TJS_GNC_CFLAG_I`: the result is the inverted condition flag. */
const CFLAG_I = CFLAG + 1;

/** `tTJSSubType`; the operation types are their VM opcodes. */
const St = {
  None: Op.NOP,
  Equal: Op.CP,
  PreInc: 128,
  PreDec: 129,
  PostInc: 130,
  PostDec: 131,
  Delete: 132,
  FuncCall: 133,
  IgnorePropGet: 134,
  IgnorePropSet: 135,
  TypeOf: 136,
} as const;

interface SubParam {
  readonly type: number;
  readonly address: number;
}
const NO_PARAM: SubParam = {type: St.None, address: 0};

const OP_ASSIGN = new Map<number, number>([
  [T.bitandasgn, Op.BAND],
  [T.bitorasgn, Op.BOR],
  [T.bitxorasgn, Op.BXOR],
  [T.subasgn, Op.SUB],
  [T.addasgn, Op.ADD],
  [T.modasgn, Op.MOD],
  [T.divasgn, Op.DIV],
  [T.idivasgn, Op.IDIV],
  [T.mulasgn, Op.MUL],
  [T.orasgn, Op.LOR],
  [T.andasgn, Op.LAND],
  [T.sarasgn, Op.SAR],
  [T.shlasgn, Op.SAL],
  [T.shrasgn, Op.SR],
]);

const ARITHMETIC = new Map<number, number>([
  [T.bitor, Op.BOR],
  [T.bitxor, Op.BXOR],
  [T.bitand, Op.BAND],
  [T.sar, Op.SAR],
  [T.shl, Op.SAL],
  [T.shr, Op.SR],
  [T.add, Op.ADD],
  [T.sub, Op.SUB],
  [T.mod, Op.MOD],
  [T.div, Op.DIV],
  [T.idiv, Op.IDIV],
  [T.mul, Op.MUL],
]);

/** Comparisons: the compare opcode and whether the flag is inverted (`SETNF`). */
const COMPARISON = new Map<number, readonly [number, boolean]>([
  [T.neq, [Op.CEQ, true]],
  [T.eq, [Op.CEQ, false]],
  [T.dneq, [Op.CDEQ, true]],
  [T.deq, [Op.CDEQ, false]],
  [T.lt, [Op.CLT, false]],
  [T.gt, [Op.CGT, false]],
  [T.le, [Op.CGT, true]],
  [T.ge, [Op.CLT, true]],
]);

const UNARY = new Map<number, number>([
  [T.bitnot, Op.BNOT],
  [T.asc, Op.ASC],
  [T.chr, Op.CHR],
  [T.pos, Op.NUM],
  [T.neg, Op.CHS],
  [T.invalidate, Op.INV],
  [T.isvalid, Op.CHKINV],
  [T.toint, Op.INT],
  [T.toreal, Op.REAL],
  [T.tostr, Op.STR],
]);

const MODIFY = new Map<number, number>([
  [T.delete, St.Delete],
  [T.preinc, St.PreInc],
  [T.predec, St.PreDec],
  [T.postinc, St.PostInc],
  [T.postdec, St.PostDec],
]);

// --- Constant folding (MakeNP1 / MakeNP2) ----------------------------------------------------

/** `CharacterCodeOf`: the first code unit, 0 for the empty string. */
function characterCodeOf(v: V.Variant): V.Variant {
  const s = V.asString(v);
  return V.int(s.length ? s.charCodeAt(0) : 0);
}

/** `CharacterCodeFrom`: one UTF-16 code unit (the string ends at a NUL). */
function characterCodeFrom(v: V.Variant): V.Variant {
  const c = Number(BigInt.asUintN(16, V.asInteger(v)));
  return V.str(c === 0 ? '' : String.fromCharCode(c));
}

const FOLD_UNARY = new Map<number, (v: V.Variant) => V.Variant>([
  [T.not, V.logicalNot],
  [T.bitnot, V.bitNot],
  [T.asc, characterCodeOf],
  [T.chr, characterCodeFrom],
  [T.pos, V.toNumber],
  [T.neg, V.negate],
  [T.toint, (v) => V.integer(V.asInteger(v))],
  [T.toreal, (v) => V.real(V.asReal(v))],
  [T.tostr, (v) => V.str(V.asString(v))],
]);

const FOLD_BINARY = new Map<number, (a: V.Variant, b: V.Variant) => V.Variant>([
  [T.comma, (_a, b) => b],
  [T.or, V.logicalOr],
  [T.and, V.logicalAnd],
  [T.bitor, V.bitOr],
  [T.bitxor, V.bitXor],
  [T.bitand, V.bitAnd],
  [T.neq, (a, b) => V.bool(!V.normalCompare(a, b))],
  [T.eq, (a, b) => V.bool(V.normalCompare(a, b))],
  [T.dneq, (a, b) => V.bool(!V.discernCompare(a, b))],
  [T.deq, (a, b) => V.bool(V.discernCompare(a, b))],
  [T.lt, (a, b) => V.bool(V.greaterThan(a, b))],
  [T.gt, (a, b) => V.bool(V.littlerThan(a, b))],
  [T.le, (a, b) => V.bool(!V.littlerThan(a, b))],
  [T.ge, (a, b) => V.bool(!V.greaterThan(a, b))],
  [T.sar, V.shiftRight],
  [T.shl, V.shiftLeft],
  [T.shr, V.shiftRightUnsigned],
  [T.add, V.add],
  [T.sub, V.sub],
  [T.mod, V.mod],
  [T.div, V.div],
  [T.idiv, V.idiv],
  [T.mul, V.mul],
]);

function variantToData(v: V.Variant): LConst {
  switch (v.type) {
    case 0:
      return {kind: 'void'};
    case 1:
      if (v.object === null && v.objthis === null) return {kind: 'null'};
      throw new Error('object constants cannot be folded');
    case 2:
      return {kind: 'string', value: v.value};
    case 3:
      return {kind: 'octet', value: v.value};
    case 4:
      return {kind: 'integer', value: v.value};
    case 5:
      return {kind: 'real', value: v.value};
  }
}

function dataToVariant(d: LConst): V.Variant | null {
  switch (d.kind) {
    case 'void':
      return V.VOID;
    case 'null':
      return V.NULL_OBJECT;
    case 'string':
      return V.str(d.value);
    case 'octet':
      return V.octet(d.value);
    case 'integer':
      return V.integer(d.value);
    case 'real':
      return V.real(d.value);
    default:
      return null;
  }
}

/** A data item of the lowered stage: contexts are referenced by symbol. */
type LConst =
  | Exclude<DataItem, {kind: 'context'} | {kind: 'array'} | {kind: 'dictionary'}>
  | {readonly kind: 'context'; readonly symbol: string}
  | {readonly kind: 'array'; readonly items: readonly LConst[]}
  | {readonly kind: 'dictionary'; readonly items: readonly (readonly [string, LConst])[]};

// --- Compile-time state ------------------------------------------------------------------------

type ContextKind =
  | 'toplevel'
  | 'function'
  | 'exprfunction'
  | 'property'
  | 'setter'
  | 'getter'
  | 'class'
  | 'supergetter';

const enum Nt {
  Block,
  While,
  DoWhile,
  For,
  Switch,
  If,
  Else,
  Try,
  Catch,
  With,
}

interface Nest {
  type: Nt;
  refRegister: number;
  loopStart: string | null;
  exit: string | null;
  continue: string | null;
  patch1: string | null;
  patch2: string | null;
  isFirstCase: boolean;
  variableCreated: boolean;
}

function nest(type: Nt): Nest {
  return {
    type,
    refRegister: 0,
    loopStart: null,
    exit: null,
    continue: null,
    patch1: null,
    patch2: null,
    isFirstCase: true,
    variableCreated: false,
  };
}

/** `tTJSLocalNamespace`: levels of names; a removed name leaves a reusable hole. */
class LocalNamespace {
  readonly #levels: {start: number; list: (string | null)[]}[] = [];
  #maxCount = 0;

  get level(): number {
    return this.#levels.length;
  }
  get maxCount(): number {
    return this.#maxCount;
  }
  count(): number {
    let n = 0;
    for (const l of this.#levels) n += l.list.length;
    return n;
  }
  push(): void {
    this.#levels.push({start: this.count(), list: []});
  }
  pop(): void {
    const c = this.count();
    if (this.#maxCount < c) this.#maxCount = c;
    this.#levels.pop();
  }
  find(name: string): number {
    for (let i = this.#levels.length - 1; i >= 0; i--) {
      const l = this.#levels[i]!;
      const idx = l.list.indexOf(name);
      if (idx >= 0) return idx + l.start;
    }
    return -1;
  }
  add(name: string): void {
    const top = this.#levels.at(-1);
    if (!top || top.list.includes(name)) return;
    const hole = top.list.indexOf(null);
    if (hole >= 0) top.list[hole] = name;
    else top.list.push(name);
  }
  remove(name: string): void {
    for (let i = this.#levels.length - 1; i >= 0; i--) {
      const l = this.#levels[i]!;
      const idx = l.list.indexOf(name);
      if (idx >= 0) {
        l.list[idx] = null;
        return;
      }
    }
  }
}

interface FuncArg {
  isOmit: boolean;
  hasExpand: boolean;
  readonly items: {register: number; type: number}[];
}

class Context {
  readonly code: NifBuffer;
  frameBase = 1;
  maxFrame = 0;
  readonly ns = new LocalNamespace();
  readonly nest: Nest[] = [];
  readonly reserve: number;
  argCount = 0;
  unnamedBase = 0;
  collapseBase = -1;
  getter: Context | null = null;
  setter: Context | null = null;
  superGetter: Context | null = null;
  readonly members: {name: string; context: Context}[] = [];
  readonly supers: string[] = [];
  /** Instruction index where function registrations and `REGMEMBER` are inserted. */
  registerPoint = 0;
  /** Top-level declarations to register on `this` (`NonLocalFunctionDeclVector`). */
  readonly hoisted: {context: Context; name: string; changeThis: boolean}[] = [];
  readonly withRegisters = new Map<string, number>();
  /** Analysed position of the only base-class expression (`SuperClassExpr`), or -1. */
  superExpr = -1;
  readonly funcArgs: FuncArg[] = [];
  readonly arrayArgs: {object: number; counter: number}[] = [];
  instructions = 0;

  constructor(
    readonly index: number,
    readonly name: string | null,
    readonly kind: ContextKind,
    readonly parent: Context | null,
    readonly info: number,
    pool: NifBuffer['pool'],
  ) {
    this.code = new NifBuffer(pool, TJS2VM_TAGS);
    this.reserve = kind === 'property' ? 0 : 2;
  }

  get symbol(): string {
    return `c.${this.index}`;
  }

  /** `ClearFrame`: records the frame's high-water mark and returns `base`. */
  clearFrame(frame: number, base = this.frameBase): number {
    if (frame - 1 > this.maxFrame) this.maxFrame = frame - 1;
    return base;
  }
}

interface Frame {
  f: number;
}

/** An operand of an instruction being emitted. */
type Operand = number | {readonly data: LConst} | {readonly label: string} | FuncArg;

// --- The lowering ------------------------------------------------------------------------------

class Lowering {
  readonly #contexts: Context[] = [];
  #ctx!: Context;
  #labels = 0;

  constructor(
    readonly src: NifBuffer,
    readonly options: LowerOptions,
  ) {}

  script(root: number): {tree: NifBuffer; root: number} {
    const src = this.src;
    const top = this.#push('global', 'toplevel', src.info(root));
    for (let c = root + 1, end = src.end(root); c < end; c = src.next(c)) {
      if (src.isNode(c, T.hoist)) continue;
      this.#statement(c);
    }
    this.#commit(top);
    return this.#module(src.info(root));
  }

  // ── output ───────────────────────────────────────────────────────────────

  #module(info: number): {tree: NifBuffer; root: number} {
    const out = new NifBuffer(this.src.pool, TJS2VM_TAGS);
    const module = out.open(L.module, info);
    for (const ctx of this.#contexts) {
      const node = out.open(L.context, ctx.info);
      out.addSymbolDef(ctx.symbol);
      if (ctx.name === null) out.addDot();
      else out.addString(ctx.name);
      out.addIdent(ctx.kind);
      if (ctx.parent) out.addSymbol(ctx.parent.symbol);
      else out.addDot();
      const layout = out.open(L.layout);
      const maxVariables = ctx.kind === 'supergetter' ? 2 : ctx.ns.maxCount;
      for (const n of [
        maxVariables,
        ctx.reserve,
        ctx.maxFrame,
        ctx.argCount,
        ctx.unnamedBase,
        ctx.collapseBase,
      ])
        out.addInt(n);
      out.close(layout);
      const handlers = out.open(L.handlers);
      for (const h of [ctx.getter, ctx.setter, ctx.superGetter])
        if (h) out.addSymbol(h.symbol);
        else out.addDot();
      out.close(handlers);
      const members = out.open(L.members);
      for (const m of ctx.members) {
        const node = out.open(L.m);
        out.addString(m.name);
        out.addSymbol(m.context.symbol);
        out.close(node);
      }
      out.close(members);
      const supers = out.open(L.supers);
      for (const s of ctx.supers) out.addSymbol(s);
      out.close(supers);
      const code = out.open(L.code);
      for (let c = 0; c < ctx.code.length; c = ctx.code.next(c)) out.copyTree(ctx.code, c);
      out.close(code);
      out.close(node);
    }
    out.close(module);
    return {tree: out, root: module};
  }

  #label(): string {
    return `L.${this.#labels++}`;
  }

  /** The label after a loop or switch, which `break` jumps to. */
  #exitLabel(n: Nest): string {
    return (n.exit ??= this.#label());
  }

  #place(label: string): void {
    const code = this.#ctx.code;
    const node = code.open(L.label);
    code.addSymbolDef(label);
    code.close(node);
  }

  /** `PutCode` of one instruction with its operands, laid out as `OP_OPERANDS` says. */
  #emit(op: number, info: number, ...operands: Operand[]): void {
    const ctx = this.#ctx,
      code = ctx.code;
    const kinds = OP_OPERANDS[op]!;
    if (kinds.length !== operands.length)
      throw new Error(`TJS2 lowering: ${op} takes ${kinds.length} operands`);
    const node = code.open(OP_TAG[op]!, info);
    kinds.forEach((kind, i) => {
      const o = operands[i]!;
      switch (kind) {
        case 'r':
        case 'n':
          code.addInt(o as number);
          break;
        case 'd':
          this.#writeData(code, (o as {data: LConst}).data);
          break;
        case 'j':
          code.addSymbol((o as {label: string}).label);
          break;
        case 'a':
          this.#writeArgs(code, o as FuncArg);
          break;
      }
    });
    code.close(node);
    ctx.instructions++;
  }

  #writeData(code: NifBuffer, d: LConst): void {
    switch (d.kind) {
      case 'void':
        code.close(code.open(L.void));
        return;
      case 'null':
        code.close(code.open(L.null));
        return;
      case 'integer':
        code.addInt(d.value);
        return;
      case 'real':
        if (Number.isNaN(d.value)) code.close(code.open(L.nan));
        else if (d.value === Infinity) code.close(code.open(L.inf));
        else if (d.value === -Infinity) code.close(code.open(L.neginf));
        else code.addFloat(d.value);
        return;
      case 'string':
        code.addString(d.value);
        return;
      case 'octet': {
        const node = code.open(L.octet);
        code.addString(Array.from(d.value, (b) => b.toString(16).padStart(2, '0')).join(''));
        code.close(node);
        return;
      }
      case 'context': {
        const node = code.open(L.ctx);
        code.addSymbol(d.symbol);
        code.close(node);
        return;
      }
      case 'array': {
        const node = code.open(L.array);
        for (const item of d.items) this.#writeData(code, item);
        code.close(node);
        return;
      }
      case 'dictionary': {
        const node = code.open(L.dict);
        for (const [k, v] of d.items) {
          const kv = code.open(L.kv);
          code.addString(k);
          this.#writeData(code, v);
          code.close(kv);
        }
        code.close(node);
        return;
      }
    }
  }

  #writeArgs(code: NifBuffer, a: FuncArg): void {
    if (a.isOmit) {
      code.close(code.open(L.omit));
      return;
    }
    if (a.hasExpand) {
      const node = code.open(L.xargs);
      for (const item of a.items) {
        const tag = item.type === ArgType.Normal ? L.n : item.type === ArgType.Expand ? L.x : L.u;
        const n = code.open(tag);
        if (item.type !== ArgType.UnnamedExpand) code.addInt(item.register);
        code.close(n);
      }
      code.close(node);
      return;
    }
    const node = code.open(L.args);
    for (const item of a.items) code.addInt(item.register);
    code.close(node);
  }

  // ── contexts ─────────────────────────────────────────────────────────────

  /** `PushContextStack`: a new context, current until `#commit`. */
  #push(name: string | null, kind: ContextKind, info: number): Context {
    const ctx = new Context(
      this.#contexts.length,
      name,
      kind,
      this.#contexts.length ? this.#ctx : null,
      info,
      this.src.pool,
    );
    this.#contexts.push(ctx);
    this.#ctx = ctx;
    if (kind === 'class') {
      // const %1, name; addci %-1, %1; cl %1
      if (ctx.maxFrame < 1) ctx.maxFrame = 1;
      this.#emit(Op.CONST, info, 1, {data: {kind: 'string', value: name ?? ''}});
      this.#emit(Op.ADDCI, info, -1, 1);
      this.#emit(Op.CL, info, 1);
      ctx.registerPoint = ctx.instructions;
    }
    return ctx;
  }

  /** `PopContextStack` → `Commit`: ends the code, registers the context, inserts registrations. */
  #commit(ctx: Context): void {
    this.#ctx = ctx;
    if (ctx.kind !== 'property' && ctx.kind !== 'supergetter') {
      this.#emit(Op.SRV, ctx.info, 0);
      this.#emit(Op.RET, ctx.info);
    }
    this.#register(ctx);
    if (ctx.kind !== 'property' && ctx.kind !== 'supergetter') this.#fixCode(ctx);
    if (ctx.parent) this.#ctx = ctx.parent;
  }

  /** `RegisterFunction`. */
  #register(ctx: Context): void {
    const parent = ctx.parent;
    if (!parent) return;
    if (ctx.kind === 'setter') {
      parent.setter = ctx;
      return;
    }
    if (ctx.kind === 'getter') {
      parent.getter = ctx;
      return;
    }
    if (ctx.kind !== 'function' && ctx.kind !== 'property' && ctx.kind !== 'class') return;
    if (parent.kind === 'toplevel')
      parent.hoisted.push({context: ctx, name: ctx.name!, changeThis: ctx.kind !== 'class'});
    // A function in a function is also a local; the analysed `(local …)` after it initialises it.
    if (parent.kind === 'function' || parent.kind === 'class')
      parent.members.push({name: ctx.name!, context: ctx});
  }

  /** The insertions of `FixCode`: `regmember` for a class, registrations of hoisted declarations. */
  #fixCode(ctx: Context): void {
    const inserted = new NifBuffer(this.src.pool, TJS2VM_TAGS);
    const saved = ctx.code;
    // Emit into a scratch buffer of the same context.
    (ctx as {code: NifBuffer}).code = inserted;
    if (ctx.kind === 'class') this.#emit(Op.REGMEMBER, ctx.info);
    if (ctx.hoisted.length) {
      if (ctx.maxFrame < 1) ctx.maxFrame = 1;
      for (const h of ctx.hoisted) {
        this.#emit(Op.CONST, ctx.info, 1, {data: {kind: 'context', symbol: h.context.symbol}});
        if (h.changeThis) this.#emit(Op.CHGTHIS, ctx.info, 1, -1);
        this.#emit(Op.SPDS, ctx.info, -1, {data: {kind: 'string', value: h.name}}, 1);
      }
      this.#emit(Op.CL, ctx.info, 1);
    }
    (ctx as {code: NifBuffer}).code = saved;
    if (inserted.length === 0) return;
    const merged = new NifBuffer(this.src.pool, TJS2VM_TAGS, saved.length + inserted.length);
    let i = 0,
      c = 0;
    // Instructions before the register point; labels there stay behind the insertion.
    for (; c < saved.length && i < ctx.registerPoint; c = saved.next(c)) {
      merged.copyTree(saved, c);
      if (!saved.isNode(c, L.label)) i++;
    }
    for (let k = 0; k < inserted.length; k = inserted.next(k)) merged.copyTree(inserted, k);
    for (; c < saved.length; c = saved.next(c)) merged.copyTree(saved, c);
    (ctx as {code: NifBuffer}).code = merged;
  }

  // ── namespaces and nesting ───────────────────────────────────────────────

  #enterBlock(): void {
    const ctx = this.#ctx;
    ctx.ns.push();
    ctx.nest.push(nest(Nt.Block));
  }

  #exitBlock(): void {
    const ctx = this.#ctx;
    ctx.nest.pop();
    ctx.ns.pop();
  }

  #localRegister(name: string): number {
    const n = this.#ctx.ns.find(name);
    if (n < 0) throw new Error(`TJS2 lowering: local ${name} is not in the namespace`);
    return -n - this.#ctx.reserve - 1;
  }

  /** `AddLocalVariable`: a local at namespace depth ≥ 1 (≥ 2 in a class), else a member. */
  #addLocalVariable(name: string, init: number, info: number): void {
    const ctx = this.#ctx;
    const base = ctx.kind === 'class' ? 2 : 1;
    if (ctx.ns.level >= base) {
      ctx.ns.add(name);
      const reg = this.#localRegister(name);
      if (init !== 0) this.#emit(Op.CP, info, reg, init);
      else this.#emit(Op.CL, info, reg);
    } else {
      this.#emit(Op.SPDS, info, -1, {data: {kind: 'string', value: name}}, init);
    }
  }

  /** `InitLocalVariable`. */
  #initLocalVariable(name: string, init: number, info: number): void {
    const ctx = this.#ctx;
    const F = {f: ctx.frameBase};
    const res = this.#gen(F, init, RT_NEEDED, NO_PARAM);
    this.#addLocalVariable(name, res, info);
    ctx.clearFrame(F.f);
  }

  // ── statements ───────────────────────────────────────────────────────────

  #statement(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    if (src.isDot(pos)) return;
    const info = src.info(pos);
    switch (src.tag(pos)) {
      case T.block:
      case T.stmts: {
        const block = src.tag(pos) === T.block;
        if (block) this.#enterBlock();
        for (let c = pos + 1, end = src.end(pos); c < end; c = src.next(c)) this.#statement(c);
        if (block) this.#exitBlock();
        return;
      }
      case T.local: {
        const [sym, init] = src.children(pos);
        const name = symbolName(src.text(sym!));
        if (src.isDot(init!)) this.#addLocalVariable(name, 0, info);
        else this.#initLocalVariable(name, init!, info);
        return;
      }
      case T.member: {
        const [nameAt, init] = src.children(pos);
        const name = src.text(nameAt!);
        if (src.isDot(init!)) this.#addLocalVariable(name, 0, info);
        else this.#initLocalVariable(name, init!, info);
        return;
      }
      case T.if:
        this.#if(pos);
        return;
      case T.while:
        this.#while(pos);
        return;
      case T.dowhile:
        this.#doWhile(pos);
        return;
      case T.for:
        this.#for(pos);
        return;
      case T.brk:
        this.#break(info);
        return;
      case T.cont:
        this.#continue(info);
        return;
      case T.debugger:
        this.#emit(Op.DEBUGGER, info);
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
      case T.ret:
        this.#return(pos);
        return;
      case T.switch:
        this.#switch(pos);
        return;
      case T.with:
        this.#with(pos);
        return;
      case T.try:
        this.#try(pos);
        return;
      case T.throw: {
        const F = {f: ctx.frameBase};
        const res = this.#gen(F, pos + 1, RT_NEEDED, NO_PARAM);
        this.#emit(Op.THROW, info, res);
        if (F.f - 1 > ctx.maxFrame) ctx.maxFrame = F.f - 1;
        return;
      }
    }
    // `CreateExprCode`.
    const F = {f: ctx.frameBase};
    this.#gen(F, pos, 0, NO_PARAM);
    ctx.clearFrame(F.f);
  }

  /** A condition (`TJS_RT_NEEDED | TJS_RT_CFLAG`); returns whether the flag is inverted. */
  #condition(pos: number, info: number): boolean {
    const ctx = this.#ctx;
    const F = {f: ctx.frameBase};
    const res = this.#gen(F, pos, RT_NEEDED | RT_CFLAG, NO_PARAM);
    let inv = false;
    if (!isCFlag(res)) this.#emit(Op.TT, info, res);
    else if (res === CFLAG_I) inv = true;
    ctx.clearFrame(F.f);
    return inv;
  }

  #if(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    const [cond, then, otherwise] = src.children(pos);
    const info = src.info(pos);
    ctx.nest.push(nest(Nt.If));
    const inv = this.#condition(cond!, src.info(cond!));
    const elseLabel = this.#label();
    this.#emit(inv ? Op.JF : Op.JNF, src.info(cond!), {label: elseLabel});
    this.#statement(then!);
    ctx.nest.pop();
    if (src.isDot(otherwise!)) {
      this.#place(elseLabel);
      return;
    }
    ctx.nest.push(nest(Nt.Else));
    const endLabel = this.#label();
    this.#emit(Op.JMP, info, {label: endLabel});
    this.#place(elseLabel);
    this.#statement(otherwise!);
    this.#place(endLabel);
    ctx.nest.pop();
  }

  #while(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    const [cond, body] = src.children(pos);
    const n = nest(Nt.While);
    ctx.nest.push(n);
    n.loopStart = this.#label();
    this.#place(n.loopStart);
    const inv = this.#condition(cond!, src.info(cond!));
    this.#emit(inv ? Op.JF : Op.JNF, src.info(cond!), {label: this.#exitLabel(n)});
    this.#statement(body!);
    this.#emit(Op.JMP, src.info(pos), {label: n.loopStart});
    this.#place(this.#exitLabel(n));
    ctx.nest.pop();
  }

  #doWhile(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    const [body, cond] = src.children(pos);
    const n = nest(Nt.DoWhile);
    ctx.nest.push(n);
    n.loopStart = this.#label();
    this.#place(n.loopStart);
    this.#statement(body!);
    if (n.continue) this.#place(n.continue);
    const inv = this.#condition(cond!, src.info(cond!));
    this.#emit(inv ? Op.JNF : Op.JF, src.info(cond!), {label: n.loopStart});
    if (n.exit) this.#place(n.exit);
    ctx.nest.pop();
  }

  /** `(for init cond body step)`: `EnterForCode` … `ExitForCode`. */
  #for(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    const [init, cond, body, step] = src.children(pos);
    const loop = nest(Nt.For);
    ctx.nest.push(loop);
    this.#enterBlock();
    const block = ctx.nest.at(-1)!;
    if (!src.isDot(init!)) this.#statement(init!);
    block.loopStart = this.#label();
    this.#place(block.loopStart);
    if (!src.isDot(cond!)) {
      const inv = this.#condition(cond!, src.info(cond!));
      this.#emit(inv ? Op.JF : Op.JNF, src.info(cond!), {label: this.#exitLabel(block)});
    }
    this.#statement(body!);
    if (loop.continue) this.#place(loop.continue);
    if (!src.isDot(step!)) {
      const F = {f: ctx.frameBase};
      this.#gen(F, step!, 0, NO_PARAM);
      ctx.clearFrame(F.f);
    }
    this.#emit(Op.JMP, src.info(pos), {label: block.loopStart});
    if (block.exit) this.#place(block.exit);
    this.#exitBlock();
    if (loop.exit) this.#place(loop.exit);
    ctx.nest.pop();
  }

  /** `DoBreak`. */
  #break(info: number): void {
    const nests = this.#ctx.nest;
    for (let i = nests.length - 1; i >= 0; i--) {
      const n = nests[i]!;
      if (
        n.type === Nt.Switch ||
        n.type === Nt.While ||
        n.type === Nt.DoWhile ||
        n.type === Nt.For
      ) {
        this.#emit(Op.JMP, info, {label: this.#exitLabel(n)});
        return;
      }
      if (n.type === Nt.Try) this.#emit(Op.EXTRY, info);
    }
    throw new Error('TJS2 lowering: break outside a loop');
  }

  /** `DoContinue`. */
  #continue(info: number): void {
    const nests = this.#ctx.nest;
    for (let i = nests.length - 1; i >= 0; i--) {
      const n = nests[i]!;
      if (n.type === Nt.While) {
        this.#emit(Op.JMP, info, {label: n.loopStart!});
        return;
      }
      if (n.type === Nt.DoWhile || n.type === Nt.For) {
        this.#emit(Op.JMP, info, {label: (n.continue ??= this.#label())});
        return;
      }
      if (n.type === Nt.Try) this.#emit(Op.EXTRY, info);
    }
    throw new Error('TJS2 lowering: continue outside a loop');
  }

  /** `ReturnFromFunc`. */
  #return(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    const info = src.info(pos);
    if (src.isDot(pos + 1)) {
      this.#emit(Op.SRV, info, 0);
    } else {
      const F = {f: ctx.frameBase};
      const res = this.#gen(F, pos + 1, RT_NEEDED, NO_PARAM);
      this.#emit(Op.SRV, info, res);
      ctx.clearFrame(F.f);
    }
    ctx.clearFrame(ctx.frameBase, 1);
    for (let i = ctx.nest.length - 1; i >= 0; i--)
      if (ctx.nest[i]!.type === Nt.Try) this.#emit(Op.EXTRY, info);
    this.#emit(Op.RET, info);
  }

  /** `(switch e (block pre…) (case e (block …)) (default (block …)))`. */
  #switch(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    const [value, ...sections] = src.children(pos);
    const info = src.info(pos);
    const sw = nest(Nt.Switch);
    ctx.nest.push(sw);
    // EnterSwitchCode
    const F = {f: ctx.frameBase};
    const res = this.#gen(F, value!, RT_NEEDED, NO_PARAM);
    if (ctx.frameBase !== res) this.#emit(Op.CP, src.info(value!), ctx.frameBase, res);
    sw.refRegister = ctx.frameBase;
    if (F.f - 1 > ctx.maxFrame) ctx.maxFrame = F.f - 1;
    ctx.frameBase++;
    if (ctx.frameBase - 1 > ctx.maxFrame) ctx.maxFrame = ctx.frameBase - 1;
    ctx.clearFrame(F.f);
    this.#enterBlock();
    for (const section of sections) {
      const tag = src.tag(section);
      if (tag === T.block) {
        // The statements before the first label, in the block `{` opens.
        this.#enterBlock();
        for (let c = section + 1, end = src.end(section); c < end; c = src.next(c))
          this.#statement(c);
        continue;
      }
      // ProcessCaseCode
      const sinfo = src.info(section);
      let patch3: string | null = null;
      if (!sw.isFirstCase) {
        patch3 = this.#label();
        this.#emit(Op.JMP, sinfo, {label: patch3});
      }
      this.#exitBlock();
      if (sw.patch1) this.#place(sw.patch1);
      const body = src.children(section).at(-1)!;
      if (tag === T.case) {
        const G = {f: ctx.frameBase};
        const r = this.#gen(G, section + 1, RT_NEEDED, NO_PARAM);
        this.#emit(Op.CEQ, sinfo, sw.refRegister, r);
        ctx.clearFrame(G.f);
        sw.patch1 = this.#label();
        this.#emit(Op.JNF, sinfo, {label: sw.patch1});
      } else {
        sw.patch1 = this.#label();
        this.#emit(Op.JMP, sinfo, {label: sw.patch1});
        sw.patch2 = this.#label();
        this.#place(sw.patch2);
      }
      if (patch3) this.#place(patch3);
      sw.isFirstCase = false;
      this.#enterBlock();
      for (let c = body + 1, end = src.end(body); c < end; c = src.next(c)) this.#statement(c);
    }
    // `}` and ExitSwitchCode
    this.#exitBlock();
    this.#exitBlock();
    let patch3: string | null = null;
    if (!sw.isFirstCase) {
      patch3 = this.#label();
      this.#emit(Op.JMP, info, {label: patch3});
    }
    if (sw.patch1) this.#place(sw.patch1);
    if (sw.patch2) this.#emit(Op.JMP, info, {label: sw.patch2});
    if (patch3) this.#place(patch3);
    if (sw.exit) this.#place(sw.exit);
    ctx.frameBase--;
    ctx.nest.pop();
  }

  /** `(with :with.N e body)`. */
  #with(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    const [sym, value, body] = src.children(pos);
    const F = {f: ctx.frameBase};
    const res = this.#gen(F, value!, RT_NEEDED, NO_PARAM);
    if (ctx.frameBase !== res) this.#emit(Op.CP, src.info(value!), ctx.frameBase, res);
    const w = nest(Nt.With);
    w.refRegister = ctx.frameBase;
    ctx.nest.push(w);
    ctx.withRegisters.set(src.text(sym!), w.refRegister);
    if (F.f - 1 > ctx.maxFrame) ctx.maxFrame = F.f - 1;
    ctx.frameBase++;
    if (ctx.frameBase - 1 > ctx.maxFrame) ctx.maxFrame = ctx.frameBase - 1;
    ctx.clearFrame(F.f);
    this.#enterBlock();
    this.#statement(body!);
    this.#exitBlock();
    ctx.frameBase--;
    ctx.nest.pop();
  }

  /** `(try body (catch :e.N|.) handler)`. */
  #try(pos: number): void {
    const src = this.src,
      ctx = this.#ctx;
    const [body, handler, recovery] = src.children(pos);
    const info = src.info(pos);
    const t = nest(Nt.Try);
    ctx.nest.push(t);
    const catchLabel = this.#label();
    this.#emit(Op.ENTRY, info, {label: catchLabel}, ctx.frameBase);
    if (ctx.frameBase > ctx.maxFrame) ctx.maxFrame = ctx.frameBase;
    this.#statement(body!);
    // EnterCatchCode
    const hinfo = src.info(handler!);
    this.#emit(Op.EXTRY, hinfo);
    const endLabel = this.#label();
    this.#emit(Op.JMP, hinfo, {label: endLabel});
    this.#place(catchLabel);
    t.type = Nt.Catch;
    const name = handler! + 1;
    const named = !src.isDot(name);
    if (named) {
      t.variableCreated = true;
      this.#enterBlock();
      this.#addLocalVariable(symbolName(src.text(name)), ctx.frameBase, hinfo);
    }
    this.#statement(recovery!);
    if (named) this.#exitBlock();
    this.#place(endLabel);
    ctx.nest.pop();
  }

  // ── declarations ─────────────────────────────────────────────────────────

  /** `(func :f.N "f" reg (params …) (block …))` and `(fn :anon.N (params …) (block …))`. */
  #function(pos: number, kind: 'function' | 'exprfunction'): Context {
    const src = this.src;
    const children = src.children(pos);
    const named = kind === 'function';
    const [params, body] = named ? children.slice(3) : children.slice(1);
    const parent = this.#ctx;
    const ctx = this.#push(named ? src.text(children[1]!) : '(anonymous)', kind, src.info(pos));
    this.#contextSymbols.set(src.text(children[0]!), ctx);
    this.#enterBlock();
    for (let c = params! + 1, end = src.end(params!); c < end; c = src.next(c)) {
      const [nameAt, init] = src.children(c);
      if (src.isNode(c, T.rest)) {
        // AddFunctionDeclArgCollapse
        if (src.isDot(nameAt!)) ctx.unnamedBase = ctx.argCount;
        else {
          ctx.collapseBase = ctx.argCount;
          ctx.ns.add(symbolName(src.text(nameAt!)));
        }
        continue;
      }
      // AddFunctionDeclArg
      ctx.ns.add(symbolName(src.text(nameAt!)));
      if (!src.isDot(init!)) {
        const info = src.info(init!);
        const reg = -3 - ctx.argCount;
        this.#emit(Op.CDEQ, info, reg, 0);
        const skip = this.#label();
        this.#emit(Op.JNF, info, {label: skip});
        const F = {f: ctx.frameBase};
        const res = this.#gen(F, init!, RT_NEEDED, NO_PARAM);
        this.#emit(Op.CP, info, reg, res);
        ctx.clearFrame(F.f);
        this.#place(skip);
      }
      ctx.argCount++;
    }
    this.#statement(body!);
    this.#exitBlock();
    this.#commit(ctx);
    this.#ctx = parent;
    return ctx;
  }

  /** `(prop :p.N "p" reg (getter :g.N (block …)) (setter :s.N (param :v.N .) (block …)))`. */
  #property(pos: number): void {
    const src = this.src;
    const [, nameAt, , ...handlers] = src.children(pos);
    const parent = this.#ctx;
    const prop = this.#push(src.text(nameAt!), 'property', src.info(pos));
    for (const h of handlers) {
      const getter = src.isNode(h, T.getter);
      const ctx = this.#push(
        getter ? '(getter)' : '(setter)',
        getter ? 'getter' : 'setter',
        src.info(h),
      );
      this.#enterBlock();
      if (!getter) {
        ctx.ns.add(symbolName(src.text(src.child(h, 1) + 1)));
        ctx.argCount = 1;
      }
      this.#statement(src.children(h).at(-1)!);
      this.#exitBlock();
      this.#commit(ctx);
      this.#ctx = prop;
    }
    this.#commit(prop);
    this.#ctx = parent;
  }

  /** `(class :C.N "C" reg (extends e…) (block …))`. */
  #class(pos: number): void {
    const src = this.src;
    const [, nameAt, , ext, body] = src.children(pos);
    const parent = this.#ctx;
    const ctx = this.#push(src.text(nameAt!), 'class', src.info(pos));
    const bases = src.children(ext!);
    for (const base of bases) this.#extends(ctx, base, bases.length === 1);
    this.#statement(body!);
    if (ctx.superGetter) this.#commit(ctx.superGetter);
    this.#ctx = ctx;
    this.#commit(ctx);
    this.#ctx = parent;
  }

  /** `CreateExtendsExprCode`: calls the base class on the new object, records the getter. */
  #extends(ctx: Context, base: number, hold: boolean): void {
    const info = this.src.info(base);
    const F = {f: ctx.frameBase};
    const res = this.#gen(F, base, RT_NEEDED, NO_PARAM);
    this.#emit(Op.CHGTHIS, info, res, -1);
    this.#emit(Op.CALL, info, 0, res, {isOmit: false, hasExpand: false, items: []});
    if (hold) ctx.superExpr = base;
    ctx.registerPoint = ctx.instructions;
    if (!ctx.superGetter) {
      const getter = this.#push(ctx.name, 'supergetter', info);
      ctx.superGetter = getter;
    }
    // CreateExtendsExprProxyCode, in the super-class getter.
    const getter = ctx.superGetter;
    this.#ctx = getter;
    const entry = this.#label();
    getter.supers.push(entry);
    this.#place(entry);
    const G = {f: getter.frameBase};
    const r = this.#gen(G, base, RT_NEEDED, NO_PARAM);
    this.#emit(Op.SRV, info, r);
    getter.clearFrame(G.f);
    this.#emit(Op.RET, info);
    this.#emit(Op.NOP, info);
    this.#ctx = ctx;
  }

  // ── expressions ──────────────────────────────────────────────────────────

  /** A data item for a constant subtree (`T_CONSTVAL` after folding), or null. */
  #constant(pos: number): LConst | null {
    let c = this.#constants.get(pos);
    if (c === undefined) this.#constants.set(pos, (c = this.#computeConstant(pos)));
    return c;
  }

  readonly #constants = new Map<number, LConst | null>();

  #computeConstant(pos: number): LConst | null {
    const src = this.src;
    switch (src.kind(pos)) {
      case NifKind.Int:
        return {kind: 'integer', value: src.integer(pos)};
      case NifKind.Float:
        return {kind: 'real', value: src.float(pos)};
      case NifKind.Str:
        return {kind: 'string', value: src.text(pos)};
      case NifKind.Symbol: {
        const ctx = this.#contextSymbols.get(src.text(pos));
        return ctx ? {kind: 'context', symbol: ctx.symbol} : null;
      }
      case NifKind.Tag:
        break;
      default:
        return null;
    }
    const tag = src.tag(pos);
    switch (tag) {
      case T.null:
        return {kind: 'null'};
      case T.nan:
        return {kind: 'real', value: NaN};
      case T.inf:
        return {kind: 'real', value: Infinity};
      case T.neginf:
        return {kind: 'real', value: -Infinity};
      case T.octet:
        return {kind: 'octet', value: hexBytes(src.text(pos + 1))};
      case T.carr:
      case T.cdict:
        return this.#constLiteral(pos);
    }
    const unary = FOLD_UNARY.get(tag);
    if (unary) {
      const v = this.#foldable(pos + 1);
      return v ? variantToData(unary(v)) : null;
    }
    const binary = FOLD_BINARY.get(tag);
    if (binary) {
      const [a, b] = src.children(pos);
      const va = this.#foldable(a!);
      if (!va) return null;
      const vb = this.#foldable(b!);
      return vb ? variantToData(binary(va, vb)) : null;
    }
    return null;
  }

  /** The value of a constant subtree that folding may combine (no object constants). */
  #foldable(pos: number): V.Variant | null {
    const c = this.#constant(pos);
    return c ? dataToVariant(c) : null;
  }

  /** `(carr …)` / `(cdict (kv k c)…)`: a constant Array or Dictionary built at compile time. */
  #constLiteral(pos: number): LConst {
    const src = this.src;
    const element = (c: number): LConst => {
      if (src.isNode(c, T.void)) return {kind: 'void'};
      if (src.isNode(c, T.neg) || src.isNode(c, T.pos)) {
        const v = dataToVariant(this.#constant(c + 1)!)!;
        return variantToData(src.isNode(c, T.neg) ? V.negate(v) : V.toNumber(v));
      }
      return this.#constant(c)!;
    };
    if (src.isNode(pos, T.carr)) return {kind: 'array', items: src.children(pos).map(element)};
    return {
      kind: 'dictionary',
      items: src.children(pos).map((kv) => {
        const [k, v] = src.children(kv);
        return [V.asString(dataToVariant(this.#constant(k!)!)!), element(v!)] as const;
      }),
    };
  }

  readonly #contextSymbols = new Map<string, Context>();

  /**
   * `GenNodeCode`: emits the code of the expression at `pos`. Returns the register holding the
   * result (0 when there is none), or `CFLAG`/`CFLAG_I` when the result is the condition flag.
   */
  #gen(F: Frame, pos: number, restype: number, param: SubParam): number {
    const src = this.src,
      ctx = this.#ctx;
    const info = src.info(pos);
    const constant = this.#constant(pos);
    if (constant) {
      if (!(restype & RT_NEEDED)) return 0;
      this.#emit(Op.CONST, info, F.f, {data: constant});
      return F.f++;
    }
    if (src.kind(pos) === NifKind.Symbol) return this.#local(F, pos, restype, param);
    const tag = src.tag(pos);
    if (tag === T.fn) {
      const fn = this.#function(pos, 'exprfunction');
      if (!(restype & RT_NEEDED)) return 0;
      this.#emit(Op.CONST, info, F.f, {data: {kind: 'context', symbol: fn.symbol}});
      return F.f++;
    }

    const arithmetic = ARITHMETIC.get(tag);
    if (arithmetic !== undefined) {
      let r1 = this.#gen(F, pos + 1, RT_NEEDED, NO_PARAM);
      r1 = this.#toFrame(F, r1, info);
      const r2 = this.#gen(F, src.child(pos, 1), RT_NEEDED, NO_PARAM);
      this.#emit(arithmetic, info, r1, r2);
      return r1;
    }
    const comparison = COMPARISON.get(tag);
    if (comparison !== undefined) {
      const [code1, inverted] = comparison;
      let r1 = this.#gen(F, pos + 1, RT_NEEDED, NO_PARAM);
      if (!(restype & RT_CFLAG)) r1 = this.#toFrame(F, r1, info);
      const r2 = this.#gen(F, src.child(pos, 1), RT_NEEDED, NO_PARAM);
      this.#emit(code1, info, r1, r2);
      if (!(restype & RT_CFLAG)) this.#emit(inverted ? Op.SETNF : Op.SETF, info, r1);
      return restype & RT_CFLAG ? (inverted ? CFLAG_I : CFLAG) : r1;
    }
    const unary = UNARY.get(tag);
    if (unary !== undefined || tag === T.eval) {
      let r = this.#gen(F, pos + 1, RT_NEEDED, NO_PARAM);
      r = this.#toFrame(F, r, info);
      const op = unary ?? (restype & RT_NEEDED ? Op.EVAL : Op.EEXP);
      this.#emit(op, info, r);
      return r;
    }
    const opAssign = OP_ASSIGN.get(tag);
    if (opAssign !== undefined) {
      const [target, value] = src.children(pos);
      const r = this.#gen(F, value!, RT_NEEDED, NO_PARAM);
      return this.#gen(F, target!, restype, {type: opAssign, address: r});
    }
    const modify = MODIFY.get(tag);
    if (modify !== undefined) return this.#gen(F, pos + 1, restype, {type: modify, address: 0});

    switch (tag) {
      case T.void:
        return 0;
      case T.this:
        return -1;
      case T.global:
        if (!(restype & RT_NEEDED)) return 0;
        this.#emit(Op.GLOBAL, info, F.f);
        return F.f++;
      case T.proxy:
        return this.#member(F, info, () => -ctx.reserve, true, pos + 1, true, restype, param);
      case T.gproxy:
        return this.#member(
          F,
          info,
          () => this.#global(F, info),
          false,
          pos + 1,
          true,
          restype,
          param,
        );
      case T.wdot: {
        const sym = pos + 1;
        const object = src.isDot(sym)
          ? () => this.#global(F, info)
          : () => ctx.withRegisters.get(src.text(sym))!;
        return this.#member(F, info, object, false, sym + 1, true, restype, param);
      }
      case T.dot:
      case T.at: {
        const [object, member] = src.children(pos);
        return this.#member(
          F,
          info,
          () => this.#gen(F, object!, RT_NEEDED, NO_PARAM),
          false,
          member!,
          tag === T.dot,
          restype,
          param,
        );
      }
      case T.super:
        return this.#gen(F, pos + 1, restype, param);
      case T.dellocal: {
        // The local leaves the namespace; `true` is written above the frame, as natively.
        ctx.ns.remove(symbolName(src.text(pos + 1)));
        if (restype & RT_NEEDED) {
          this.#emit(Op.CONST, info, F.f, {data: {kind: 'integer', value: 1n}});
          return F.f - 1;
        }
        return 0;
      }
      case T.call:
      case T.new:
        return this.#call(F, pos, restype);
      case T.postif: {
        const [body, test] = src.children(pos);
        const r = this.#gen(F, test!, RT_NEEDED | RT_CFLAG, NO_PARAM);
        let inv = false;
        if (!isCFlag(r)) this.#emit(Op.TT, info, r);
        else if (r === CFLAG_I) inv = true;
        const skip = this.#label();
        this.#emit(inv ? Op.JF : Op.JNF, info, {label: skip});
        this.#gen(F, body!, 0, param);
        this.#place(skip);
        return 0;
      }
      case T.incontextof: {
        if (!(restype & RT_NEEDED)) return 0;
        const [fn, context] = src.children(pos);
        let r1 = this.#gen(F, fn!, RT_NEEDED, param);
        const r2 = this.#gen(F, context!, RT_NEEDED, NO_PARAM);
        r1 = this.#toFrame(F, r1, info);
        this.#emit(Op.CHGTHIS, info, r1, r2);
        return r1;
      }
      case T.comma: {
        const [left, right] = src.children(pos);
        this.#gen(F, left!, 0, NO_PARAM);
        return this.#gen(F, right!, restype, param);
      }
      case T.swap: {
        const [left, right] = src.children(pos);
        let r1 = this.#gen(F, left!, RT_NEEDED, NO_PARAM);
        r1 = this.#toFrame(F, r1, info);
        const r2 = this.#gen(F, right!, RT_NEEDED, NO_PARAM);
        this.#gen(F, left!, 0, {type: St.Equal, address: r2});
        this.#gen(F, right!, 0, {type: St.Equal, address: r1});
        return 0;
      }
      case T.asgn: {
        const [target, value] = src.children(pos);
        const r = this.#gen(F, value!, RT_NEEDED, param);
        this.#gen(F, target!, 0, {type: St.Equal, address: r});
        return r;
      }
      case T.cond:
        return this.#question(F, pos, restype, param);
      case T.and:
      case T.or:
        return this.#logical(F, pos, restype);
      case T.instanceof: {
        const [a, b] = src.children(pos);
        let r1 = this.#gen(F, a!, RT_NEEDED, NO_PARAM);
        r1 = this.#toFrame(F, r1, info);
        const r2 = this.#gen(F, b!, RT_NEEDED, NO_PARAM);
        this.#emit(Op.CHKINS, info, r1, r2);
        return r1;
      }
      case T.not: {
        const r = this.#gen(F, pos + 1, restype, NO_PARAM);
        if (!(restype & RT_CFLAG)) {
          const f = this.#toFrame(F, r, info);
          this.#emit(Op.LNOT, info, f);
          return f;
        }
        if (!isCFlag(r)) {
          this.#emit(Op.TF, info, r);
          return CFLAG;
        }
        return r === CFLAG_I ? CFLAG : CFLAG_I;
      }
      case T.typeof: {
        const operand = pos + 1;
        const t = src.tag(operand);
        if (t === T.dot || t === T.at || t === T.wdot)
          return this.#gen(F, operand, RT_NEEDED, {type: St.TypeOf, address: 0});
        let r = this.#gen(F, operand, RT_NEEDED, NO_PARAM);
        r = this.#toFrame(F, r, info);
        this.#emit(Op.TYPEOF, info, r);
        return r;
      }
      case T.ignoreprop:
      case T.propaccess:
        if ((tag === T.ignoreprop) !== !!this.options.unaryAsteriskIgnoresPropAccess) {
          const type =
            param.type === St.None
              ? St.IgnorePropGet
              : param.type === St.Equal
                ? St.IgnorePropSet
                : param.type;
          return this.#gen(F, pos + 1, restype, {type, address: param.address});
        }
        return this.#propAccess(F, pos, restype, param);
      case T.arr:
        return this.#inlineArray(F, pos, restype);
      case T.dict:
        return this.#inlineDictionary(F, pos, restype);
      case T.regexp: {
        if (!(restype & RT_NEEDED)) return 0;
        const [pattern, flags] = src.children(pos);
        const f0 = F.f;
        this.#emit(Op.GLOBAL, info, f0);
        this.#emit(Op.GPD, info, f0 + 1, f0, {data: {kind: 'string', value: 'RegExp'}});
        this.#emit(Op.CONST, info, f0 + 2, {
          data: {kind: 'string', value: `//${src.text(flags!)}/${src.text(pattern!)}`},
        });
        this.#emit(Op.NEW, info, f0, f0 + 1, {isOmit: false, hasExpand: false, items: []});
        this.#emit(
          Op.CALLD,
          info,
          0,
          f0,
          {data: {kind: 'string', value: '_compile'}},
          {
            isOmit: false,
            hasExpand: false,
            items: [{register: f0 + 2, type: ArgType.Normal}],
          },
        );
        F.f = ctx.clearFrame(f0 + 3, f0 + 1);
        return f0;
      }
    }
    throw new Error(`TJS2 lowering: unexpected node ${src.tagName(pos)}`);
  }

  /** Copies a non-temporary result into a new temporary (`if(!TJSIsFrame(r)) cp %frame, r`). */
  #toFrame(F: Frame, r: number, info: number): number {
    if (r > 0) return r;
    this.#emit(Op.CP, info, F.f, r);
    return F.f++;
  }

  #global(F: Frame, info: number): number {
    this.#emit(Op.GLOBAL, info, F.f);
    return F.f++;
  }

  /** `T_SYMBOL` of a local variable. */
  #local(F: Frame, pos: number, restype: number, param: SubParam): number {
    const src = this.src;
    const info = src.info(pos);
    const constant = this.#contextSymbols.get(src.text(pos));
    if (constant) throw new Error('TJS2 lowering: context symbol used as a variable');
    const reg = this.#localRegister(symbolName(src.text(pos)));
    const needed = (restype & RT_NEEDED) !== 0;
    switch (param.type) {
      case St.None:
        return reg;
      case St.Equal:
        this.#emit(Op.CP, info, reg, param.address);
        return 0;
      case St.PreInc:
      case St.PreDec:
        this.#emit(param.type === St.PreInc ? Op.INC : Op.DEC, info, reg);
        return needed ? reg : 0;
      case St.PostInc:
      case St.PostDec:
        if (needed) this.#emit(Op.CP, info, F.f++, reg);
        this.#emit(param.type === St.PostInc ? Op.INC : Op.DEC, info, reg);
        return needed ? F.f - 1 : 0;
    }
    if (param.type >= Op.LOR && param.type <= Op.MUL) {
      this.#emit(param.type, info, reg, param.address);
      return needed ? reg : 0;
    }
    throw new Error('TJS2 lowering: invalid modification of a local');
  }

  /**
   * `T_DOT` / `T_LBRACKET`: member access on the object `object()` yields, by name (`direct`,
   * `member` a string atom) or by the value of the expression `member`.
   */
  #member(
    F: Frame,
    info: number,
    object: () => number,
    thisProxy: boolean,
    member: number,
    direct: boolean,
    restype: number,
    param: SubParam,
  ): number {
    const src = this.src;
    const res = object();
    const dp: Operand = direct
      ? {data: {kind: 'string', value: src.text(member)}}
      : this.#gen(F, member, RT_NEEDED, NO_PARAM);
    const needed = (restype & RT_NEEDED) !== 0;
    const out = () => (needed ? F.f++ : 0);
    switch (param.type) {
      case St.None:
      case St.IgnorePropGet: {
        const op = param.type === St.None ? (direct ? Op.GPD : Op.GPI) : direct ? Op.GPDS : Op.GPIS;
        this.#emit(op, info, F.f, res, dp);
        return F.f++;
      }
      case St.Equal:
      case St.IgnorePropSet: {
        const op =
          param.type === St.Equal
            ? thisProxy
              ? direct
                ? Op.SPD
                : Op.SPI
              : direct
                ? Op.SPDE
                : Op.SPIE
            : direct
              ? Op.SPDS
              : Op.SPIS;
        this.#emit(op, info, res, dp, param.address);
        return param.address;
      }
      case St.PreInc:
      case St.PreDec: {
        const target = needed ? F.f : 0;
        this.#emit(
          (param.type === St.PreInc ? Op.INC : Op.DEC) + (direct ? 1 : 2),
          info,
          target,
          res,
          dp,
        );
        return out();
      }
      case St.PostInc:
      case St.PostDec: {
        let ret = 0;
        if (needed) {
          this.#emit(direct ? Op.GPD : Op.GPI, info, F.f, res, dp);
          ret = F.f++;
        }
        this.#emit(
          (param.type === St.PostInc ? Op.INC : Op.DEC) + (direct ? 1 : 2),
          info,
          0,
          res,
          dp,
        );
        return ret;
      }
      case St.TypeOf: {
        this.#emit(direct ? Op.TYPEOFD : Op.TYPEOFI, info, needed ? F.f : 0, res, dp);
        return out();
      }
      case St.Delete: {
        this.#emit(direct ? Op.DELD : Op.DELI, info, needed ? F.f : 0, res, dp);
        return out();
      }
      case St.FuncCall: {
        this.#emit(
          direct ? Op.CALLD : Op.CALLI,
          info,
          needed ? F.f : 0,
          res,
          dp,
          this.#ctx.funcArgs.at(-1)!,
        );
        return out();
      }
    }
    if (param.type >= Op.LOR && param.type <= Op.MUL) {
      this.#emit(param.type + (direct ? 1 : 2), info, needed ? F.f : 0, res, dp, param.address);
      return out();
    }
    throw new Error('TJS2 lowering: invalid member modification');
  }

  /** Unary `*`: access through the property object. */
  #propAccess(F: Frame, pos: number, restype: number, param: SubParam): number {
    const info = this.src.info(pos);
    const res = this.#gen(F, pos + 1, RT_NEEDED, NO_PARAM);
    const needed = (restype & RT_NEEDED) !== 0;
    switch (param.type) {
      case St.None:
        this.#emit(Op.GETP, info, F.f, res);
        return F.f++;
      case St.Equal:
        this.#emit(Op.SETP, info, res, param.address);
        return param.address;
      case St.PreInc:
      case St.PreDec:
        this.#emit((param.type === St.PreInc ? Op.INC : Op.DEC) + 3, info, needed ? F.f : 0, res);
        return needed ? F.f++ : 0;
      case St.PostInc:
      case St.PostDec: {
        let ret = 0;
        if (needed) {
          this.#emit(Op.GETP, info, F.f, res);
          ret = F.f++;
        }
        this.#emit((param.type === St.PostInc ? Op.INC : Op.DEC) + 3, info, 0, res);
        return ret;
      }
    }
    if (param.type >= Op.LOR && param.type <= Op.MUL) {
      this.#emit(param.type + 3, info, needed ? F.f : 0, res, param.address);
      return needed ? F.f++ : 0;
    }
    throw new Error('TJS2 lowering: invalid property-object modification');
  }

  /** `T_LPARENTHESIS` / `T_NEW`. */
  #call(F: Frame, pos: number, restype: number): number {
    const src = this.src,
      ctx = this.#ctx;
    const info = src.info(pos);
    const [callee, ...args] = src.children(pos);
    const isNew = src.isNode(pos, T.new);
    const ct = src.tag(callee!);
    const direct = !isNew && (ct === T.dot || ct === T.at || ct === T.proxy || ct === T.gproxy);
    if (!direct && restype & RT_NEEDED) F.f++;
    const funcArg: FuncArg = {isOmit: false, hasExpand: false, items: []};
    ctx.funcArgs.push(funcArg);
    const frameStart = F.f;
    try {
      for (const a of args) {
        if (src.isDot(a)) funcArg.items.push({register: 0, type: ArgType.Normal});
        else if (src.isNode(a, T.omit)) funcArg.isOmit = true;
        else if (src.isNode(a, T.expand)) {
          funcArg.hasExpand = true;
          if (src.end(a) > a + 1)
            funcArg.items.push({
              register: this.#gen(F, a + 1, RT_NEEDED, NO_PARAM),
              type: ArgType.Expand,
            });
          else funcArg.items.push({register: 0, type: ArgType.UnnamedExpand});
        } else
          funcArg.items.push({
            register: this.#gen(F, a, RT_NEEDED, NO_PARAM),
            type: ArgType.Normal,
          });
      }
      if (direct) return this.#gen(F, callee!, restype, {type: St.FuncCall, address: 0});
      const fn = this.#gen(F, callee!, RT_NEEDED, NO_PARAM);
      const res = restype & RT_NEEDED ? frameStart - 1 : 0;
      this.#emit(isNew ? Op.NEW : Op.CALL, info, res, fn, funcArg);
      F.f = ctx.clearFrame(F.f, frameStart);
      return res;
    } finally {
      ctx.funcArgs.pop();
    }
  }

  /** `T_QUESTION`. */
  #question(F: Frame, pos: number, restype: number, param: SubParam): number {
    const src = this.src,
      ctx = this.#ctx;
    const info = src.info(pos);
    const [test, yes, no] = src.children(pos);
    const r = this.#gen(F, test!, RT_NEEDED | RT_CFLAG, NO_PARAM);
    let inv = false;
    if (!isCFlag(r)) this.#emit(Op.TT, info, r);
    else if (r === CFLAG_I) inv = true;
    const curFrame = F.f;
    const second = this.#label();
    this.#emit(inv ? Op.JF : Op.JNF, info, {label: second});
    let r1 = this.#gen(F, yes!, restype, param);
    if (restype & RT_CFLAG) {
      if (!isCFlag(r1)) this.#emit(Op.TT, info, r1);
      else if (r1 === CFLAG_I) this.#emit(Op.NF, info);
    } else if (restype & RT_NEEDED && !isCFlag(r1) && !(r1 > 0)) {
      this.#emit(Op.CP, info, F.f, r1);
      r1 = F.f++;
    }
    const frame1 = F.f;
    const end = this.#label();
    this.#emit(Op.JMP, info, {label: end});
    this.#place(second);
    F.f = curFrame;
    const r2 = this.#gen(F, no!, restype, param);
    if (restype & RT_CFLAG) {
      if (!isCFlag(r2)) this.#emit(Op.TT, info, r2);
      else if (r2 === CFLAG_I) this.#emit(Op.NF, info);
    } else if (restype & RT_NEEDED && !isCFlag(r1) && r1 !== r2) {
      this.#emit(Op.CP, info, r1, r2);
      F.f++;
    }
    const frame2 = F.f;
    this.#place(end);
    F.f = frame2 < frame1 ? frame1 : frame2;
    void ctx;
    return restype & RT_CFLAG ? CFLAG : r1;
  }

  /** `T_LOGICALOR` / `T_LOGICALAND`, evaluated with the shortcut. */
  #logical(F: Frame, pos: number, restype: number): number {
    const src = this.src;
    const info = src.info(pos);
    const isOr = src.isNode(pos, T.or);
    const [a, b] = src.children(pos);
    let r1 = this.#gen(F, a!, RT_NEEDED | RT_CFLAG, NO_PARAM);
    if (!isCFlag(r1)) this.#emit(Op.TT, info, r1);
    const inv = r1 === CFLAG_I;
    const skip = this.#label();
    this.#emit(isOr ? (inv ? Op.JNF : Op.JF) : inv ? Op.JF : Op.JNF, info, {label: skip});
    const r2 = this.#gen(F, b!, RT_NEEDED | RT_CFLAG, NO_PARAM);
    if (!isCFlag(r2)) this.#emit(inv ? Op.TF : Op.TT, info, r2);
    else if (inv !== (r2 === CFLAG_I)) this.#emit(Op.NF, info);
    this.#place(skip);
    if (!(restype & RT_CFLAG)) {
      if (isCFlag(r1) || !(r1 > 0)) {
        this.#emit(inv ? Op.SETNF : Op.SETF, info, F.f);
        r1 = F.f++;
      } else {
        this.#emit(inv ? Op.SETNF : Op.SETF, info, r1);
      }
    }
    return restype & RT_CFLAG ? (inv ? CFLAG_I : CFLAG) : r1;
  }

  /** `T_INLINEARRAY`: `new Array()`, then each element stored at an increasing index. */
  #inlineArray(F: Frame, pos: number, restype: number): number {
    const src = this.src,
      ctx = this.#ctx;
    const info = src.info(pos);
    const f0 = F.f;
    this.#emit(Op.GLOBAL, info, f0);
    this.#emit(Op.GPD, info, f0 + 1, f0, {data: {kind: 'string', value: 'Array'}});
    this.#emit(Op.NEW, info, f0, f0 + 1, {isOmit: false, hasExpand: false, items: []});
    this.#emit(Op.CONST, info, f0 + 1, {data: {kind: 'integer', value: 0n}});
    F.f += 2;
    ctx.arrayArgs.push({object: f0, counter: f0 + 1});
    for (let c = pos + 1, end = src.end(pos); c < end; c = src.next(c)) {
      const frameStart = F.f;
      const r = src.isDot(c) ? 0 : this.#gen(F, c, RT_NEEDED, NO_PARAM);
      const einfo = src.info(c);
      this.#emit(Op.SPIS, einfo, f0, f0 + 1, r);
      this.#emit(Op.INC, einfo, f0 + 1);
      F.f = ctx.clearFrame(F.f, frameStart);
    }
    ctx.arrayArgs.pop();
    return restype & RT_NEEDED ? f0 : 0;
  }

  /** `T_INLINEDIC`. */
  #inlineDictionary(F: Frame, pos: number, restype: number): number {
    const src = this.src,
      ctx = this.#ctx;
    const info = src.info(pos);
    const f0 = F.f;
    this.#emit(Op.GLOBAL, info, f0);
    this.#emit(Op.GPD, info, f0 + 1, f0, {data: {kind: 'string', value: 'Dictionary'}});
    this.#emit(Op.NEW, info, f0, f0 + 1, {isOmit: false, hasExpand: false, items: []});
    F.f = ctx.clearFrame(f0 + 2, f0 + 1);
    for (let c = pos + 1, end = src.end(pos); c < end; c = src.next(c)) {
      const frameStart = F.f;
      const [k, v] = src.children(c);
      const name = this.#gen(F, k!, RT_NEEDED, NO_PARAM);
      const value = this.#gen(F, v!, RT_NEEDED, NO_PARAM);
      this.#emit(Op.SPIS, src.info(c), f0, name, value);
      F.f = ctx.clearFrame(F.f, frameStart);
    }
    return restype & RT_NEEDED ? f0 : 0;
  }
}

function isCFlag(r: number): boolean {
  return r === CFLAG || r === CFLAG_I;
}

/** The source name of a symbol `name.N`. */
function symbolName(symbol: string): string {
  return symbol.slice(0, symbol.lastIndexOf('.'));
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
