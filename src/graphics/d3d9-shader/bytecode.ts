import {parseConstantTable, type D3D9ConstantTable} from './ctab.js';

/** Direct3D 9 shader model 2.0, 2.x and 3.0 token-stream reader (D3DSIO_* / D3DSPR_*). */

export type D3D9ShaderStage = 'vertex' | 'pixel';

export interface D3D9ShaderVersion {
  stage: D3D9ShaderStage;
  major: number;
  /** 0 for x_2_0 and x_3_0, 1 for vs_2_x / ps_2_x, 0xff for software profiles. */
  minor: number;
}

export const Opcode = {
  NOP: 0,
  MOV: 1,
  ADD: 2,
  SUB: 3,
  MAD: 4,
  MUL: 5,
  RCP: 6,
  RSQ: 7,
  DP3: 8,
  DP4: 9,
  MIN: 10,
  MAX: 11,
  SLT: 12,
  SGE: 13,
  EXP: 14,
  LOG: 15,
  LIT: 16,
  DST: 17,
  LRP: 18,
  FRC: 19,
  M4x4: 20,
  M4x3: 21,
  M3x4: 22,
  M3x3: 23,
  M3x2: 24,
  CALL: 25,
  CALLNZ: 26,
  LOOP: 27,
  RET: 28,
  ENDLOOP: 29,
  LABEL: 30,
  DCL: 31,
  POW: 32,
  CRS: 33,
  SGN: 34,
  ABS: 35,
  NRM: 36,
  SINCOS: 37,
  REP: 38,
  ENDREP: 39,
  IF: 40,
  IFC: 41,
  ELSE: 42,
  ENDIF: 43,
  BREAK: 44,
  BREAKC: 45,
  MOVA: 46,
  DEFB: 47,
  DEFI: 48,
  TEXCOORD: 64,
  TEXKILL: 65,
  TEX: 66,
  TEXBEM: 67,
  TEXBEML: 68,
  TEXREG2AR: 69,
  TEXREG2GB: 70,
  TEXM3x2PAD: 71,
  TEXM3x2TEX: 72,
  TEXM3x3PAD: 73,
  TEXM3x3TEX: 74,
  TEXM3x3SPEC: 76,
  TEXM3x3VSPEC: 77,
  EXPP: 78,
  LOGP: 79,
  CND: 80,
  DEF: 81,
  TEXREG2RGB: 82,
  TEXDP3TEX: 83,
  TEXM3x2DEPTH: 84,
  TEXDP3: 85,
  TEXM3x3: 86,
  TEXDEPTH: 87,
  CMP: 88,
  BEM: 89,
  DP2ADD: 90,
  DSX: 91,
  DSY: 92,
  TEXLDD: 93,
  SETP: 94,
  TEXLDL: 95,
  BREAKP: 96,
  PHASE: 0xfffd,
  COMMENT: 0xfffe,
  END: 0xffff,
} as const;

const opcodeNames = new Map<number, string>(
  Object.entries(Opcode).map(([name, value]) => [value, name.toLowerCase()]),
);
opcodeNames.set(Opcode.TEX, 'texld');

/** Base mnemonic without comparison or texld-variant suffixes. */
export function opcodeName(opcode: number): string {
  return opcodeNames.get(opcode) ?? `op${opcode}`;
}

/** Opcodes that carry a destination parameter token. Others have only sources. */
const noDestination = new Set<number>([
  Opcode.NOP,
  Opcode.CALL,
  Opcode.CALLNZ,
  Opcode.LOOP,
  Opcode.RET,
  Opcode.ENDLOOP,
  Opcode.LABEL,
  Opcode.REP,
  Opcode.ENDREP,
  Opcode.IF,
  Opcode.IFC,
  Opcode.ELSE,
  Opcode.ENDIF,
  Opcode.BREAK,
  Opcode.BREAKC,
  Opcode.BREAKP,
  Opcode.PHASE,
]);

