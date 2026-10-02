import {BinaryReader, ByteView} from '../../core/binary.js';

/**
 * Compiled codeX RScript program (`.gsc`, loaded by 0x41ADA0). A nine-dword header
 * gives the section sizes; sections follow in header order. String, array and label
 * indexes are 32-bit entries into their data sections. Label index 0 is a placeholder.
 */
export interface GscProgram {
  readonly code: Uint8Array;
  readonly strings: readonly Uint8Array[];
  /** Word arrays copied into script variables (0x41ABE0); index 0 is unused. */
  readonly arrays: readonly Int16Array[];
  readonly labels: readonly GscLabel[];
}

export interface GscLabel {
  readonly name: Uint8Array;
  readonly offset: number;
}

const HEADER_SIZE = 36;

function cString(data: ByteView, offset: number, what: string): Uint8Array {
  if (offset >= data.end) throw new Error(`GSC ${what} offset out of range`);
  try {
    return data.cString(offset);
  } catch {
    throw new Error(`Unterminated GSC ${what}`);
  }
}

export function parseGsc(bytes: Uint8Array): GscProgram {
  if (bytes.length < HEADER_SIZE) throw new Error('Truncated GSC program');
  const r = new BinaryReader(bytes, true);
  const fileSize = r.u32(),
    headerSize = r.u32(),
    codeSize = r.u32(),
    stringIndexSize = r.u32(),
    stringSize = r.u32(),
    arrayIndexSize = r.u32(),
    arrayWords = r.u32(),
    labelIndexSize = r.u32(),
    labelSize = r.u32();
  if (headerSize !== HEADER_SIZE || fileSize !== bytes.length)
    throw new Error('Invalid GSC header');
  if (stringIndexSize % 4 || arrayIndexSize % 4 || labelIndexSize % 4)
    throw new Error('Misaligned GSC index');
  const section = (size: number): ByteView => r.data.sub(r.take(size), size);
  const code = section(codeSize).bytes;
  const stringIndex = section(stringIndexSize);
  const stringData = section(stringSize);
  const arrayIndex = section(arrayIndexSize);
  const arrayData = section(arrayWords * 2);
  const labelNames = section(labelIndexSize);
  const labelOffsets = section(labelIndexSize);
  const labelData = section(labelSize);
  if (r.position !== bytes.length) throw new Error('GSC section sizes do not match the file');

  const strings = Array.from({length: stringIndexSize / 4}, (_, i) =>
    cString(stringData, stringIndex.u32(i * 4), 'string'),
  );
  const arrays = Array.from({length: arrayIndexSize / 4}, (_, i) => {
    const start = arrayIndex.u32(i * 4);
    if (start >= arrayWords) return new Int16Array();
    const length = arrayData.i16(start * 2);
    if (length < 0 || start + 1 + length > arrayWords) throw new Error('Invalid GSC array');
    return Int16Array.from({length}, (_, j) => arrayData.i16((start + 1 + j) * 2));
  });
  const labels = Array.from({length: labelIndexSize / 4}, (_, i): GscLabel => {
    const offset = labelOffsets.u32(i * 4);
    return {
      name: i ? cString(labelData, labelNames.u32(i * 4), 'label') : new Uint8Array(),
      offset,
    };
  });
  return {code, strings, arrays, labels};
}

/** Operand encodings used by the per-version opcode tables. */
export type GscOperandKind =
  | 'u16'
  | 'i16'
  | 'u32'
  /** 32-bit value: low signed word plus high-word indirection count through variables. */
  | 'value'
  /** Index into the string table. */
  | 'string'
  /** Index into the string table naming a label; 0 selects the program start. */
  | 'label'
  /** Absolute code offset. */
  | 'target'
  /** Index into the word-array table. */
  | 'array';

export type GscOpcodeLayouts = ReadonlyMap<number, readonly GscOperandKind[]>;

export interface GscInstruction {
  readonly offset: number;
  readonly opcode: number;
  /** Raw operand values in encoding order (values keep their 32-bit encoding). */
  readonly operands: readonly number[];
  readonly next: number;
}

const OPERAND_SIZE: Record<GscOperandKind, number> = {
  u16: 2,
  i16: 2,
  u32: 4,
  value: 4,
  string: 4,
  label: 4,
  target: 4,
  array: 4,
};

/** True for the arithmetic/comparison family whose operand modes live in the opcode. */
export function isGscExpression(opcode: number): boolean {
  return (opcode & 0xf000) !== 0;
}

/**
 * Decodes one instruction. Expression opcodes (high nibble set) carry a destination
 * register and one or two 16-bit operands: `0xF000` is a unary load, the rest are
 * binary operators (0x422FD0).
 */
export function decodeGscInstruction(
  code: Uint8Array,
  offset: number,
  layouts: GscOpcodeLayouts,
): GscInstruction {
  const view = new ByteView(code, {littleEndian: true});
  const opcode = view.u16(offset);
  let cursor = offset + 2;
  const operands: number[] = [];
  const take = (kind: GscOperandKind): void => {
    operands.push(
      kind === 'i16'
        ? view.i16(cursor)
        : OPERAND_SIZE[kind] === 2
          ? view.u16(cursor)
          : view.u32(cursor),
    );
    cursor += OPERAND_SIZE[kind];
  };
  if (isGscExpression(opcode)) {
    take('u16');
    take('i16');
    if ((opcode & 0xf000) !== 0xf000) take('i16');
  } else {
    const layout = layouts.get(opcode);
    if (!layout)
      throw new Error(`Unknown GSC opcode 0x${opcode.toString(16)} at 0x${offset.toString(16)}`);
    for (const kind of layout) take(kind);
  }
  return {offset, opcode, operands, next: cursor};
}
