/**
 * The TJS2 VM (krkrz `tjsInterCodeExec.cpp`, `ExecuteAsFunction` and `ExecuteCode`): runs the
 * code of a context on a register frame. A call from script code to another function goes
 * through the callee's `Dispatch` methods and runs it on its own frame; each frame is an
 * explicit record (code, registers, position, try handlers), so a callee that suspends leaves
 * the frame where it stopped and the frame continues from there when the suspension ends.
 */
import {lineOfCodePosition} from '../code-block.js';
import {ArgType, instructionSize, Op} from '../opcodes.js';
import {ARRAY_CLASS_ID, instanceOf, type ArrayNI} from '../runtime/builtins/array.js';
import type {TjsEngine, TjsScriptExecutor} from '../runtime/engine.js';
import {
  throwFromCode,
  throwTjsError,
  TjsError,
  TjsScriptError,
  TjsScriptException,
  TjsSuspensionError,
  type TjsScriptSource,
} from '../runtime/errors.js';
import {
  TJS_CII_ADD,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NOTIMPL,
  TJS_E_SUSPENDED,
  TJS_HIDDENMEMBER,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_MEMBERMUSTEXIST,
  TJS_OP_ADD,
  TJS_OP_BAND,
  TJS_OP_BOR,
  TJS_OP_BXOR,
  TJS_OP_DEC,
  TJS_OP_DIV,
  TJS_OP_IDIV,
  TJS_OP_INC,
  TJS_OP_LAND,
  TJS_OP_LOR,
  TJS_OP_MOD,
  TJS_OP_MUL,
  TJS_OP_SAL,
  TJS_OP_SAR,
  TJS_OP_SR,
  TJS_OP_SUB,
  TJS_S_OK,
  TJS_S_TRUE,
  type Dispatch,
  type Out,
  type VariantResult,
} from '../runtime/interface.js';
import {addRefVariant, releaseVariant, VariantSlot} from '../runtime/slot.js';
import type {Outcome, Suspender} from '../runtime/suspension.js';
import * as V from '../runtime/variant.js';
import type {ObjectVariant, Variant} from '../runtime/variant.js';
import {defaultIsInstanceOf} from '../runtime/dispatch.js';
import type {InterCodeContext} from './context.js';
import {ObjectProxy} from './object-proxy.js';
import {
  getOctetProperty,
  getStringProperty,
  processOctetFunction,
  processStringFunction,
  setStringProperty,
} from './string-methods.js';
import {VariantArrayStack} from './variant-stack.js';

/** `TJS_OP_*` of each operator family, indexed by `(opcode - Op.LOR) / 4`. */
const OPERATIONS = [
  TJS_OP_LOR,
  TJS_OP_LAND,
  TJS_OP_BOR,
  TJS_OP_BXOR,
  TJS_OP_BAND,
  TJS_OP_SAR,
  TJS_OP_SAL,
  TJS_OP_SR,
  TJS_OP_ADD,
  TJS_OP_SUB,
  TJS_OP_MOD,
  TJS_OP_DIV,
  TJS_OP_IDIV,
  TJS_OP_MUL,
];

/** A running function. */
interface Frame {
  readonly ctx: InterCodeContext;
  readonly code: Int32Array;
  readonly data: readonly Variant[];
  readonly regs: VariantSlot[];
  /** Index of register 0 in `regs`. */
  readonly ra: number;
  readonly count: number;
  readonly objthis: Dispatch | null;
  readonly args: readonly Variant[];
  readonly result: VariantResult | null;
  /** Position of the instruction being executed (`codesave`). */
  pc: number;
  /** Active try blocks: catch position and exception register, innermost last. */
  readonly tries: number[];
  /** Finishes the suspended instruction at `pc` with its call's result code. */
  pending: ((code: number) => void) | null;
}

export interface VmOptions {
  /** `-evalcontext=global` (`TJSEvalOperatorIsOnGlobal`): `!` evaluates on `global`. */
  readonly evalOperatorIsOnGlobal?: boolean;
}

const blockAddresses = new WeakMap<object, number>();
let nextBlockAddress = 0x02000000;

export class Vm {
  readonly stack = new VariantArrayStack();
  readonly suspender: Suspender;
  /** Size of the argument operand of the last `#callArgs`. */
  #argSize = 0;

  constructor(
    readonly engine: TjsEngine,
    readonly executor: TjsScriptExecutor,
    readonly options: VmOptions = {},
  ) {
    this.suspender = engine.suspender;
  }

