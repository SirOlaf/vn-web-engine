import type {NifBuffer} from '../../../compiler/nif/buffer.js';
import {NifKind} from '../../../compiler/nif/buffer.js';
import {ContextType, type CodeBlock, type ContextCode, type DataItem} from './code-block.js';
import {L, TAG_OP} from './lowered.js';
import {ArgType, Op, OP_OPERANDS} from './opcodes.js';

const CONTEXT_TYPES: Readonly<Record<string, ContextType>> = {
  toplevel: ContextType.TopLevel,
  function: ContextType.Function,
  exprfunction: ContextType.ExprFunction,
  property: ContextType.Property,
  setter: ContextType.PropertySetter,
  getter: ContextType.PropertyGetter,
  class: ContextType.Class,
  supergetter: ContextType.SuperClassGetter,
};

/**
 * Code generation from the lowered stage (`lower.ts`): encodes each context's instructions as
 * VM code words, resolves labels to relative jump offsets, builds the data areas
 * (`PutData`, which reuses an equal entry among the last 20) and the line table, and removes
 * jumps to jumps as `FixCode` does.
 */
export function generateCode(
  lowered: NifBuffer,
  root: number,
  block: {name: string; lineOffset: number},
): CodeBlock {
  const buf = lowered;
  const contextNodes = buf.children(root);
  const index = new Map<string, number>();
  contextNodes.forEach((c, i) => index.set(buf.text(c + 1), i));
  const contexts = contextNodes.map((c) => encodeContext(buf, c, index));
  return {name: block.name, lineOffset: block.lineOffset, contexts, topLevel: 0};
}

function encodeContext(buf: NifBuffer, node: number, index: Map<string, number>): ContextCode {
  const [, nameAt, typeAt, parentAt, layoutAt, handlersAt, membersAt, supersAt, codeAt] =
    buf.children(node);
  const ref = (pos: number) => (buf.isDot(pos) ? -1 : index.get(buf.text(pos))!);
  const layout = buf.children(layoutAt!).map((p) => Number(buf.integer(p)));
  const [getterAt, setterAt, superAt] = buf.children(handlersAt!);
  const pool = buf.pool;
  const at: [number, number, number] = [0, 0, 0];

  // Pass 1: instruction positions and label positions.
  const labels = new Map<string, number>();
  const instructions: number[] = [];
  let size = 0;
  for (let c = codeAt! + 1, end = buf.end(codeAt!); c < end; c = buf.next(c)) {
    if (buf.isNode(c, L.label)) {
      labels.set(buf.text(c + 1), size);
      continue;
    }
    instructions.push(c);
    size += instructionWords(buf, c);
  }

  // Pass 2: encoding.
  const code = new Int32Array(size);
  const data = new DataArea();
  const jumps: number[] = [];
  const codePositions: number[] = [];
  const lines: number[] = [];
  let prevInfo = -1;
  let p = 0;
  for (const c of instructions) {
    const op = TAG_OP[buf.tag(c)]!;
    const start = p;
    const info = buf.info(c);
    if (info !== 0 && info !== prevInfo) {
      prevInfo = info;
      pool.unpack(info, at);
      if (lines.at(-1) !== at[1]) {
        codePositions.push(start);
        lines.push(at[1]);
      }
    }
    code[p++] = op;
    const kinds = OP_OPERANDS[op]!;
    let o = c + 1;
    for (const kind of kinds) {
      switch (kind) {
        case 'r':
        case 'n':
          code[p++] = Number(buf.integer(o));
          break;
        case 'd':
          code[p++] = data.put(readData(buf, o, index));
          break;
        case 'j': {
          const target = labels.get(buf.text(o));
          if (target === undefined)
            throw new Error(`TJS2 codegen: label ${buf.text(o)} not placed`);
          code[p++] = target - start;
          jumps.push(start);
          break;
        }
        case 'a':
          p = writeArgs(buf, o, code, p);
          break;
      }
      o = buf.next(o);
    }
  }
  threadJumps(code, jumps);

  return {
    name: buf.isDot(nameAt!) ? null : buf.text(nameAt!),
    type: CONTEXT_TYPES[buf.text(typeAt!)]!,
    parent: ref(parentAt!),
    maxVariableCount: layout[0]!,
    variableReserveCount: layout[1]!,
    maxFrameCount: layout[2]!,
    funcDeclArgCount: layout[3]!,
    funcDeclUnnamedArgArrayBase: layout[4]!,
    funcDeclCollapseBase: layout[5]!,
    propGetter: ref(getterAt!),
    propSetter: ref(setterAt!),
    superClassGetter: ref(superAt!),
    code,
    data: data.items,
    codePositions: Int32Array.from(codePositions),
    lines: Int32Array.from(lines),
    superClassGetterPointers: buf.children(supersAt!).map((s) => labels.get(buf.text(s))!),
    members: buf.children(membersAt!).map((m) => {
      const [name, ctx] = buf.children(m);
      return {name: buf.text(name!), context: index.get(buf.text(ctx!))!};
    }),
  };
}