export const RegisterType = {
  TEMP: 0,
  INPUT: 1,
  CONST: 2,
  /** a0 in vertex shaders, t# in pixel shaders. */
  ADDR_TEXTURE: 3,
  RASTOUT: 4,
  ATTROUT: 5,
  /** oT# below vs_3_0, o# in vs_3_0. */
  TEXCRDOUT_OUTPUT: 6,
  CONSTINT: 7,
  COLOROUT: 8,
  DEPTHOUT: 9,
  SAMPLER: 10,
  CONST2: 11,
  CONST3: 12,
  CONST4: 13,
  CONSTBOOL: 14,
  LOOP: 15,
  TEMPFLOAT16: 16,
  MISCTYPE: 17,
  LABEL: 18,
  PREDICATE: 19,
} as const;

export const RasterOutput = {POSITION: 0, FOG: 1, POINT_SIZE: 2} as const;
export const MiscRegister = {POSITION: 0, FACE: 1} as const;

/** D3DDECLUSAGE. */
export const DeclUsage = {
  POSITION: 0,
  BLENDWEIGHT: 1,
  BLENDINDICES: 2,
  NORMAL: 3,
  PSIZE: 4,
  TEXCOORD: 5,
  TANGENT: 6,
  BINORMAL: 7,
  TESSFACTOR: 8,
  POSITIONT: 9,
  COLOR: 10,
  FOG: 11,
  DEPTH: 12,
  SAMPLE: 13,
} as const;

export const declUsageNames = [
  'position',
  'blendweight',
  'blendindices',
  'normal',
  'psize',
  'texcoord',
  'tangent',
  'binormal',
  'tessfactor',
  'positiont',
  'color',
  'fog',
  'depth',
  'sample',
];

/** D3DSAMPLER_TEXTURE_TYPE >> 27. */
export const SamplerType = {UNKNOWN: 0, TEX_2D: 2, CUBE: 3, VOLUME: 4} as const;

/** D3DSPSM_*. */
export const SourceModifier = {
  NONE: 0,
  NEG: 1,
  BIAS: 2,
  BIASNEG: 3,
  SIGN: 4,
  SIGNNEG: 5,
  COMP: 6,
  X2: 7,
  X2NEG: 8,
  DZ: 9,
  DW: 10,
  ABS: 11,
  ABSNEG: 12,
  NOT: 13,
} as const;

/** D3DSPC_* comparison stored in instruction-token bits 16..18 of ifc, breakc and setp. */
export const Comparison = {GT: 1, EQ: 2, GE: 3, LT: 4, NE: 5, LE: 6} as const;
export const comparisonNames = ['', 'gt', 'eq', 'ge', 'lt', 'ne', 'le', ''];

/** texld control bits 16..17. */
export const TexldControl = {NONE: 0, PROJECT: 1, BIAS: 2} as const;

export const ResultModifier = {SATURATE: 1, PARTIAL_PRECISION: 2, CENTROID: 4} as const;

export interface D3D9RelativeAddress {
  /** ADDR_TEXTURE (a0) or LOOP (aL). */
  type: number;
  index: number;
  /** Selected component 0..3. */
  component: number;
}

export interface D3D9DestinationParameter {
  type: number;
  index: number;
  /** Bit 0 = x .. bit 3 = w. */
  writeMask: number;
  /** ResultModifier bit set. */
  modifiers: number;
  /** Signed shift scale (ps_1_x only; must be 0 here). */
  shift: number;
  relative?: D3D9RelativeAddress;
}

export interface D3D9SourceParameter {
  type: number;
  index: number;
  /** Four 2-bit component selectors, x in bits 0..1. */
  swizzle: number;
  modifier: number;
  relative?: D3D9RelativeAddress;
}

export interface D3D9Declaration {
  usage: number;
  usageIndex: number;
  /** SamplerType for sampler declarations. */
  samplerType: number;
}

export interface D3D9Instruction {
  /** Token offset of the instruction token within the stream. */
  offset: number;
  opcode: number;
  /** Opcode-specific control bits 16..23 (comparison, texld variant). */
  control: number;
  coissue: boolean;
  destination?: D3D9DestinationParameter;
  /** Predicate source when the instruction is predicated. */
  predicate?: D3D9SourceParameter;
  sources: D3D9SourceParameter[];
  declaration?: D3D9Declaration;
  /** def: four float32 values; defi: four int32 values; defb: one boolean. */
  floatValues?: [number, number, number, number];
  intValues?: [number, number, number, number];
  boolValue?: boolean;
}