  /**
   * `ExecuteAsFunction`: runs `ctx` from `startIp` with `this` = `objthis` and the given
   * arguments; the return value goes to `result`. Returns `TJS_S_OK` or `TJS_E_SUSPENDED`;
   * script exceptions are thrown.
   */
  executeAsFunction(
    ctx: InterCodeContext,
    objthis: Dispatch | null,
    args: readonly Variant[],
    result: VariantResult | null,
    startIp: number,
  ): number {
    const c = ctx.code;
    const reserve = c.variableReserveCount;
    const count = ctx.variables + reserve + 1 + ctx.frameRegisters;
    const {array: regs, base} = this.stack.allocate(count);
    const ra = base + ctx.variables + reserve;
    ctx.addRef();
    objthis?.addRef();
    for (const a of args) addRefVariant(a);
    const f: Frame = {
      ctx,
      code: c.code,
      data: ctx.data,
      regs,
      ra,
      count,
      objthis,
      args,
      result,
      pc: startIp,
      tries: [],
      pending: null,
    };
    try {
      const global = this.engine.global;
      if (reserve >= 2)
        regs[ra - 2]!.set(
          objthis ? V.obj(new ObjectProxy(objthis, global)) : V.obj(global, global),
        );
      if (reserve >= 1) regs[ra - 1]!.set(V.obj(objthis, objthis));
      regs[ra]!.clear();
      const declared = c.funcDeclArgCount;
      for (let i = 0; i < declared; i++) {
        const r = regs[ra - 3 - i]!;
        if (i < args.length) r.set(args[i]!);
        else r.clear();
      }
      if (c.funcDeclCollapseBase >= 0) {
        const array = this.engine.createArray();
        regs[ra - 3 - c.funcDeclCollapseBase]!.set(V.obj(array, array));
        array.release();
        for (let i = c.funcDeclCollapseBase, n = 0; i < args.length; i++, n++)
          array.propSetByNum(0, n, args[i]!, array);
      }
    } catch (e) {
      this.#exit(f);
      throw e;
    }
    return this.#run(f);
  }

