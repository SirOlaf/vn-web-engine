/** Shader Model4 token decoding. Numeric fields follow Microsoft's token-format header. */
export const Sm4Opcode = {
  ADD: 0,
  DISCARD: 13,
  DIV: 14,
  DP3: 16,
  DP4: 17,
  EXP: 25,
  GE: 29,
  LOG: 47,
  LT: 49,
  MAD: 50,
  MIN: 51,
  MAX: 52,
  CUSTOMDATA: 53,
  MOV: 54,
  MOVC: 55,
  MUL: 56,
  RET: 62,
  ROUND_NI: 65,
  RSQ: 68,
  SAMPLE: 69,
  DCL_RESOURCE: 88,
  DCL_CONSTANT_BUFFER: 89,
  DCL_SAMPLER: 90,
  DCL_INPUT: 95,
  DCL_INPUT_PS: 98,
  DCL_INPUT_PS_SIV: 100,
  DCL_OUTPUT: 101,
  DCL_OUTPUT_SIV: 103,
  DCL_TEMPS: 104,
} as const;

export interface Sm4Index {
  /** Immediate index DWORDs in native order;64-bit indices never pass through a JS number. */
  readonly immediate: readonly number[];
  readonly relative: Sm4Operand | null;
}
export interface Sm4Operand {
  readonly token: number;
  readonly type: number;
  readonly componentCount: 0 | 1 | 4;
  readonly selectionMode: 'none' | 'mask' | 'swizzle' | 'select';
  /** Selected component numbers. Mask order is x,y,z,w; swizzle order is retained. */
  readonly components: readonly number[];
  readonly extended: readonly number[];
  readonly indices: readonly Sm4Index[];
  /** Raw immediate32/64 DWORDs, preserving NaNs, signed zero and integer bit patterns. */
  readonly immediate: readonly number[];
}
export interface Sm4Instruction {
  /** DWORD offset from the program version token. */
  readonly offset: number;
  readonly token: number;
  readonly opcode: number;
  readonly controls: number;
  readonly extended: readonly number[];
  readonly operands: readonly Sm4Operand[];
  /** Declaration-specific DWORDs, or the opaque contents of a custom-data block. */
  readonly data: readonly number[];
  readonly customClass: number | null;
}
export interface Sm4Program {
  readonly stage: 'vertex' | 'pixel';
  readonly instructions: readonly Sm4Instruction[];
}

/** Number of operands and trailing declaration words in the supported opcode subset. */
const shapes: ReadonlyMap<number, readonly [number, number]> = new Map([
  [0, [3, 0]],
  [13, [1, 0]],
  [14, [3, 0]],
  [16, [3, 0]],
  [17, [3, 0]],
  [25, [2, 0]],
  [29, [3, 0]],
  [47, [2, 0]],
  [49, [3, 0]],
  [50, [4, 0]],
  [51, [3, 0]],
  [52, [3, 0]],
  [54, [2, 0]],
  [55, [4, 0]],
  [56, [3, 0]],
  [62, [0, 0]],
  [65, [2, 0]],
  [68, [2, 0]],
  [69, [4, 0]],
  [88, [1, 1]],
  [89, [1, 0]],
  [90, [1, 0]],
  [95, [1, 0]],
  [98, [1, 0]],
  [100, [1, 1]],
  [101, [1, 0]],
  [103, [1, 1]],
  [104, [0, 1]],
]);