export interface D3D9Comment {
  /** Token offset of the comment token. */
  offset: number;
  /** FourCC from the first DWORD when printable, e.g. CTAB, DBUG, PRES. */
  fourCC: string;
  bytes: Uint8Array;
}

export interface D3D9Shader {
  version: D3D9ShaderVersion;
  instructions: D3D9Instruction[];
  comments: D3D9Comment[];
  constantTable?: D3D9ConstantTable;
  /** Byte length including the end token. */
  byteLength: number;
}

/** .xyzw */
export const DEFAULT_SWIZZLE = 0xe4;

export function parseVersionToken(token: number): D3D9ShaderVersion | undefined {
  const kind = token >>> 16,
    major = (token >>> 8) & 0xff,
    minor = token & 0xff;
  if (kind !== 0xfffe && kind !== 0xffff) return undefined;
  return {stage: kind === 0xfffe ? 'vertex' : 'pixel', major, minor};
}

export function versionName(version: D3D9ShaderVersion): string {
  const minor = version.minor === 1 ? 'x' : version.minor === 0xff ? 'sw' : String(version.minor);
  return `${version.stage === 'vertex' ? 'vs' : 'ps'}_${version.major}_${minor}`;
}

/** Register type from bits 28..30 and 11..12. */
export function registerType(token: number): number {
  return ((token >>> 28) & 7) | ((token >>> 8) & 0x18);
}

function relativeSupported(version: D3D9ShaderVersion): boolean {
  return version.stage === 'vertex' ? version.major >= 2 : version.major >= 3;
}

/** Parse a complete shader. `bytes` must start at the version token; trailing bytes after
 * the end token are ignored. Rejects shader model 1.x, malformed lengths and unknown opcodes. */