function instructionWords(buf: NifBuffer, c: number): number {
  const op = TAG_OP[buf.tag(c)];
  if (op === undefined || op < 0)
    throw new Error(`TJS2 codegen: ${buf.tagName(c)} is not an instruction`);
  let size = 1;
  let o = c + 1;
  for (const kind of OP_OPERANDS[op]!) {
    if (kind === 'a') {
      if (buf.isNode(o, L.omit)) size += 1;
      else if (buf.isNode(o, L.xargs)) size += 2 + 2 * buf.childCount(o);
      else size += 1 + buf.childCount(o);
    } else size++;
    o = buf.next(o);
  }
  return size;
}

function writeArgs(buf: NifBuffer, o: number, code: Int32Array, p: number): number {
  if (buf.isNode(o, L.omit)) {
    code[p++] = -1;
    return p;
  }
  if (buf.isNode(o, L.xargs)) {
    code[p++] = -2;
    code[p++] = buf.childCount(o);
    for (const item of buf.children(o)) {
      const tag = buf.tag(item);
      code[p++] =
        tag === L.n ? ArgType.Normal : tag === L.x ? ArgType.Expand : ArgType.UnnamedExpand;
      code[p++] = tag === L.u ? 0 : Number(buf.integer(item + 1));
    }
    return p;
  }
  code[p++] = buf.childCount(o);
  for (const r of buf.children(o)) code[p++] = Number(buf.integer(r));
  return p;
}

/** Reads a constant operand of the lowered stage. */
export function readData(
  buf: NifBuffer,
  o: number,
  contexts: ReadonlyMap<string, number>,
): DataItem {
  switch (buf.kind(o)) {
    case NifKind.Int:
      return {kind: 'integer', value: buf.integer(o)};
    case NifKind.Float:
      return {kind: 'real', value: buf.float(o)};
    case NifKind.Str:
      return {kind: 'string', value: buf.text(o)};
  }
  switch (buf.tag(o)) {
    case L.void:
      return {kind: 'void'};
    case L.null:
      return {kind: 'null'};
    case L.nan:
      return {kind: 'real', value: NaN};
    case L.inf:
      return {kind: 'real', value: Infinity};
    case L.neginf:
      return {kind: 'real', value: -Infinity};
    case L.octet: {
      const hex = buf.text(o + 1);
      const bytes = new Uint8Array(hex.length >> 1);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return {kind: 'octet', value: bytes};
    }
    case L.ctx:
      return {kind: 'context', index: contexts.get(buf.text(o + 1))!};
    case L.array:
      return {kind: 'array', items: buf.children(o).map((c) => readData(buf, c, contexts))};
    case L.dict:
      return {
        kind: 'dictionary',
        items: buf.children(o).map((kv) => {
          const [k, v] = buf.children(kv);
          return [buf.text(k!), readData(buf, v!, contexts)] as const;
        }),
      };
  }
  throw new Error(`TJS2 codegen: ${buf.tagName(o)} is not a constant`);
}

/** `PutData`: an equal entry among the last 20 is reused (`DiscernCompareStrictReal`). */
class DataArea {
  readonly items: DataItem[] = [];

  put(d: DataItem): number {
    const items = this.items;
    for (let i = items.length - 1, n = 0; i >= 0 && n < 20; i--, n++)
      if (sameData(items[i]!, d)) return i;
    items.push(d);
    return items.length - 1;
  }
}

function sameData(a: DataItem, b: DataItem): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'void':
    case 'null':
      return true;
    case 'integer':
      return a.value === (b as typeof a).value;
    case 'real':
      return Object.is(a.value, (b as typeof a).value) || sameBits(a.value, (b as typeof a).value);
    case 'string':
      return a.value === (b as typeof a).value;
    case 'octet': {
      const o = (b as typeof a).value;
      return a.value.length === o.length && a.value.every((x, i) => x === o[i]);
    }
    case 'context':
      return a.index === (b as typeof a).index;
    default:
      return false;
  }
}

function sameBits(x: number, y: number): boolean {
  const v = new DataView(new ArrayBuffer(16));
  v.setFloat64(0, x);
  v.setFloat64(8, y);
  return v.getBigUint64(0) === v.getBigUint64(8);
}

/** The redundant-jump elimination of `FixCode`: jumps to jumps go to the final target. */
function threadJumps(code: Int32Array, jumps: readonly number[]): void {
  for (const j of jumps) {
    const jumpCode = code[j]!;
    let target = code[j + 1]! + j;
    let addr = target;
    for (let guard = 0; guard < code.length; guard++) {
      const c = code[addr];
      if (c === Op.JMP || (c === jumpCode && (jumpCode === Op.JF || jumpCode === Op.JNF))) {
        target = code[addr + 1]! + addr;
        if (code[addr + 1] !== 0) addr = target;
        else break;
      } else if ((c === Op.JF && jumpCode === Op.JNF) || (c === Op.JNF && jumpCode === Op.JF)) {
        target = addr + 2;
        addr += 2;
      } else break;
    }
    code[j + 1] = target - j;
  }
}