class Tokens {
  position = 0;
  limit: number;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.limit = bytes.length / 4;
  }
  read(): number {
    if (this.position >= this.limit) throw new Error('Truncated SM4 instruction');
    return this.view.getUint32(this.position++ * 4, true);
  }
  extensions(token: number): number[] {
    const words: number[] = [];
    while (token & 0x80000000) {
      token = this.read();
      words.push(token);
    }
    return words;
  }
  operand(depth = 0): Sm4Operand {
    if (depth >= 16) throw new Error('SM4 operand nesting exceeds allocation limit');
    const token = this.read(),
      count = token & 3;
    if (count === 3) throw new Error('Unsupported SM4 N-component operand');
    const componentCount = count === 2 ? 4 : count === 1 ? 1 : 0;
    const mode = (token >>> 2) & 3;
    if (componentCount === 4 && mode === 3) throw new Error('Invalid SM4 component selection');
    const selectionMode =
      componentCount !== 4 ? 'none' : mode === 0 ? 'mask' : mode === 1 ? 'swizzle' : 'select';
    const components =
      componentCount === 0
        ? []
        : componentCount === 1
          ? [0]
          : mode === 0
            ? [0, 1, 2, 3].filter((n) => (token & (1 << (n + 4))) !== 0)
            : mode === 1
              ? [0, 1, 2, 3].map((n) => (token >>> (4 + n * 2)) & 3)
              : [(token >>> 4) & 3];
    const type = (token >>> 12) & 255,
      extended = this.extensions(token);
    const dimensions = (token >>> 20) & 3,
      indices: Sm4Index[] = [];
    for (let i = 0; i < dimensions; i++) {
      const representation = (token >>> (22 + i * 3)) & 7;
      if (representation > 4) throw new Error('Invalid SM4 index representation');
      const immediate: number[] = [];
      if (representation !== 2) immediate.push(this.read());
      if (representation === 1 || representation === 4) immediate.push(this.read());
      const relative = representation >= 2 ? this.operand(depth + 1) : null;
      indices.push({immediate, relative});
    }
    const immediate: number[] = [];
    if (type === 4 || type === 5) {
      if (dimensions !== 0 || componentCount === 0)
        throw new Error('Invalid SM4 immediate operand');
      for (let i = 0; i < componentCount * (type === 5 ? 2 : 1); i++) immediate.push(this.read());
    }
    return {token, type, componentCount, selectionMode, components, extended, indices, immediate};
  }
}

/**
 * Decode a complete SHDR payload, not a DXBC envelope. Covers the arithmetic, sample
 * and declaration subset above. This checks syntax/lengths, not shader validity,
 * declaration consistency or instruction semantics. Unknown opcodes fail explicitly.
 */
export function parseSm4Program(bytes: Uint8Array): Sm4Program {
  if (bytes.length < 8 || bytes.length % 4 !== 0 || bytes.length > 4 * 1024 * 1024)
    throw new Error('Invalid or oversized SM4 program');
  const tokens = new Tokens(bytes),
    version = tokens.read(),
    length = tokens.read();
  const stage = version >>> 16;
  if ((version & 0xffff) !== 0x40 || stage > 1)
    throw new Error('Unsupported SM4 program version or stage');
  if (length !== bytes.length / 4) throw new Error('Invalid SM4 program length');
  const instructions: Sm4Instruction[] = [];
  while (tokens.position < length) {
    if (instructions.length >= 65536)
      throw new Error('SM4 instruction count exceeds allocation limit');
    const offset = tokens.position,
      token = tokens.read(),
      opcode = token & 0x7ff;
    const customClass = opcode === Sm4Opcode.CUSTOMDATA ? token >>> 11 : null;
    const size = customClass !== null ? tokens.read() : (token >>> 24) & 127;
    const end = offset + size;
    if (size < (customClass !== null ? 2 : 1) || end > length)
      throw new Error('Invalid SM4 instruction length');
    tokens.limit = end;
    const extended = customClass !== null ? [] : tokens.extensions(token);
    const operands: Sm4Operand[] = [],
      data: number[] = [];
    if (customClass !== null) {
      while (tokens.position < end) data.push(tokens.read());
    } else {
      const shape = shapes.get(opcode);
      if (!shape) throw new Error(`Unsupported SM4 opcode ${opcode}`);
      for (let i = 0; i < shape[0]; i++) operands.push(tokens.operand());
      for (let i = 0; i < shape[1]; i++) data.push(tokens.read());
    }
    if (tokens.position !== end) throw new Error('Unexpected SM4 instruction operands');
    instructions.push({
      offset,
      token,
      opcode,
      controls: (token >>> 11) & 0x1fff,
      extended,
      operands,
      data,
      customClass,
    });
    tokens.limit = length;
  }
  return {stage: stage === 0 ? 'pixel' : 'vertex', instructions};
}