  /** Ends a frame: releases the proxy register, the registers and the references held. */
  #exit(f: Frame): void {
    if (f.ctx.code.variableReserveCount >= 2) f.regs[f.ra - 2]!.clear();
    this.stack.deallocate(f.count, f.regs);
    for (const a of f.args) releaseVariant(a);
    f.objthis?.release();
    f.ctx.release();
  }

  #run(f: Frame): number {
    for (;;) {
      try {
        const hr = this.#execute(f);
        if (hr !== TJS_E_SUSPENDED) this.#exit(f);
        return hr;
      } catch (e) {
        const rethrow = this.#catch(f, e);
        if (rethrow !== null) {
          this.#exit(f);
          throw rethrow;
        }
      }
    }
  }

  #suspend(f: Frame, finish: (code: number) => void): number {
    f.pending = finish;
    return this.suspender.defer((outcome) => this.#resume(f, outcome));
  }

  #resume(f: Frame, outcome: Outcome): number {
    const finish = f.pending!;
    f.pending = null;
    try {
      if ('error' in outcome) throw outcome.error;
      finish(outcome.code);
      f.pc += instructionSize(f.code, f.pc);
    } catch (e) {
      const rethrow = this.#catch(f, e);
      if (rethrow !== null) {
        this.#exit(f);
        throw rethrow;
      }
    }
    return this.#run(f);
  }

  /**
   * An exception raised by the instruction at `f.pc`. Inside a try block the exception becomes
   * a TJS value in the block's register and execution continues at the catch position (null is
   * returned). Otherwise the error to throw on is returned: a script error with this frame
   * appended to its trace, or, for any other TJS error, a script error at this position.
   */
  #catch(f: Frame, e: unknown): unknown {
    if (!(e instanceof TjsError) || e instanceof TjsSuspensionError) return e;
    if (f.tries.length) {
      const exReg = f.tries.pop()!;
      const catchIp = f.tries.pop()!;
      let error: TjsScriptError;
      if (e instanceof TjsScriptError) {
        e.addTrace(this.#describe(f));
        error = e;
      } else error = new TjsScriptError(e.message, this.#source(f));
      const slot = f.regs[f.ra + exReg]!;
      if (error instanceof TjsScriptException) slot.adopt(error.value);
      else slot.adopt(this.engine.exceptionObject(error.message, error.trace));
      f.pc = catchIp;
      return null;
    }
    if (e instanceof TjsScriptError) {
      e.addTrace(this.#describe(f));
      return e;
    }
    return new TjsScriptError(e.message, this.#source(f));
  }

  #blockName(f: Frame): string {
    const block = f.ctx.block;
    if (block.name) return block.name;
    let a = blockAddresses.get(block);
    if (a === undefined) {
      a = nextBlockAddress;
      nextBlockAddress += 0x40;
      blockAddresses.set(block, a);
    }
    return `anonymous@0x${a.toString(16).toUpperCase().padStart(8, '0')}`;
  }

  #source(f: Frame): TjsScriptSource {
    return {name: f.ctx.block.name, line: lineOfCodePosition(f.ctx.code, f.pc)};
  }

  /** `GetPositionDescriptionString`: `name(line)[(function) f]`. */
  #describe(f: Frame): string {
    const line = lineOfCodePosition(f.ctx.code, f.pc);
    return `${this.#blockName(f)}(${line})[${f.ctx.shortDescription()}]`;
  }

  /** `ra[-1].AsObjectNoAddRef()`. */
  #this(f: Frame): Dispatch | null {
    const v = f.regs[f.ra - 1]!.value;
    return v.type === 1 ? v.object : null;
  }

  /** The object of a closure operand (`AsObjectClosure`, null access check). */
  #object(v: Variant): ObjectVariant & {object: Dispatch} {
    const clo = V.asObjectClosure(v);
    if (!clo.object) throwTjsError('TJSNullAccess');
    return clo as ObjectVariant & {object: Dispatch};
  }

  /** The arguments of a call instruction starting at `code[at]`; sets `#argSize`. */
  #callArgs(f: Frame, at: number): readonly Variant[] {
    const code = f.code,
      regs = f.regs,
      ra = f.ra;
    const n = code[at]!;
    if (n === -1) {
      this.#argSize = 1;
      return f.args;
    }
    if (n === -2) {
      const count = code[at + 1]!;
      this.#argSize = 2 + count * 2;
      const unnamedBase = f.ctx.code.funcDeclUnnamedArgArrayBase;
      const args: Variant[] = [];
      for (let i = 0; i < count; i++) {
        const type = code[at + 2 + i * 2]!;
        const reg = code[at + 3 + i * 2]!;
        if (type === ArgType.Normal) args.push(regs[ra + reg]!.value);
        else if (type === ArgType.Expand) {
          const dsp = V.asObject(regs[ra + reg]!.value);
          if (!dsp) throwTjsError('TJSNullAccess');
          const ni = instanceOf<ArrayNI>(dsp, ARRAY_CLASS_ID);
          if (!ni) throwTjsError('TJSSpecifyArray');
          args.push(...ni.items);
        } else for (let k = unnamedBase; k < f.args.length; k++) args.push(f.args[k]!);
      }
      return args;
    }
    this.#argSize = 1 + n;
    const args = new Array<Variant>(n);
    for (let i = 0; i < n; i++) args[i] = regs[ra + code[at + 1 + i]!]!.value;
    return args;
  }

  /** The member name of an indirect access (`*AsString()`; the empty string is none). */
  static #indirectName(v: Variant): string | null {
    const s = V.asString(v);
    return s === '' ? null : s;
  }

  /** `ExecuteCode`: runs from `f.pc` until `ret` or a suspension. */
  #execute(f: Frame): number {
    const code = f.code,
      data = f.data,
      regs = f.regs,
      ra = f.ra;
    let pc = f.pc;
    let flag = false;
    for (;;) {
      f.pc = pc;
      const op = code[pc]!;
      switch (op) {
        case Op.NOP:
          pc++;
          break;
        case Op.CONST:
          regs[ra + code[pc + 1]!]!.set(data[code[pc + 2]!]!);
          pc += 3;
          break;
        case Op.CP:
          regs[ra + code[pc + 1]!]!.set(regs[ra + code[pc + 2]!]!.value);
          pc += 3;
          break;
        case Op.CL:
          regs[ra + code[pc + 1]!]!.clear();
          pc += 2;
          break;
        case Op.CCL: {
          const r = ra + code[pc + 1]!;
          for (let i = 0, n = code[pc + 2]!; i < n; i++) regs[r + i]!.clear();
          pc += 3;
          break;
        }
        case Op.TT:
          flag = V.asBoolean(regs[ra + code[pc + 1]!]!.value);
          pc += 2;
          break;
        case Op.TF:
          flag = !V.asBoolean(regs[ra + code[pc + 1]!]!.value);
          pc += 2;
          break;
        case Op.CEQ:
          flag = V.normalCompare(regs[ra + code[pc + 1]!]!.value, regs[ra + code[pc + 2]!]!.value);
          pc += 3;
          break;
        case Op.CDEQ:
          flag = V.discernCompare(regs[ra + code[pc + 1]!]!.value, regs[ra + code[pc + 2]!]!.value);
          pc += 3;
          break;
        case Op.CLT:
          flag = V.greaterThan(regs[ra + code[pc + 1]!]!.value, regs[ra + code[pc + 2]!]!.value);
          pc += 3;
          break;
        case Op.CGT:
          flag = V.littlerThan(regs[ra + code[pc + 1]!]!.value, regs[ra + code[pc + 2]!]!.value);
          pc += 3;
          break;
        case Op.SETF:
          regs[ra + code[pc + 1]!]!.set(V.bool(flag));
          pc += 2;
          break;
        case Op.SETNF:
          regs[ra + code[pc + 1]!]!.set(V.bool(!flag));
          pc += 2;
          break;
        case Op.LNOT: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.logicalNot(r.value));
          pc += 2;
          break;
        }
        case Op.NF:
          flag = !flag;
          pc++;
          break;
        case Op.JF:
          pc += flag ? code[pc + 1]! : 2;
          break;
        case Op.JNF:
          pc += flag ? 2 : code[pc + 1]!;
          break;
        case Op.JMP:
          pc += code[pc + 1]!;
          break;
        case Op.INC: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.increment(r.value));
          pc += 2;
          break;
        }
        case Op.DEC: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.decrement(r.value));
          pc += 2;
          break;
        }
        case Op.INCPD:
        case Op.DECPD:
        case Op.INCPI:
        case Op.DECPI:
        case Op.INCP:
        case Op.DECP: {
          const base = op >= Op.DEC ? Op.DEC : Op.INC;
          const hr = this.#operate(f, op - base, op >= Op.DEC ? TJS_OP_DEC : TJS_OP_INC, false);
          if (hr === TJS_E_SUSPENDED) return hr;
          pc = f.pc;
          break;
        }
        case Op.BNOT: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.bitNot(r.value));
          pc += 2;
          break;
        }
        case Op.ASC: {
          const r = regs[ra + code[pc + 1]!]!;
          const s = V.asString(r.value);
          r.set(V.int(s.length ? s.charCodeAt(0) : 0));
          pc += 2;
          break;
        }
        case Op.CHR: {
          const r = regs[ra + code[pc + 1]!]!;
          const c = Number(BigInt.asUintN(16, V.asInteger(r.value)));
          r.set(V.str(c === 0 ? '' : String.fromCharCode(c)));
          pc += 2;
          break;
        }
        case Op.NUM: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.toNumber(r.value));
          pc += 2;
          break;
        }
        case Op.CHS: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.negate(r.value));
          pc += 2;
          break;
        }
        case Op.INV: {
          const r = regs[ra + code[pc + 1]!]!;
          if (r.value.type !== 1) r.set(V.bool(false));
          else {
            const clo = this.#object(r.value);
            const hr = clo.object.invalidate(0, null, clo.objthis ?? this.#this(f) ?? clo.object);
            r.set(V.bool(hr === TJS_S_TRUE));
          }
          pc += 2;
          break;
        }
        case Op.CHKINV: {
          const r = regs[ra + code[pc + 1]!]!;
          if (r.value.type !== 1) r.set(V.bool(true));
          else {
            const clo = this.#object(r.value);
            const hr = clo.object.isValid(0, null, clo.objthis ?? this.#this(f) ?? clo.object);
            r.set(V.bool(hr === TJS_S_TRUE || hr === TJS_E_NOTIMPL));
          }
          pc += 2;
          break;
        }
        case Op.INT: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.integer(V.asInteger(r.value)));
          pc += 2;
          break;
        }
        case Op.REAL: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.real(V.asReal(r.value)));
          pc += 2;
          break;
        }
        case Op.STR: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.str(V.asString(r.value)));
          pc += 2;
          break;
        }
        case Op.OCTET: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.octet(V.asOctet(r.value)));
          pc += 2;
          break;
        }
        case Op.TYPEOF: {
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.str(V.typeOfName(r.value)));
          pc += 2;
          break;
        }
        case Op.TYPEOFD:
        case Op.TYPEOFI: {
          const hr = this.#typeOfMember(f, op === Op.TYPEOFD);
          if (hr === TJS_E_SUSPENDED) return hr;
          pc += 4;
          break;
        }
        case Op.EVAL:
        case Op.EEXP: {
          const hr = this.#eval(f, op === Op.EVAL);
          if (hr === TJS_E_SUSPENDED) return hr;
          pc += 2;
          break;
        }
        case Op.CHKINS: {
          const targ = regs[ra + code[pc + 1]!]!;
          const name = V.asString(regs[ra + code[pc + 2]!]!.value);
          if (name === '') targ.set(V.bool(false));
          else {
            const hr = defaultIsInstanceOf(0, targ.value, name, null);
            if (hr < 0) throwFromCode(hr);
            targ.set(V.bool(hr === TJS_S_TRUE));
          }
          pc += 3;
          break;
        }
        case Op.CALL:
        case Op.NEW:
        case Op.CALLD:
        case Op.CALLI: {
          const hr = this.#call(f, op);
          if (hr === TJS_E_SUSPENDED) return hr;
          pc = f.pc;
          break;
        }
        case Op.GPD:
        case Op.GPDS:
        case Op.GPI:
        case Op.GPIS: {
          const hr = this.#getProperty(f, op);
          if (hr === TJS_E_SUSPENDED) return hr;
          pc += 4;
          break;
        }
        case Op.SPD:
        case Op.SPDE:
        case Op.SPDEH:
        case Op.SPDS:
        case Op.SPI:
        case Op.SPIE:
        case Op.SPIS: {
          const hr = this.#setProperty(f, op);
          if (hr === TJS_E_SUSPENDED) return hr;
          pc += 4;
          break;
        }
        case Op.GETP: {
          const clo = this.#object(regs[ra + code[pc + 2]!]!.value);
          const hr = clo.object.propGet(
            0,
            null,
            regs[ra + code[pc + 1]!]!,
            clo.objthis ?? this.#this(f) ?? clo.object,
          );
          if (hr === TJS_E_SUSPENDED) return this.#suspend(f, (h) => checkCode(h, null));
          checkCode(hr, null);
          pc += 3;
          break;
        }
        case Op.SETP: {
          const clo = this.#object(regs[ra + code[pc + 1]!]!.value);
          const hr = clo.object.propSet(
            0,
            null,
            regs[ra + code[pc + 2]!]!.value,
            clo.objthis ?? this.#this(f) ?? clo.object,
          );
          if (hr === TJS_E_SUSPENDED) return this.#suspend(f, (h) => checkCode(h, null));
          checkCode(hr, null);
          pc += 3;
          break;
        }
        case Op.DELD:
        case Op.DELI: {
          const hr = this.#deleteMember(f, op === Op.DELD);
          if (hr === TJS_E_SUSPENDED) return hr;
          pc += 4;
          break;
        }
        case Op.SRV:
          f.result?.set(regs[ra + code[pc + 1]!]!.value);
          pc += 2;
          break;
        case Op.RET:
          return TJS_S_OK;
        case Op.ENTRY:
          f.tries.push(pc + code[pc + 1]!, code[pc + 2]!);
          pc += 3;
          break;
        case Op.EXTRY:
          f.tries.length -= 2;
          pc++;
          break;
        case Op.THROW:
          this.#throw(f, regs[ra + code[pc + 1]!]!.value);
          break;
        case Op.CHGTHIS: {
          const objthis = V.asObject(regs[ra + code[pc + 2]!]!.value);
          const r = regs[ra + code[pc + 1]!]!;
          r.set(V.obj(V.asObjectClosure(r.value).object, objthis));
          pc += 3;
          break;
        }
        case Op.GLOBAL:
          regs[ra + code[pc + 1]!]!.set(V.obj(this.engine.global));
          pc += 2;
          break;
        case Op.ADDCI: {
          const dsp = V.asObject(regs[ra + code[pc + 1]!]!.value);
          dsp?.classInstanceInfo(TJS_CII_ADD, 0, regs[ra + code[pc + 2]!]!);
          pc += 3;
          break;
        }
        case Op.REGMEMBER: {
          const dest = this.#this(f);
          if (dest) f.ctx.registerObjectMember(dest);
          pc++;
          break;
        }
        case Op.DEBUGGER:
          pc++;
          break;
        default:
          if (op >= Op.LOR && op <= Op.MULP) {
            const family = (op - Op.LOR) >> 2;
            const variant = (op - Op.LOR) & 3;
            if (variant === 0) {
              const r = regs[ra + code[pc + 1]!]!;
              r.set(binary(family, r.value, regs[ra + code[pc + 2]!]!.value));
              pc += 3;
              break;
            }
            const hr = this.#operate(f, variant, OPERATIONS[family]!, true);
            if (hr === TJS_E_SUSPENDED) return hr;
            pc = f.pc;
            break;
          }
          throwTjsError('TJSInvalidOpecode');
      }
    }
  }

  /**
   * The property variants of the operators (`OperatePropertyDirect`/`Indirect`/`Property` and
   * their `…0` forms without operand): `variant` 1 by name, 2 by value, 3 the property object.
   * Advances `f.pc` past the instruction unless the call suspends.
   */
  #operate(f: Frame, variant: number, operation: number, withParam: boolean): number {
    const code = f.code,
      regs = f.regs,
      ra = f.ra,
      pc = f.pc;
    const target = code[pc + 1]! ? regs[ra + code[pc + 1]!]! : null;
    const clo = this.#object(regs[ra + code[pc + 2]!]!.value);
    const objthis = clo.objthis ?? this.#this(f) ?? clo.object;
    let size: number;
    let hr: number;
    let name: string | null;
    if (variant === 1) {
      name = V.asString(f.data[code[pc + 3]!]!);
      const param = withParam ? regs[ra + code[pc + 4]!]!.value : null;
      size = withParam ? 5 : 4;
      hr = clo.object.operation(operation, name, target, param, objthis);
    } else if (variant === 2) {
      const index = regs[ra + code[pc + 3]!]!.value;
      const param = withParam ? regs[ra + code[pc + 4]!]!.value : null;
      size = withParam ? 5 : 4;
      if (index.type !== 4) {
        name = Vm.#indirectName(index);
        hr = clo.object.operation(operation, name, target, param, objthis);
      } else {
        const n = V.asInt32(index);
        name = String(n);
        hr = clo.object.operationByNum(operation, n, target, param, objthis);
      }
    } else {
      name = null;
      const param = withParam ? regs[ra + code[pc + 3]!]!.value : null;
      size = withParam ? 4 : 3;
      hr = clo.object.operation(operation, null, target, param, objthis);
    }
    if (hr === TJS_E_SUSPENDED) return this.#suspend(f, (h) => checkCode(h, name));
    checkCode(hr, name);
    f.pc = pc + size;
    return TJS_S_OK;
  }

  #getProperty(f: Frame, op: number): number {
    const code = f.code,
      regs = f.regs,
      ra = f.ra,
      pc = f.pc;
    const direct = op === Op.GPD || op === Op.GPDS;
    const flags = op === Op.GPDS || op === Op.GPIS ? TJS_IGNOREPROP : 0;
    const target = regs[ra + code[pc + 1]!]!;
    const v = regs[ra + code[pc + 2]!]!.value;
    const member = direct ? f.data[code[pc + 3]!]! : regs[ra + code[pc + 3]!]!.value;
    if (v.type === 2) {
      getStringProperty(target, v.value, member);
      return TJS_S_OK;
    }
    if (v.type === 3) {
      getOctetProperty(target, v.value, member);
      return TJS_S_OK;
    }
    const clo = this.#object(v);
    const objthis = clo.objthis ?? this.#this(f) ?? clo.object;
    let hr: number;
    let name: string | null;
    if (direct || member.type !== 4) {
      name = direct ? V.asString(member) : Vm.#indirectName(member);
      hr = clo.object.propGet(flags, name, target, objthis);
    } else {
      const n = V.asInt32(member);
      name = String(n);
      hr = clo.object.propGetByNum(flags, n, target, objthis);
    }
    if (hr === TJS_E_SUSPENDED) return this.#suspend(f, (h) => checkCode(h, name));
    checkCode(hr, name);
    return TJS_S_OK;
  }

  #setProperty(f: Frame, op: number): number {
    const code = f.code,
      regs = f.regs,
      ra = f.ra,
      pc = f.pc;
    const direct = op === Op.SPD || op === Op.SPDE || op === Op.SPDEH || op === Op.SPDS;
    const flags =
      op === Op.SPDE || op === Op.SPIE
        ? TJS_MEMBERENSURE
        : op === Op.SPDEH
          ? TJS_MEMBERENSURE | TJS_HIDDENMEMBER
          : op === Op.SPDS || op === Op.SPIS
            ? TJS_MEMBERENSURE | TJS_IGNOREPROP
            : 0;
    const v = regs[ra + code[pc + 1]!]!.value;
    const member = direct ? f.data[code[pc + 2]!]! : regs[ra + code[pc + 2]!]!.value;
    const value = regs[ra + code[pc + 3]!]!.value;
    if (v.type === 2 || v.type === 3) setStringProperty(member);
    const clo = this.#object(v);
    const objthis = clo.objthis ?? this.#this(f) ?? clo.object;
    let hr: number;
    let name: string | null;
    if (direct || member.type !== 4) {
      name = direct ? V.asString(member) : Vm.#indirectName(member);
      hr = clo.object.propSet(flags, name, value, objthis);
    } else {
      const n = V.asInt32(member);
      name = String(n);
      hr = clo.object.propSetByNum(flags, n, value, objthis);
    }
    if (hr === TJS_E_SUSPENDED) return this.#suspend(f, (h) => checkCode(h, name));
    checkCode(hr, name);
    return TJS_S_OK;
  }

  #deleteMember(f: Frame, direct: boolean): number {
    const code = f.code,
      regs = f.regs,
      ra = f.ra,
      pc = f.pc;
    const clo = this.#object(regs[ra + code[pc + 2]!]!.value);
    const target = code[pc + 1]! ? regs[ra + code[pc + 1]!]! : null;
    let hr: number;
    if (direct) {
      hr = clo.object.deleteMember(
        0,
        V.asString(f.data[code[pc + 3]!]!),
        clo.objthis ?? this.#this(f) ?? clo.object,
      );
    } else {
      const name = Vm.#indirectName(regs[ra + code[pc + 3]!]!.value);
      hr = clo.object.deleteMember(0, name, clo.objthis ?? this.#this(f) ?? clo.object);
    }
    const finish = (h: number) => target?.set(V.bool(h >= 0));
    if (hr === TJS_E_SUSPENDED) return this.#suspend(f, finish);
    finish(hr);
    return TJS_S_OK;
  }

  /** `TypeOfMemberDirect`/`Indirect`: `"undefined"` for a member that does not exist. */
  #typeOfMember(f: Frame, direct: boolean): number {
    const code = f.code,
      regs = f.regs,
      ra = f.ra,
      pc = f.pc;
    // Register 0 receives the result when it is not used, as natively.
    const target = regs[ra + code[pc + 1]!]!;
    const v = regs[ra + code[pc + 2]!]!.value;
    const member = direct ? f.data[code[pc + 3]!]! : regs[ra + code[pc + 3]!]!.value;
    if (v.type === 2 || v.type === 3) {
      if (v.type === 2) getStringProperty(target, v.value, member);
      else getOctetProperty(target, v.value, member);
      target.set(V.str(V.typeOfName(target.value)));
      return TJS_S_OK;
    }
    const clo = this.#object(v);
    const objthis = clo.objthis ?? this.#this(f) ?? clo.object;
    let hr: number;
    let name: string | null;
    if (direct || member.type !== 4) {
      name = direct ? V.asString(member) : Vm.#indirectName(member);
      hr = clo.object.propGet(TJS_MEMBERMUSTEXIST, name, target, objthis);
    } else {
      const n = V.asInt32(member);
      name = String(n);
      hr = clo.object.propGetByNum(TJS_MEMBERMUSTEXIST, n, target, objthis);
    }
    const finish = (h: number) => {
      if (h === TJS_S_OK) target.set(V.str(V.typeOfName(target.value)));
      else if (h === TJS_E_MEMBERNOTFOUND) target.set(V.str('undefined'));
      else checkCode(h, name);
    };
    if (hr === TJS_E_SUSPENDED) return this.#suspend(f, finish);
    finish(hr);
    return TJS_S_OK;
  }

  /** `CallFunction`, `CallFunctionDirect`, `CallFunctionIndirect`. Advances `f.pc`. */
  #call(f: Frame, op: number): number {
    const code = f.code,
      regs = f.regs,
      ra = f.ra,
      pc = f.pc;
    const r = code[pc + 1]!;
    const target = r ? regs[ra + r]! : null;
    if (op === Op.CALL || op === Op.NEW) {
      const args = this.#callArgs(f, pc + 3);
      const size = 3 + this.#argSize;
      const clo = this.#object(regs[ra + code[pc + 2]!]!.value);
      const objthis = clo.objthis ?? this.#this(f) ?? clo.object;
      let hr: number;
      let finish: (h: number) => void;
      if (op === Op.CALL) {
        hr = clo.object.funcCall(0, null, target, args, objthis);
        finish = (h) => checkCode(h, '');
      } else {
        const out: Out<Dispatch | null> = {value: null};
        hr = clo.object.createNew(0, null, out, args, objthis);
        finish = (h) => {
          if (h >= 0 && out.value) {
            target?.set(V.obj(out.value, out.value));
            out.value.release();
          }
          checkCode(h, '');
        };
      }
      if (hr === TJS_E_SUSPENDED) return this.#suspend(f, finish);
      finish(hr);
      f.pc = pc + size;
      return TJS_S_OK;
    }
    // A direct call names the member by data; an indirect one by a register, read first.
    const name =
      op === Op.CALLD
        ? V.asString(f.data[code[pc + 3]!]!)
        : V.asString(regs[ra + code[pc + 3]!]!.value);
    const args = this.#callArgs(f, pc + 4);
    const size = 4 + this.#argSize;
    const v = regs[ra + code[pc + 2]!]!.value;
    if (v.type === 2) {
      processStringFunction(this.engine, name, v.value, args, target as VariantSlot | null);
      f.pc = pc + size;
      return TJS_S_OK;
    }
    if (v.type === 3) {
      processOctetFunction(this.engine, name, v.value, args, target as VariantSlot | null);
      f.pc = pc + size;
      return TJS_S_OK;
    }
    const clo = this.#object(v);
    const hr = clo.object.funcCall(
      0,
      name,
      target,
      args,
      clo.objthis ?? this.#this(f) ?? clo.object,
    );
    if (hr === TJS_E_SUSPENDED) return this.#suspend(f, (h) => checkCode(h, name));
    checkCode(hr, name);
    f.pc = pc + size;
    return TJS_S_OK;
  }

  /** `Eval`: the string in the register as an expression, its value back in the register. */
  #eval(f: Frame, resultNeeded: boolean): number {
    const reg = f.regs[f.ra + f.code[f.pc + 1]!]!;
    const text = V.asString(reg.value);
    const objthis = this.options.evalOperatorIsOnGlobal ? null : this.#this(f);
    const res = new VariantSlot();
    const finish = () => {
      if (resultNeeded) reg.set(res.value);
      res.clear();
    };
    if (text === '') {
      finish();
      return TJS_S_OK;
    }
    objthis?.addRef();
    let hr: number;
    try {
      hr = this.executor.run(
        {text, name: '', lineOffset: 0, mode: 'expression'},
        resultNeeded ? res : null,
        objthis,
      );
    } catch (e) {
      objthis?.release();
      res.clear();
      throw e;
    }
    if (hr === TJS_E_SUSPENDED)
      return this.#suspend(f, () => {
        objthis?.release();
        finish();
      });
    objthis?.release();
    finish();
    return TJS_S_OK;
  }

  /** `ThrowScriptException`: `script exception : <message>` and the value thrown. */
  #throw(f: Frame, value: Variant): never {
    let message = '';
    if (value.type === 1 && value.object) {
      const v = new VariantSlot();
      try {
        const o = value.object;
        const hr = this.suspender.nonSuspending(() =>
          o.propGet(0, 'message', v, value.objthis ?? o),
        );
        if (hr >= 0) message = `script exception : ${V.asString(v.value)}`;
      } catch {
        // as natively: the message is left out
      } finally {
        v.clear();
      }
    }
    addRefVariant(value);
    throw new TjsScriptException(message || 'script exception', this.#source(f), value);
  }
}

function checkCode(hr: number, name: string | null): void {
  if (hr < 0) throwFromCode(hr, name);
}

function binary(family: number, a: Variant, b: Variant): Variant {
  switch (family) {
    case 0:
      return V.logicalOr(a, b);
    case 1:
      return V.logicalAnd(a, b);
    case 2:
      return V.bitOr(a, b);
    case 3:
      return V.bitXor(a, b);
    case 4:
      return V.bitAnd(a, b);
    case 5:
      return V.shiftRight(a, b);
    case 6:
      return V.shiftLeft(a, b);
    case 7:
      return V.shiftRightUnsigned(a, b);
    case 8:
      return V.add(a, b);
    case 9:
      return V.sub(a, b);
    case 10:
      return V.mod(a, b);
    case 11:
      return V.div(a, b);
    case 12:
      return V.idiv(a, b);
    default:
      return V.mul(a, b);
  }
}
