import {
  contextTypeName,
  lineOfCodePosition,
  type CodeBlock,
  type ContextCode,
  type DataItem,
} from './code-block.js';
import {ArgType, Op, OP_NAMES, instructionSize} from './opcodes.js';
import {readableString, type Variant} from './runtime/variant.js';
import * as V from './runtime/variant.js';

/**
 * The VM code disassembler (krkrz `tjsDisassemble.cpp`): one line per instruction in the
 * native format, `%08d mnemonic operands`, with the data operand's value as a comment.
 */
export function disassembleContext(ctx: ContextCode, start = 0, end = ctx.code.length): string[] {
  const code = ctx.code;
  const lines: string[] = [];
  const r = (i: number) => `%${code[i]}`;
  const d = (i: number) => `*${code[i]}`;
  const comment = (i: number) => `*${code[i]} = ${dataComment(ctx.data[code[i]!])}`;
  for (let i = start; i < end;) {
    const op = code[i]!;
    const name = (OP_NAMES[op] ?? '').toLowerCase();
    let msg: string;
    let com = '';
    switch (op) {
      case Op.NOP:
      case Op.NF:
      case Op.RET:
      case Op.EXTRY:
      case Op.REGMEMBER:
      case Op.DEBUGGER:
        msg = name;
        break;
      case Op.CONST:
        msg = `const ${r(i + 1)}, ${d(i + 2)}`;
        com = comment(i + 2);
        break;
      case Op.CCL:
        msg = `ccl ${r(i + 1)}-%${code[i + 1]! + code[i + 2]! - 1}`;
        break;
      case Op.JF:
      case Op.JNF:
      case Op.JMP:
        msg = `${name} ${pad9(code[i + 1]! + i)}`;
        break;
      case Op.ENTRY:
        msg = `entry ${pad9(code[i + 1]! + i)}, ${r(i + 2)}`;
        break;
      case Op.CALL:
      case Op.CALLD:
      case Op.CALLI:
      case Op.NEW: {
        const head =
          op === Op.CALL
            ? `call ${r(i + 1)}, ${r(i + 2)}(`
            : op === Op.CALLD
              ? `calld ${r(i + 1)}, ${r(i + 2)}.${d(i + 3)}(`
              : op === Op.CALLI
                ? `calli ${r(i + 1)}, ${r(i + 2)}.${r(i + 3)}(`
                : `new ${r(i + 1)}, ${r(i + 2)}(`;
        let st = op === Op.CALLD || op === Op.CALLI ? 4 : 3;
        const num = code[i + st]!;
        const args: string[] = [];
        if (num === -1) args.push('...');
        else if (num === -2) {
          const count = code[i + st + 1]!;
          st += 2;
          for (let j = 0; j < count; j++) {
            const type = code[i + st + j * 2]!;
            const reg = code[i + st + j * 2 + 1]!;
            args.push(
              type === ArgType.Normal ? `%${reg}` : type === ArgType.Expand ? `%${reg}*` : '*',
            );
          }
        } else for (let j = 0; j < num; j++) args.push(`%${code[i + st + 1 + j]}`);
        msg = `${head}${args.join(', ')})`;
        if (op === Op.CALLD) com = comment(i + 3);
        break;
      }
      case Op.GPD:
      case Op.GPDS:
      case Op.DELD:
      case Op.TYPEOFD:
        msg = `${name} ${r(i + 1)}, ${r(i + 2)}.${d(i + 3)}`;
        com = comment(i + 3);
        break;
      case Op.SPD:
      case Op.SPDE:
      case Op.SPDEH:
      case Op.SPDS:
        msg = `${name} ${r(i + 1)}.${d(i + 2)}, ${r(i + 3)}`;
        com = comment(i + 2);
        break;
      case Op.GPI:
      case Op.GPIS:
      case Op.DELI:
      case Op.TYPEOFI:
        msg = `${name} ${r(i + 1)}, ${r(i + 2)}.${r(i + 3)}`;
        break;
      case Op.SPI:
      case Op.SPIE:
      case Op.SPIS:
        msg = `${name} ${r(i + 1)}.${r(i + 2)}, ${r(i + 3)}`;
        break;
      default:
        if (op >= Op.INC && op <= Op.MULP) {
          const base = op - ((op - Op.INC) % 4);
          const mnemonic = (OP_NAMES[base] ?? '').toLowerCase();
          const variant = (op - Op.INC) % 4;
          const twoOperands = base !== Op.INC && base !== Op.DEC;
          if (variant === 0)
            msg = twoOperands ? `${mnemonic} ${r(i + 1)}, ${r(i + 2)}` : `${mnemonic} ${r(i + 1)}`;
          else if (variant === 1) {
            msg = `${mnemonic}pd ${r(i + 1)}, ${r(i + 2)}.${d(i + 3)}`;
            if (twoOperands) msg += `, ${r(i + 4)}`;
            com = comment(i + 3);
          } else if (variant === 2) {
            msg = `${mnemonic}pi ${r(i + 1)}, ${r(i + 2)}.${r(i + 3)}`;
            if (twoOperands) msg += `, ${r(i + 4)}`;
          } else {
            msg = `${mnemonic}p ${r(i + 1)}, ${r(i + 2)}`;
            if (twoOperands) msg += `, ${r(i + 3)}`;
          }
        } else if (OP_NAMES[op] !== undefined) {
          // Instructions with one or two register operands.
          const size = instructionSize(code, i);
          msg = `${name} ${Array.from({length: size - 1}, (_, k) => r(i + 1 + k)).join(', ')}`;
        } else {
          msg = `unknown instruction ${op}`;
          lines.push(`${pad8(i)} ${msg}`);
          return lines;
        }
    }
    lines.push(com ? `${pad8(i)} ${msg}\t// ${com}` : `${pad8(i)} ${msg}`);
    i += instructionSize(code, i);
  }
  return lines;
}

/** Disassembles a whole block: a header per context, then its code with source lines. */
export function disassembleBlock(block: CodeBlock): string[] {
  const out: string[] = [];
  block.contexts.forEach((ctx, n) => {
    out.push('');
    out.push(`(${contextTypeName(ctx.type)}) ${ctx.name ?? ''} #${n}`);
    let prevLine = -1;
    const code = disassembleContext(ctx);
    for (const line of code) {
      const at = Number(line.slice(0, 8));
      const srcLine = lineOfCodePosition(ctx, at);
      if (srcLine !== prevLine) out.push(`#${block.name}(${srcLine})`);
      prevLine = srcLine;
      out.push(line);
    }
  });
  return out;
}

function pad8(n: number): string {
  return String(n).padStart(8, '0');
}

function pad9(n: number): string {
  return String(n).padStart(9, '0');
}

/** `GetValueComment` (`TJSVariantToReadableString`) of a data item. */
export function dataComment(d: DataItem | undefined): string {
  if (!d) return '(invalid)';
  const v = dataVariant(d);
  if (v) return readableString(v);
  if (d.kind === 'context') return `(object)(context #${d.index})`;
  return d.kind === 'array' ? '(object)(const Array)' : '(object)(const Dictionary)';
}

function dataVariant(d: DataItem): Variant | null {
  switch (d.kind) {
    case 'void':
      return V.VOID;
    case 'null':
      return V.NULL_OBJECT;
    case 'integer':
      return V.integer(d.value);
    case 'real':
      return V.real(d.value);
    case 'string':
      return V.str(d.value);
    case 'octet':
      return V.octet(d.value);
    default:
      return null;
  }
}
