/**
 * The TJS2 VM instruction set (`tTJSVMCodes`, krkrz `tjsInterCodeGen.h`). Numbers are the
 * native ones, which TJS2 bytecode (`TJS2100`) also uses, so code generated here and code
 * read from bytecode run on the same VM.
 *
 * Code is a sequence of 32-bit words: an opcode followed by its operands. Operands are
 * register numbers (relative to the frame's register base: negative for `this`, the
 * this-proxy, arguments and locals, 0 for the void register, positive for temporaries), data
 * indices, word offsets of jumps relative to the jump instruction, or counts. The native VM
 * holds byte addresses instead (`TJS_TO_VM_REG_ADDR`); bytecode holds the same indices as
 * here.
 */
export const Op = {
  NOP: 0,
  CONST: 1,
  CP: 2,
  CL: 3,
  CCL: 4,
  TT: 5,
  TF: 6,
  CEQ: 7,
  CDEQ: 8,
  CLT: 9,
  CGT: 10,
  SETF: 11,
  SETNF: 12,
  LNOT: 13,
  NF: 14,
  JF: 15,
  JNF: 16,
  JMP: 17,
  INC: 18,
  INCPD: 19,
  INCPI: 20,
  INCP: 21,
  DEC: 22,
  DECPD: 23,
  DECPI: 24,
  DECP: 25,
  LOR: 26,
  LORPD: 27,
  LORPI: 28,
  LORP: 29,
  LAND: 30,
  LANDPD: 31,
  LANDPI: 32,
  LANDP: 33,
  BOR: 34,
  BORPD: 35,
  BORPI: 36,
  BORP: 37,
  BXOR: 38,
  BXORPD: 39,
  BXORPI: 40,
  BXORP: 41,
  BAND: 42,
  BANDPD: 43,
  BANDPI: 44,
  BANDP: 45,
  SAR: 46,
  SARPD: 47,
  SARPI: 48,
  SARP: 49,
  SAL: 50,
  SALPD: 51,
  SALPI: 52,
  SALP: 53,
  SR: 54,
  SRPD: 55,
  SRPI: 56,
  SRP: 57,
  ADD: 58,
  ADDPD: 59,
  ADDPI: 60,
  ADDP: 61,
  SUB: 62,
  SUBPD: 63,
  SUBPI: 64,
  SUBP: 65,
  MOD: 66,
  MODPD: 67,
  MODPI: 68,
  MODP: 69,
  DIV: 70,
  DIVPD: 71,
  DIVPI: 72,
  DIVP: 73,
  IDIV: 74,
  IDIVPD: 75,
  IDIVPI: 76,
  IDIVP: 77,
  MUL: 78,
  MULPD: 79,
  MULPI: 80,
  MULP: 81,
  BNOT: 82,
  TYPEOF: 83,
  TYPEOFD: 84,
  TYPEOFI: 85,
  EVAL: 86,
  EEXP: 87,
  CHKINS: 88,
  ASC: 89,
  CHR: 90,
  NUM: 91,
  CHS: 92,
  INV: 93,
  CHKINV: 94,
  INT: 95,
  REAL: 96,
  STR: 97,
  OCTET: 98,
  CALL: 99,
  CALLD: 100,
  CALLI: 101,
  NEW: 102,
  GPD: 103,
  SPD: 104,
  SPDE: 105,
  SPDEH: 106,
  GPI: 107,
  SPI: 108,
  SPIE: 109,
  GPDS: 110,
  SPDS: 111,
  GPIS: 112,
  SPIS: 113,
  SETP: 114,
  GETP: 115,
  DELD: 116,
  DELI: 117,
  SRV: 118,
  RET: 119,
  ENTRY: 120,
  EXTRY: 121,
  THROW: 122,
  CHGTHIS: 123,
  GLOBAL: 124,
  ADDCI: 125,
  REGMEMBER: 126,
  DEBUGGER: 127,
} as const;
export type Op = (typeof Op)[keyof typeof Op];

/** One past the last opcode (`__VM_LAST`). */
export const OP_COUNT = 128;

export const OP_NAMES: readonly string[] = (() => {
  const names: string[] = [];
  for (const [name, op] of Object.entries(Op)) names[op] = name;
  return names;
})();

/** Opcode by name; undefined for unknown names. */
export function opcodeByName(name: string): Op | undefined {
  return (Op as Record<string, Op>)[name];
}

/**
 * Operand kinds: `r` register, `d` data index, `j` jump offset, `n` count, `a` call
 * arguments (a count followed by registers, `-1` for `...`, or `-2`, a count and
 * `(kind, register)` pairs).
 */
export type OperandKind = 'r' | 'd' | 'j' | 'n' | 'a';