export function parseD3D9Shader(bytes: Uint8Array): D3D9Shader {
  if (bytes.byteLength < 8 || bytes.byteLength % 4)
    throw new Error('D3D9 shader length must be a nonzero multiple of 4');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    count = bytes.byteLength >>> 2,
    token = (i: number): number => {
      if (i >= count) throw new Error('Truncated D3D9 shader token stream');
      return view.getUint32(i * 4, true);
    };
  const version = parseVersionToken(token(0));
  if (!version) throw new Error('Invalid D3D9 shader version token');
  if (version.major < 2 || version.major > 3 || (version.major === 3 && version.minor !== 0))
    throw new Error(`Unsupported D3D9 shader version ${versionName(version)}`);
  const instructions: D3D9Instruction[] = [],
    comments: D3D9Comment[] = [];
  let constantTable: D3D9ConstantTable | undefined;
  let position = 1;
  for (;;) {
    const at = position,
      head = token(position++);
    const opcode = head & 0xffff;
    if (head === Opcode.END) break;
    if (opcode === Opcode.COMMENT) {
      const length = (head >>> 16) & 0x7fff;
      if (position + length > count) throw new Error('Truncated D3D9 shader comment');
      const data = bytes.subarray(position * 4, (position + length) * 4);
      const fourCC =
        length && data.every((b, i) => i >= 4 || (b >= 0x20 && b < 0x7f))
          ? String.fromCharCode(...data.subarray(0, 4))
          : '';
      comments.push({offset: at, fourCC, bytes: data});
      if (fourCC === 'CTAB' && !constantTable) constantTable = parseConstantTable(data.subarray(4));
      position += length;
      continue;
    }
    if (head & 0x80000000) throw new Error(`Invalid D3D9 instruction token at ${at}`);
    if (!opcodeNames.has(opcode) || opcode === Opcode.PHASE)
      throw new Error(`Unknown D3D9 opcode ${opcode} at token ${at}`);
    const length = (head >>> 24) & 0xf,
      end = position + length;
    if (end > count) throw new Error('Truncated D3D9 instruction');
    const instruction: D3D9Instruction = {
      offset: at,
      opcode,
      control: (head >>> 16) & 0xff,
      coissue: !!(head & 0x40000000),
      sources: [],
    };
    const predicated = !!(head & 0x10000000);
    const readRelative = (parameter: number): D3D9RelativeAddress | undefined => {
      if (!(parameter & 0x2000)) return undefined;
      if (!relativeSupported(version))
        throw new Error(`Relative addressing is not available in ${versionName(version)}`);
      const address = token(position++);
      return {
        type: registerType(address),
        index: address & 0x7ff,
        component: (address >>> 16) & 3,
      };
    };
    const readSource = (): D3D9SourceParameter => {
      const parameter = token(position++);
      if (!(parameter & 0x80000000)) throw new Error(`Invalid D3D9 source token at ${at}`);
      const source: D3D9SourceParameter = {
        type: registerType(parameter),
        index: parameter & 0x7ff,
        swizzle: (parameter >>> 16) & 0xff,
        modifier: (parameter >>> 24) & 0xf,
      };
      const relative = readRelative(parameter);
      if (relative) source.relative = relative;
      return source;
    };
    const readDestination = (): D3D9DestinationParameter => {
      const parameter = token(position++);
      if (!(parameter & 0x80000000)) throw new Error(`Invalid D3D9 destination token at ${at}`);
      const destination: D3D9DestinationParameter = {
        type: registerType(parameter),
        index: parameter & 0x7ff,
        writeMask: (parameter >>> 16) & 0xf,
        modifiers: (parameter >>> 20) & 0xf,
        shift: (((parameter >>> 24) & 0xf) << 28) >> 28,
      };
      const relative = readRelative(parameter);
      if (relative) destination.relative = relative;
      return destination;
    };
    if (opcode === Opcode.DCL) {
      const usage = token(position++);
      instruction.declaration = {
        usage: usage & 0x1f,
        usageIndex: (usage >>> 16) & 0xf,
        samplerType: (usage >>> 27) & 0xf,
      };
      instruction.destination = readDestination();
    } else if (opcode === Opcode.DEF || opcode === Opcode.DEFI) {
      instruction.destination = readDestination();
      const values: [number, number, number, number] = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        if (position >= end) throw new Error('Truncated D3D9 def');
        values[i] =
          opcode === Opcode.DEF
            ? view.getFloat32(position++ * 4, true)
            : view.getInt32(position++ * 4, true);
      }
      if (opcode === Opcode.DEF) instruction.floatValues = values;
      else instruction.intValues = values;
    } else if (opcode === Opcode.DEFB) {
      instruction.destination = readDestination();
      instruction.boolValue = token(position++) !== 0;
    } else {
      if (!noDestination.has(opcode)) instruction.destination = readDestination();
      if (predicated) instruction.predicate = readSource();
      while (position < end) instruction.sources.push(readSource());
    }
    if (position !== end)
      throw new Error(`D3D9 instruction length mismatch at token ${at} (${opcodeName(opcode)})`);
    instructions.push(instruction);
  }
  const shader: D3D9Shader = {version, instructions, comments, byteLength: position * 4};
  if (constantTable) shader.constantTable = constantTable;
  return shader;
}

/** Byte length of the token stream starting at `offset` (through the end token), or
 * undefined when no structurally valid stream starts there. Used to find embedded blobs. */
export function measureD3D9Shader(
  bytes: Uint8Array,
  offset = 0,
  maxBytes = 1 << 20,
): number | undefined {
  if (offset < 0 || offset + 8 > bytes.byteLength) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    limit = Math.min(bytes.byteLength, offset + maxBytes);
  const version = parseVersionToken(view.getUint32(offset, true));
  if (!version || version.major < 2 || version.major > 3) return undefined;
  let p = offset + 4;
  while (p + 4 <= limit) {
    const head = view.getUint32(p, true);
    if (head === Opcode.END) return p + 4 - offset;
    if ((head & 0xffff) === Opcode.COMMENT) p += 4 + ((head >>> 16) & 0x7fff) * 4;
    else if (head & 0x80000000 || !opcodeNames.has(head & 0xffff)) return undefined;
    else p += 4 + ((head >>> 24) & 0xf) * 4;
  }
  return undefined;
}