/** The operands of each opcode, in code order. */
export const OP_OPERANDS: readonly (readonly OperandKind[])[] = (() => {
  const t: OperandKind[][] = [];
  const set = (ops: readonly number[], kinds: OperandKind[]) => {
    for (const op of ops) t[op] = kinds;
  };
  set([Op.NOP, Op.NF, Op.RET, Op.EXTRY, Op.REGMEMBER, Op.DEBUGGER], []);
  set([Op.CONST], ['r', 'd']);
  set([Op.CP, Op.CEQ, Op.CDEQ, Op.CLT, Op.CGT, Op.CHKINS, Op.CHGTHIS, Op.ADDCI], ['r', 'r']);
  set(
    [
      Op.CL,
      Op.TT,
      Op.TF,
      Op.SETF,
      Op.SETNF,
      Op.LNOT,
      Op.INC,
      Op.DEC,
      Op.BNOT,
      Op.TYPEOF,
      Op.EVAL,
      Op.EEXP,
      Op.ASC,
      Op.CHR,
      Op.NUM,
      Op.CHS,
      Op.INV,
      Op.CHKINV,
      Op.INT,
      Op.REAL,
      Op.STR,
      Op.OCTET,
      Op.SRV,
      Op.THROW,
      Op.GLOBAL,
    ],
    ['r'],
  );
  set([Op.CCL], ['r', 'n']);
  set([Op.JF, Op.JNF, Op.JMP], ['j']);
  set([Op.ENTRY], ['j', 'r']);
  set([Op.INCPD, Op.DECPD], ['r', 'r', 'd']);
  set([Op.INCPI, Op.DECPI], ['r', 'r', 'r']);
  set([Op.INCP, Op.DECP], ['r', 'r']);
  for (let op: number = Op.LOR; op <= Op.MULP; op += 4) {
    t[op] = ['r', 'r'];
    t[op + 1] = ['r', 'r', 'd', 'r'];
    t[op + 2] = ['r', 'r', 'r', 'r'];
    t[op + 3] = ['r', 'r', 'r'];
  }
  set([Op.TYPEOFD, Op.GPD, Op.GPDS, Op.DELD], ['r', 'r', 'd']);
  set([Op.TYPEOFI, Op.GPI, Op.GPIS, Op.DELI, Op.SPI, Op.SPIE, Op.SPIS], ['r', 'r', 'r']);
  set([Op.SPD, Op.SPDE, Op.SPDEH, Op.SPDS], ['r', 'd', 'r']);
  set([Op.GETP, Op.SETP], ['r', 'r']);
  set([Op.CALL, Op.NEW], ['r', 'r', 'a']);
  set([Op.CALLD], ['r', 'r', 'd', 'a']);
  set([Op.CALLI], ['r', 'r', 'r', 'a']);
  return t;
})();

/** Kinds of an expanded argument list item (`tTJSFuncArgType`). */
export const ArgType = {Normal: 0, Expand: 1, UnnamedExpand: 2} as const;

/** Number of words of the argument operand starting at `code[at]`. */
export function argsSize(code: ArrayLike<number>, at: number): number {
  const n = code[at]!;
  if (n === -1) return 1;
  if (n === -2) return 2 + code[at + 1]! * 2;
  return 1 + n;
}

/** Size in words of the instruction at `code[at]`; throws for an invalid opcode. */
export function instructionSize(code: ArrayLike<number>, at: number): number {
  const kinds = OP_OPERANDS[code[at]!];
  if (!kinds) throw new RangeError(`Invalid TJS2 VM opcode ${code[at]} at ${at}`);
  let size = 1;
  for (const k of kinds) size += k === 'a' ? argsSize(code, at + size) : 1;
  return size;
}

/**
 * Calls `visit(position, kind)` for every operand of the instruction at `at` (and of each
 * register inside an argument list, with kind `r`). Returns the instruction size.
 */
export function forEachOperand(
  code: ArrayLike<number>,
  at: number,
  visit: (position: number, kind: OperandKind) => void,
): number {
  const kinds = OP_OPERANDS[code[at]!];
  if (!kinds) throw new RangeError(`Invalid TJS2 VM opcode ${code[at]} at ${at}`);
  let p = at + 1;
  for (const k of kinds) {
    if (k !== 'a') {
      visit(p++, k);
      continue;
    }
    const n = code[p]!;
    if (n === -1) p++;
    else if (n === -2) {
      const count = code[p + 1]!;
      p += 2;
      for (let i = 0; i < count; i++, p += 2) visit(p + 1, 'r');
    } else {
      p++;
      for (let i = 0; i < n; i++) visit(p++, 'r');
    }
  }
  return p - at;
}
