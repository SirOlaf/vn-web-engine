import {
  Comparison,
  DeclUsage,
  declUsageNames,
  DEFAULT_SWIZZLE,
  MiscRegister,
  Opcode,
  opcodeName,
  RasterOutput,
  RegisterType,
  ResultModifier,
  SamplerType,
  SourceModifier,
  TexldControl,
  versionName,
  type D3D9DestinationParameter,
  type D3D9Instruction,
  type D3D9RelativeAddress,
  type D3D9Shader,
  type D3D9SourceParameter,
} from './bytecode.js';
import {RegisterSet} from './ctab.js';
import {registerName} from './disassemble.js';

/**
 * Translate D3D9 SM2/SM3 bytecode to GLSL ES 3.00 (WebGL2). See README.md in this
 * directory for the binding contract: uniform names, attribute and varying naming, and the
 * clip-space and window-space fixup uniforms.
 */

export type GlslSamplerDimension = '2d' | 'cube' | '3d';

export interface GlslConstantBinding {
  /** CTAB name. */
  name: string;
  registerSet: number;
  registerIndex: number;
  registerCount: number;
  /** Uniform array (vs_c, ps_i, …) or sampler uniform (ps_s0) that holds it. */
  uniform: string;
}

export interface GlslAttribute {
  name: string;
  register: number;
  usage: number;
  usageIndex: number;
}

export interface GlslVarying {
  name: string;
  usage: number;
  usageIndex: number;
  centroid: boolean;
  /** Pixel inputs: false when the paired vertex shader does not write it (reads zero). */
  linked: boolean;
}

export interface GlslSampler {
  name: string;
  register: number;
  dimension: GlslSamplerDimension;
}

export interface GlslUniformArray {
  name: string;
  count: number;
}

export interface D3D9GlslShader {
  stage: 'vertex' | 'fragment';
  /** D3D profile, e.g. ps_3_0. */
  profile: string;
  source: string;
  floatConstants?: GlslUniformArray;
  intConstants?: GlslUniformArray;
  boolConstants?: GlslUniformArray;
  constants: GlslConstantBinding[];
  samplers: GlslSampler[];
  /** Vertex shader inputs, bound by D3D vertex-declaration usage. */
  attributes: GlslAttribute[];
  /** Fragment inputs read. */
  inputs: GlslVarying[];
  /** Vertex outputs written (excluding position and point size). */
  outputs: GlslVarying[];
  /** Fragment colour outputs (oC#; `layout(location = #)`). */
  colorOutputs: number[];
  writesDepth: boolean;
  writesPointSize: boolean;
  /** Distinct opcodes translated. */
  opcodes: number[];
}

export interface GlslTranslateOptions {
  /** Fragment: varyings the paired vertex shader writes. Others read as vec4(0). */
  availableVaryings?: ReadonlySet<string>;
  /** Vertex: varyings the paired fragment shader reads with centroid interpolation. */
  centroidVaryings?: ReadonlySet<string>;
}

/** Vertex uniform: clip-space fixup (scale.x, scale.y, offset.x, offset.y). See README. */
export const POSITION_FIXUP_UNIFORM = 'dx_posFixup';
/** Fragment uniform: gl_FragCoord → D3D9 vPos (scale.xy, offset.xy). See README. */
export const SCREEN_FIXUP_UNIFORM = 'dx_screenFixup';

const components = 'xyzw';
const comparisonOperators = ['', '>', '==', '>=', '<', '!=', '<=', ''];
const comparisonFunctions = [
  '',
  'greaterThan',
  'equal',
  'greaterThanEqual',
  'lessThan',
  'notEqual',
  'lessThanEqual',
  '',
];

/** Opcodes the translator accepts (SM2/SM3 only; ps_1_x texture opcodes are rejected). */
export const TRANSLATED_OPCODES: ReadonlySet<number> = new Set([
  Opcode.NOP,
  Opcode.MOV,
  Opcode.ADD,
  Opcode.SUB,
  Opcode.MAD,
  Opcode.MUL,
  Opcode.RCP,
  Opcode.RSQ,
  Opcode.DP3,
  Opcode.DP4,
  Opcode.MIN,
  Opcode.MAX,
  Opcode.SLT,
  Opcode.SGE,
  Opcode.EXP,
  Opcode.LOG,
  Opcode.LIT,
  Opcode.DST,
  Opcode.LRP,
  Opcode.FRC,
  Opcode.M4x4,
  Opcode.M4x3,
  Opcode.M3x4,
  Opcode.M3x3,
  Opcode.M3x2,
  Opcode.CALL,
  Opcode.CALLNZ,
  Opcode.LOOP,
  Opcode.RET,
  Opcode.ENDLOOP,
  Opcode.LABEL,
  Opcode.DCL,
  Opcode.POW,
  Opcode.CRS,
  Opcode.SGN,
  Opcode.ABS,
  Opcode.NRM,
  Opcode.SINCOS,
  Opcode.REP,
  Opcode.ENDREP,
  Opcode.IF,
  Opcode.IFC,
  Opcode.ELSE,
  Opcode.ENDIF,
  Opcode.BREAK,
  Opcode.BREAKC,
  Opcode.MOVA,
  Opcode.DEFB,
  Opcode.DEFI,
  Opcode.TEXKILL,
  Opcode.TEX,
  Opcode.EXPP,
  Opcode.LOGP,
  Opcode.CND,
  Opcode.DEF,
  Opcode.CMP,
  Opcode.DP2ADD,
  Opcode.DSX,
  Opcode.DSY,
  Opcode.TEXLDD,
  Opcode.SETP,
  Opcode.TEXLDL,
  Opcode.BREAKP,
]);

/** Exact GLSL float literal for a float32 value. */
export function glslFloat(value: number): string {
  if (Number.isNaN(value)) return 'uintBitsToFloat(0x7fc00000u)';
  if (value === Infinity) return 'uintBitsToFloat(0x7f800000u)';
  if (value === -Infinity) return 'uintBitsToFloat(0xff800000u)';
  if (Object.is(value, -0)) return '-0.0';
  let text = String(value);
  for (let precision = 1; precision <= 9; precision++) {
    const candidate = value.toPrecision(precision);
    if (Math.fround(Number(candidate)) === value) {
      text = String(Number(candidate));
      break;
    }
  }
  return /[.e]/.test(text) ? text : `${text}.0`;
}

const helperSources: Record<string, string> = {
  dx_inf: 'float dx_inf() { return uintBitsToFloat(0x7f800000u); }',
  dx_rcp: 'float dx_rcp(float x) { return x == 1.0 ? 1.0 : x == 0.0 ? dx_inf() : 1.0 / x; }',
  dx_rsq:
    'float dx_rsq(float x) { float a = abs(x); return a == 1.0 ? 1.0 : a == 0.0 ? dx_inf() : inversesqrt(a); }',
  dx_log: 'float dx_log(float x) { float a = abs(x); return a == 0.0 ? -dx_inf() : log2(a); }',
  dx_pow:
    'float dx_pow(float x, float y) { float a = abs(x); return a == 0.0 ? (y > 0.0 ? 0.0 : y == 0.0 ? 1.0 : dx_inf()) : exp2(y * log2(a)); }',
  dx_lit: [
    'vec4 dx_lit(vec4 s) {',
    '  vec4 d = vec4(1.0, 0.0, 0.0, 1.0);',
    '  if (s.x > 0.0) {',
    '    d.y = s.x;',
    '    if (s.y > 0.0) d.z = dx_pow(s.y, clamp(s.w, -127.9961, 127.9961));',
    '  }',
    '  return d;',
    '}',
  ].join('\n'),
  dx_nrm:
    'vec4 dx_nrm(vec4 v) { float l = dot(v.xyz, v.xyz); return l == 0.0 ? vec4(0.0) : v * inversesqrt(l); }',
};
const helperDependencies: Record<string, string[]> = {
  dx_rcp: ['dx_inf'],
  dx_rsq: ['dx_inf'],
  dx_log: ['dx_inf'],
  dx_pow: ['dx_inf'],
  dx_lit: ['dx_pow'],
};

interface ControlFrame {
  kind: 'if' | 'rep' | 'loop';
  restore?: string;
}

function usageName(usage: number, index: number): string {
  return `${declUsageNames[usage] ?? `usage${usage}`}${index}`;
}

function maskString(mask: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) if (mask & (1 << i)) s += components[i];
  return s;
}

function vectorType(base: 'vec' | 'ivec' | 'bvec', n: number): string {
  return n === 1 ? (base === 'vec' ? 'float' : base === 'ivec' ? 'int' : 'bool') : `${base}${n}`;
}

function swizzleSuffix(swizzle: number): string {
  if (swizzle === DEFAULT_SWIZZLE) return '';
  let s = '.';
  for (let i = 0; i < 4; i++) s += components[(swizzle >>> (i * 2)) & 3];
  return s;
}

function swizzleComponent(swizzle: number, i: number): string {
  return components[(swizzle >>> (i * 2)) & 3]!;
}

class Translator {
  readonly vertex: boolean;
  readonly version;
  readonly prefix: string;
  readonly helpers = new Set<string>();
  readonly opcodes = new Set<number>();
  readonly temps = new Set<number>();
  readonly outputRegisters = new Map<string, number>();
  readonly floatDefs = new Map<number, [number, number, number, number]>();
  readonly intDefs = new Map<number, [number, number, number, number]>();
  readonly boolDefs = new Map<number, boolean>();
  readonly samplerTypes = new Map<number, number>();
  /** Register → declaration (vertex inputs, pixel inputs, vs_3_0 outputs). */
  readonly inputDecls = new Map<string, {usage: number; usageIndex: number; centroid: boolean}>();
  readonly outputDecls = new Map<number, {usage: number; usageIndex: number}>();
  readonly labels = new Set<number>();
  floatMax = -1;
  intMax = -1;
  boolMax = -1;
  floatRelative = false;
  usesAddress = false;
  usesPredicate = false;
  usesAL = false;
  usesVPos = false;
  usesVFace = false;
  usesScreenFixup = false;
  loopDepth = 0;
  uniqueId = 0;

  constructor(
    readonly shader: D3D9Shader,
    readonly options: GlslTranslateOptions,
  ) {
    this.version = shader.version;
    this.vertex = shader.version.stage === 'vertex';
    this.prefix = this.vertex ? 'vs' : 'ps';
  }

  fail(ins: D3D9Instruction | undefined, message: string): never {
    throw new Error(
      `${versionName(this.version)}${ins ? ` token ${ins.offset} (${opcodeName(ins.opcode)})` : ''}: ${message}`,
    );
  }

  // ---- register access ----

  constIndex(type: number, index: number): number {
    return (
      index +
      (type === RegisterType.CONST2
        ? 2048
        : type === RegisterType.CONST3
          ? 4096
          : type === RegisterType.CONST4
            ? 6144
            : 0)
    );
  }

  relativeIndex(ins: D3D9Instruction, relative: D3D9RelativeAddress): string {
    if (relative.type === RegisterType.LOOP) {
      if (!this.loopDepth && !this.inSubroutine) this.fail(ins, 'aL used outside a loop');
      this.usesAL = true;
      return 'dx_aL';
    }
    if (relative.type === RegisterType.ADDR_TEXTURE && this.vertex) {
      this.usesAddress = true;
      return `dx_a0.${components[relative.component]}`;
    }
    return this.fail(ins, 'unsupported relative address register');
  }

  inSubroutine = false;

  /** vec4 expression of a float register before swizzle/modifier. */
  floatRegister(
    ins: D3D9Instruction,
    type: number,
    index: number,
    relative?: D3D9RelativeAddress,
    offset = 0,
  ): string {
    switch (type) {
      case RegisterType.CONST:
      case RegisterType.CONST2:
      case RegisterType.CONST3:
      case RegisterType.CONST4: {
        const n = this.constIndex(type, index) + offset;
        if (relative) {
          this.floatRelative = true;
          this.floatMax = Math.max(this.floatMax, n);
          // Local definitions shadow the uniform array, also for relative reads.
          const array = this.floatDefs.size ? 'dx_c' : `${this.prefix}_c`;
          return `${array}[${n} + ${this.relativeIndex(ins, relative)}]`;
        }
        if (this.floatDefs.has(n)) return `dx_def_c${n}`;
        this.floatMax = Math.max(this.floatMax, n);
        return `${this.prefix}_c[${n}]`;
      }
      case RegisterType.TEMP:
        if (relative) break;
        this.temps.add(index + offset);
        return `r${index + offset}`;
      case RegisterType.INPUT: {
        if (relative) break;
        const decl = this.inputDecls.get(`v${index + offset}`);
        if (!decl) return this.fail(ins, `v${index + offset} read without dcl`);
        return this.vertex ? `a_${usageName(decl.usage, decl.usageIndex)}` : `v${index + offset}`;
      }
      case RegisterType.ADDR_TEXTURE:
        if (this.vertex || relative) break;
        if (!this.inputDecls.has(`t${index + offset}`))
          this.fail(ins, `t${index} read without dcl`);
        return `t${index + offset}`;
      case RegisterType.MISCTYPE:
        if (this.vertex || relative) break;
        if (index === MiscRegister.POSITION) {
          this.usesVPos = this.usesScreenFixup = true;
          return 'dx_vPos';
        }
        if (index === MiscRegister.FACE) {
          this.usesVFace = true;
          return 'dx_vFace';
        }
        break;
      case RegisterType.RASTOUT:
      case RegisterType.ATTROUT:
      case RegisterType.TEXCRDOUT_OUTPUT:
      case RegisterType.COLOROUT:
      case RegisterType.DEPTHOUT:
        if (relative) break;
        return this.outputRegister(ins, type, index + offset);
    }
    return this.fail(
      ins,
      `unsupported source register ${registerName(this.version, type, index)}${relative ? ' (relative)' : ''}`,
    );
  }

  outputRegister(ins: D3D9Instruction, type: number, index: number): string {
    const name = registerName(this.version, type, index);
    if (this.vertex) {
      if (
        type !== RegisterType.RASTOUT &&
        type !== RegisterType.ATTROUT &&
        type !== RegisterType.TEXCRDOUT_OUTPUT
      )
        this.fail(ins, `${name} is not a vertex output`);
      if (type === RegisterType.RASTOUT && index > RasterOutput.POINT_SIZE)
        this.fail(ins, `invalid ${name}`);
    } else if (type !== RegisterType.COLOROUT && type !== RegisterType.DEPTHOUT)
      this.fail(ins, `${name} is not a pixel output`);
    this.outputRegisters.set(name, type);
    return name;
  }

  modified(expr: string, modifier: number, ins: D3D9Instruction): string {
    switch (modifier) {
      case SourceModifier.NONE:
        return expr;
      case SourceModifier.NEG:
        return `(-${expr})`;
      case SourceModifier.ABS:
        return `abs(${expr})`;
      case SourceModifier.ABSNEG:
        return `(-abs(${expr}))`;
      case SourceModifier.BIAS:
        return `(${expr} - 0.5)`;
      case SourceModifier.BIASNEG:
        return `(0.5 - ${expr})`;
      case SourceModifier.SIGN:
        return `(${expr} * 2.0 - 1.0)`;
      case SourceModifier.SIGNNEG:
        return `(1.0 - ${expr} * 2.0)`;
      case SourceModifier.COMP:
        return `(1.0 - ${expr})`;
      case SourceModifier.X2:
        return `(${expr} * 2.0)`;
      case SourceModifier.X2NEG:
        return `(-${expr} * 2.0)`;
    }
    return this.fail(ins, `unsupported source modifier ${modifier}`);
  }

  /** Swizzled, modified vec4 source. `offset` selects a following register (matrix rows). */
  src(ins: D3D9Instruction, s: D3D9SourceParameter, offset = 0): string {
    const base = this.floatRegister(ins, s.type, s.index, s.relative, offset);
    return this.modified(base + swizzleSuffix(s.swizzle), s.modifier, ins);
  }

  /** One component of a source (scalar instructions). */
  scalar(ins: D3D9Instruction, s: D3D9SourceParameter, component: number): string {
    const base = this.floatRegister(ins, s.type, s.index, s.relative);
    return this.modified(`${base}.${swizzleComponent(s.swizzle, component)}`, s.modifier, ins);
  }

  boolCondition(ins: D3D9Instruction, s: D3D9SourceParameter): string {
    if (s.type === RegisterType.CONSTBOOL) {
      if (s.relative) this.fail(ins, 'relative bool constant');
      if (this.boolDefs.has(s.index)) return `dx_def_b${s.index}`;
      this.boolMax = Math.max(this.boolMax, s.index);
      return `${this.prefix}_b[${s.index}]`;
    }
    if (s.type === RegisterType.PREDICATE) {
      this.usesPredicate = true;
      const value = `dx_p0.${swizzleComponent(s.swizzle, 0)}`;
      return s.modifier === SourceModifier.NOT ? `!${value}` : value;
    }
    return this.fail(ins, 'condition is not a bool constant or predicate');
  }

  intRegister(ins: D3D9Instruction, s: D3D9SourceParameter): string {
    if (s.type !== RegisterType.CONSTINT || s.relative)
      this.fail(ins, 'expected an integer constant');
    if (this.intDefs.has(s.index)) return `dx_def_i${s.index}`;
    this.intMax = Math.max(this.intMax, s.index);
    return `${this.prefix}_i[${s.index}]`;
  }

  // ---- destination ----

  destinationRegister(ins: D3D9Instruction, d: D3D9DestinationParameter): string {
    if (d.relative) this.fail(ins, 'relative destination addressing is not supported');
    if (d.type === RegisterType.TEMP) {
      this.temps.add(d.index);
      return `r${d.index}`;
    }
    return this.outputRegister(ins, d.type, d.index);
  }

  /** Assign a vec4 (or scalar when `scalar`) value through the write mask, saturate and predicate. */
  assign(ins: D3D9Instruction, value: string, scalar = false): string {
    const d = ins.destination;
    if (!d) return this.fail(ins, 'missing destination');
    if (d.shift) this.fail(ins, 'result shift is not available in SM2/SM3');
    const target = this.destinationRegister(ins, d);
    const mask = maskString(d.writeMask);
    if (!mask) return '';
    const n = mask.length;
    let rhs = scalar
      ? n === 1
        ? value
        : `${vectorType('vec', n)}(${value})`
      : n === 4
        ? value
        : `(${value}).${mask}`;
    if (d.modifiers & ResultModifier.SATURATE) rhs = `clamp(${rhs}, 0.0, 1.0)`;
    const lhs = n === 4 ? target : `${target}.${mask}`;
    if (ins.predicate) {
      const p = ins.predicate;
      this.usesPredicate = true;
      let selector = '';
      for (let i = 0; i < 4; i++)
        if (d.writeMask & (1 << i)) selector += swizzleComponent(p.swizzle, i);
      let condition = `dx_p0.${selector}`;
      if (p.modifier === SourceModifier.NOT)
        condition = n === 1 ? `!${condition}` : `not(${condition})`;
      return `${lhs} = mix(${lhs}, ${rhs}, ${condition});`;
    }
    return `${lhs} = ${rhs};`;
  }

  helper(name: string): string {
    for (const dependency of helperDependencies[name] ?? []) this.helper(dependency);
    this.helpers.add(name);
    return name;
  }

  // ---- body ----

  sampler(ins: D3D9Instruction, s: D3D9SourceParameter): {name: string; type: number} {
    if (s.type !== RegisterType.SAMPLER) this.fail(ins, 'expected a sampler');
    const type = this.samplerTypes.get(s.index) ?? SamplerType.TEX_2D;
    this.samplerTypes.set(s.index, type);
    return {name: `${this.prefix}_s${s.index}`, type};
  }

  coordinate(expr: string, type: number): string {
    return `${expr}.${type === SamplerType.TEX_2D ? 'xy' : 'xyz'}`;
  }

  textureLoad(ins: D3D9Instruction): string {
    const coord = this.src(ins, ins.sources[0]!);
    const sampler = ins.sources[1]!,
      {name, type} = this.sampler(ins, sampler);
    let call: string;
    switch (ins.opcode) {
      case Opcode.TEXLDL:
        call = `textureLod(${name}, ${this.coordinate(coord, type)}, ${coord}.w)`;
        break;
      case Opcode.TEXLDD:
        call = `textureGrad(${name}, ${this.coordinate(coord, type)}, ${this.coordinate(this.src(ins, ins.sources[2]!), type)}, ${this.coordinate(this.src(ins, ins.sources[3]!), type)})`;
        break;
      default:
        if (ins.control === TexldControl.PROJECT)
          call =
            type === SamplerType.CUBE
              ? `texture(${name}, ${coord}.xyz)`
              : `textureProj(${name}, ${type === SamplerType.TEX_2D ? `${coord}.xyw` : coord})`;
        else if (ins.control === TexldControl.BIAS)
          call = `texture(${name}, ${this.coordinate(coord, type)}, ${coord}.w)`;
        else call = `texture(${name}, ${this.coordinate(coord, type)})`;
    }
    if (this.vertex && ins.opcode !== Opcode.TEXLDL)
      this.fail(ins, 'vertex texture fetch requires texldl');
    return call + swizzleSuffix(sampler.swizzle);
  }

  matrix(ins: D3D9Instruction, rows: number, width: 3 | 4): string {
    const a = this.src(ins, ins.sources[0]!),
      s = ins.sources[1]!;
    const items: string[] = [];
    for (let row = 0; row < 4; row++) {
      if (row >= rows) items.push('0.0');
      else {
        const b = this.src(ins, s, row);
        items.push(width === 4 ? `dot(${a}, ${b})` : `dot(${a}.xyz, ${b}.xyz)`);
      }
    }
    return `vec4(${items.join(', ')})`;
  }

  statement(ins: D3D9Instruction): string[] {
    const s = ins.sources,
      src = (i: number) => this.src(ins, s[i]!),
      w = (i: number) => this.scalar(ins, s[i]!, 3);
    switch (ins.opcode) {
      case Opcode.NOP:
        return [];
      case Opcode.MOV:
        return [this.assign(ins, src(0))];
      case Opcode.ADD:
        return [this.assign(ins, `(${src(0)} + ${src(1)})`)];
      case Opcode.SUB:
        return [this.assign(ins, `(${src(0)} - ${src(1)})`)];
      case Opcode.MUL:
        return [this.assign(ins, `(${src(0)} * ${src(1)})`)];
      case Opcode.MAD:
        return [this.assign(ins, `(${src(0)} * ${src(1)} + ${src(2)})`)];
      case Opcode.RCP:
        return [this.assign(ins, `${this.helper('dx_rcp')}(${w(0)})`, true)];
      case Opcode.RSQ:
        return [this.assign(ins, `${this.helper('dx_rsq')}(${w(0)})`, true)];
      case Opcode.EXP:
      case Opcode.EXPP:
        return [this.assign(ins, `exp2(${w(0)})`, true)];
      case Opcode.LOG:
      case Opcode.LOGP:
        return [this.assign(ins, `${this.helper('dx_log')}(${w(0)})`, true)];
      case Opcode.POW:
        return [this.assign(ins, `${this.helper('dx_pow')}(${w(0)}, ${w(1)})`, true)];
      case Opcode.DP3:
        return [this.assign(ins, `dot(${src(0)}.xyz, ${src(1)}.xyz)`, true)];
      case Opcode.DP4:
        return [this.assign(ins, `dot(${src(0)}, ${src(1)})`, true)];
      case Opcode.DP2ADD:
        return [
          this.assign(
            ins,
            `(dot(${src(0)}.xy, ${src(1)}.xy) + ${this.scalar(ins, s[2]!, 0)})`,
            true,
          ),
        ];
      case Opcode.MIN:
        return [this.assign(ins, `min(${src(0)}, ${src(1)})`)];
      case Opcode.MAX:
        return [this.assign(ins, `max(${src(0)}, ${src(1)})`)];
      case Opcode.SLT:
        return [this.assign(ins, `vec4(lessThan(${src(0)}, ${src(1)}))`)];
      case Opcode.SGE:
        return [this.assign(ins, `vec4(greaterThanEqual(${src(0)}, ${src(1)}))`)];
      case Opcode.LIT:
        return [this.assign(ins, `${this.helper('dx_lit')}(${src(0)})`)];
      case Opcode.DST:
        return [this.assign(ins, `vec4(1.0, ${src(0)}.y * ${src(1)}.y, ${src(0)}.z, ${src(1)}.w)`)];
      case Opcode.LRP:
        return [this.assign(ins, `mix(${src(2)}, ${src(1)}, ${src(0)})`)];
      case Opcode.FRC:
        return [this.assign(ins, `fract(${src(0)})`)];
      case Opcode.M4x4:
        return [this.assign(ins, this.matrix(ins, 4, 4))];
      case Opcode.M4x3:
        return [this.assign(ins, this.matrix(ins, 3, 4))];
      case Opcode.M3x4:
        return [this.assign(ins, this.matrix(ins, 4, 3))];
      case Opcode.M3x3:
        return [this.assign(ins, this.matrix(ins, 3, 3))];
      case Opcode.M3x2:
        return [this.assign(ins, this.matrix(ins, 2, 3))];
      case Opcode.CRS:
        return [this.assign(ins, `vec4(cross(${src(0)}.xyz, ${src(1)}.xyz), 0.0)`)];
      case Opcode.SGN:
        return [this.assign(ins, `sign(${src(0)})`)];
      case Opcode.ABS:
        return [this.assign(ins, `abs(${src(0)})`)];
      case Opcode.NRM:
        return [this.assign(ins, `${this.helper('dx_nrm')}(${src(0)})`)];
      case Opcode.SINCOS: {
        const x = this.scalar(ins, s[0]!, 0);
        if (ins.destination && ins.destination.writeMask & 0xc)
          this.fail(ins, 'sincos writes only .x and .y');
        return [this.assign(ins, `vec4(cos(${x}), sin(${x}), 0.0, 0.0)`)];
      }
      case Opcode.CMP:
        return [
          this.assign(ins, `mix(${src(2)}, ${src(1)}, greaterThanEqual(${src(0)}, vec4(0.0)))`),
        ];
      case Opcode.CND:
        return [this.assign(ins, `mix(${src(2)}, ${src(1)}, greaterThan(${src(0)}, vec4(0.5)))`)];
      case Opcode.DSX:
        return [this.assign(ins, `dFdx(${src(0)})`)];
      case Opcode.DSY:
        this.usesScreenFixup = true;
        return [this.assign(ins, `(dFdy(${src(0)}) * ${SCREEN_FIXUP_UNIFORM}.y)`)];
      case Opcode.MOVA: {
        const d = ins.destination!;
        if (d.type !== RegisterType.ADDR_TEXTURE || !this.vertex)
          this.fail(ins, 'mova target must be a0');
        if (ins.predicate) this.fail(ins, 'predicated mova is not supported');
        this.usesAddress = true;
        const mask = maskString(d.writeMask),
          n = mask.length;
        // vs_2_0+: round to nearest.
        return [`dx_a0.${mask} = ${vectorType('ivec', n)}(floor((${src(0)}).${mask} + 0.5));`];
      }
      case Opcode.SETP: {
        const d = ins.destination!;
        if (d.type !== RegisterType.PREDICATE) this.fail(ins, 'setp target must be p0');
        if (ins.predicate) this.fail(ins, 'predicated setp is not supported');
        this.usesPredicate = true;
        const mask = maskString(d.writeMask),
          fn = comparisonFunctions[ins.control & 7];
        if (!fn) this.fail(ins, 'invalid comparison');
        return [`dx_p0.${mask} = ${fn}(${src(0)}, ${src(1)}).${mask};`];
      }
      case Opcode.TEXKILL: {
        const d = ins.destination!;
        if (ins.predicate) this.fail(ins, 'predicated texkill is not supported');
        const reg =
          d.type === RegisterType.TEMP
            ? `r${d.index}`
            : this.floatRegister(ins, d.type, d.index, d.relative);
        if (d.type === RegisterType.TEMP) this.temps.add(d.index);
        const mask = maskString(d.writeMask);
        if (!mask) return [];
        const zero = mask.length === 1 ? '0.0' : `${vectorType('vec', mask.length)}(0.0)`;
        return [
          mask.length === 1
            ? `if (${reg}.${mask} < 0.0) discard;`
            : `if (any(lessThan(${reg}.${mask}, ${zero}))) discard;`,
        ];
      }
      case Opcode.TEX:
      case Opcode.TEXLDL:
      case Opcode.TEXLDD:
        return [this.assign(ins, this.textureLoad(ins))];
    }
    return this.fail(ins, 'opcode is not translated');
  }

  translate(): D3D9GlslShader {
    const shader = this.shader,
      ins0 = shader.instructions;
    // Declarations first: def/dcl apply to the whole program.
    for (const ins of ins0) {
      const d = ins.destination;
      if (ins.opcode === Opcode.DEF && d)
        this.floatDefs.set(this.constIndex(d.type, d.index), ins.floatValues!);
      else if (ins.opcode === Opcode.DEFI && d) this.intDefs.set(d.index, ins.intValues!);
      else if (ins.opcode === Opcode.DEFB && d) this.boolDefs.set(d.index, ins.boolValue!);
      else if (ins.opcode === Opcode.LABEL) this.labels.add(ins.sources[0]!.index);
      else if (ins.opcode === Opcode.DCL && d && ins.declaration) {
        const decl = ins.declaration;
        if (d.type === RegisterType.SAMPLER) this.samplerTypes.set(d.index, decl.samplerType);
        else if (d.type === RegisterType.INPUT) {
          const usage = this.vertex || this.version.major >= 3 ? decl.usage : DeclUsage.COLOR;
          const usageIndex = this.vertex || this.version.major >= 3 ? decl.usageIndex : d.index;
          this.inputDecls.set(`v${d.index}`, {
            usage,
            usageIndex,
            centroid: !!(d.modifiers & ResultModifier.CENTROID),
          });
        } else if (d.type === RegisterType.ADDR_TEXTURE && !this.vertex) {
          this.inputDecls.set(`t${d.index}`, {
            usage: DeclUsage.TEXCOORD,
            usageIndex: d.index,
            centroid: !!(d.modifiers & ResultModifier.CENTROID),
          });
        } else if (d.type === RegisterType.TEXCRDOUT_OUTPUT && this.vertex) {
          this.outputDecls.set(d.index, {usage: decl.usage, usageIndex: decl.usageIndex});
        } else if (d.type !== RegisterType.MISCTYPE)
          this.fail(ins, `unsupported dcl of ${registerName(this.version, d.type, d.index)}`);
      }
    }
    for (const [register] of this.samplerTypes)
      this.samplerTypes.set(register, this.samplerTypes.get(register) || SamplerType.TEX_2D);
    // CTAB sampler types fill in undeclared samplers.
    for (const c of shader.constantTable?.constants ?? [])
      if (c.registerSet === RegisterSet.SAMPLER)
        for (let i = 0; i < Math.max(1, c.registerCount); i++)
          if (!this.samplerTypes.has(c.registerIndex + i))
            this.samplerTypes.set(
              c.registerIndex + i,
              c.type.type === 14
                ? SamplerType.CUBE
                : c.type.type === 13
                  ? SamplerType.VOLUME
                  : SamplerType.TEX_2D,
            );

    const functions = new Map<number | 'main', string[]>();
    let current: string[] | undefined = [];
    functions.set('main', current);
    let depth = 1;
    const control: ControlFrame[] = [];
    const emit = (line: string) => current!.push('  '.repeat(depth) + line);
    for (const ins of ins0) {
      this.opcodes.add(ins.opcode);
      if (!TRANSLATED_OPCODES.has(ins.opcode)) this.fail(ins, 'opcode is not translated');
      if (
        ins.opcode === Opcode.DCL ||
        ins.opcode === Opcode.DEF ||
        ins.opcode === Opcode.DEFI ||
        ins.opcode === Opcode.DEFB
      )
        continue;
      if (ins.opcode === Opcode.LABEL) {
        if (control.length) this.fail(ins, 'label inside a block');
        current = [];
        functions.set(ins.sources[0]!.index, current);
        this.inSubroutine = true;
        depth = 1;
        continue;
      }
      if (!current) {
        if (ins.opcode === Opcode.NOP) continue;
        this.fail(ins, 'instruction after ret outside a subroutine');
      }
      if (ins.predicate && ins.opcode !== Opcode.TEXKILL && !ins.destination)
        this.fail(ins, 'predicated flow control is not supported (use breakp/if p)');
      const s = ins.sources;
      switch (ins.opcode) {
        case Opcode.RET:
          if (!control.length) current = undefined;
          else emit('return;');
          continue;
        case Opcode.CALL:
          emit(`dx_label${s[0]!.index}();`);
          continue;
        case Opcode.CALLNZ:
          emit(`if (${this.boolCondition(ins, s[1]!)}) dx_label${s[0]!.index}();`);
          continue;
        case Opcode.IF:
          emit(`if (${this.boolCondition(ins, s[0]!)}) {`);
          control.push({kind: 'if'});
          depth++;
          continue;
        case Opcode.IFC: {
          const op = comparisonOperators[ins.control & 7];
          if (!op) this.fail(ins, 'invalid comparison');
          emit(`if (${this.scalar(ins, s[0]!, 0)} ${op} ${this.scalar(ins, s[1]!, 0)}) {`);
          control.push({kind: 'if'});
          depth++;
          continue;
        }
        case Opcode.ELSE:
          if (control.at(-1)?.kind !== 'if') this.fail(ins, 'else without if');
          depth--;
          emit('} else {');
          depth++;
          continue;
        case Opcode.ENDIF:
          if (control.pop()?.kind !== 'if') this.fail(ins, 'endif without if');
          depth--;
          emit('}');
          continue;
        case Opcode.REP: {
          const id = this.uniqueId++,
            count = this.intRegister(ins, s[0]!);
          emit(`for (int dx_rep${id} = 0; dx_rep${id} < ${count}.x; ++dx_rep${id}) {`);
          control.push({kind: 'rep'});
          depth++;
          this.loopDepth++;
          continue;
        }
        case Opcode.LOOP: {
          const id = this.uniqueId++,
            counter = this.intRegister(ins, s[1]!);
          if (s[0]!.type !== RegisterType.LOOP) this.fail(ins, 'loop requires aL');
          this.usesAL = true;
          emit(`int dx_aLsave${id} = dx_aL;`);
          emit(`dx_aL = ${counter}.y;`);
          emit(
            `for (int dx_loop${id} = 0; dx_loop${id} < ${counter}.x; ++dx_loop${id}, dx_aL += ${counter}.z) {`,
          );
          control.push({kind: 'loop', restore: `dx_aL = dx_aLsave${id};`});
          depth++;
          this.loopDepth++;
          continue;
        }
        case Opcode.ENDREP:
        case Opcode.ENDLOOP: {
          const frame = control.pop();
          if (frame?.kind !== (ins.opcode === Opcode.ENDREP ? 'rep' : 'loop'))
            this.fail(ins, 'mismatched loop end');
          depth--;
          this.loopDepth--;
          emit('}');
          if (frame.restore) emit(frame.restore);
          continue;
        }
        case Opcode.BREAK:
          emit('break;');
          continue;
        case Opcode.BREAKC: {
          const op = comparisonOperators[ins.control & 7];
          if (!op) this.fail(ins, 'invalid comparison');
          emit(`if (${this.scalar(ins, s[0]!, 0)} ${op} ${this.scalar(ins, s[1]!, 0)}) break;`);
          continue;
        }
        case Opcode.BREAKP:
          emit(`if (${this.boolCondition(ins, s[0]!)}) break;`);
          continue;
      }
      for (const line of this.statement(ins)) if (line) emit(line);
    }
    if (control.length) this.fail(undefined, 'unterminated control flow');
    for (const label of functions.keys()) if (label !== 'main') this.labels.add(label);

    return this.assemble(functions);
  }

  assemble(functions: Map<number | 'main', string[]>): D3D9GlslShader {
    const shader = this.shader,
      table = shader.constantTable,
      prefix = this.prefix,
      lines: string[] = ['#version 300 es', 'precision highp float;', 'precision highp int;'];
    if ([...this.samplerTypes.values()].includes(SamplerType.VOLUME))
      lines.push('precision highp sampler3D;');
    lines.push(`// Translated from D3D9 ${versionName(this.version)}`);

    // Constant arrays: cover referenced registers and CTAB ranges.
    const constants: GlslConstantBinding[] = [];
    let floatCount = this.floatMax + 1,
      intCount = this.intMax + 1,
      boolCount = this.boolMax + 1;
    for (const c of table?.constants ?? []) {
      const end = c.registerIndex + c.registerCount;
      let uniform: string;
      if (c.registerSet === RegisterSet.FLOAT4) {
        floatCount = Math.max(floatCount, end);
        uniform = `${prefix}_c`;
      } else if (c.registerSet === RegisterSet.INT4) {
        intCount = Math.max(intCount, end);
        uniform = `${prefix}_i`;
      } else if (c.registerSet === RegisterSet.BOOL) {
        boolCount = Math.max(boolCount, end);
        uniform = `${prefix}_b`;
      } else uniform = `${prefix}_s${c.registerIndex}`;
      constants.push({
        name: c.name,
        registerSet: c.registerSet,
        registerIndex: c.registerIndex,
        registerCount: c.registerCount,
        uniform,
      });
    }
    if (this.floatRelative) {
      const fallback = this.vertex ? 256 : this.version.major >= 3 ? 224 : 32;
      const covered = (table?.constants ?? []).some(
        (c) =>
          c.registerSet === RegisterSet.FLOAT4 && c.registerIndex + c.registerCount >= floatCount,
      );
      if (!covered) floatCount = Math.max(floatCount, fallback);
    }
    const result: D3D9GlslShader = {
      stage: this.vertex ? 'vertex' : 'fragment',
      profile: versionName(this.version),
      source: '',
      constants,
      samplers: [],
      attributes: [],
      inputs: [],
      outputs: [],
      colorOutputs: [],
      writesDepth: false,
      writesPointSize: false,
      opcodes: [...this.opcodes].sort((a, b) => a - b),
    };
    if (floatCount > 0) {
      lines.push(`uniform vec4 ${prefix}_c[${floatCount}];`);
      result.floatConstants = {name: `${prefix}_c`, count: floatCount};
    }
    if (intCount > 0) {
      lines.push(`uniform ivec4 ${prefix}_i[${intCount}];`);
      result.intConstants = {name: `${prefix}_i`, count: intCount};
    }
    if (boolCount > 0) {
      lines.push(`uniform bool ${prefix}_b[${boolCount}];`);
      result.boolConstants = {name: `${prefix}_b`, count: boolCount};
    }
    if (table?.constants.length) {
      lines.push('// CTAB:');
      for (const c of constants)
        lines.push(
          `//   ${c.name}: ${c.uniform}${c.registerSet === RegisterSet.SAMPLER ? '' : `[${c.registerIndex}..${c.registerIndex + c.registerCount - 1}]`}`,
        );
    }
    for (const [register, type] of [...this.samplerTypes].sort((a, b) => a[0] - b[0])) {
      const dimension: GlslSamplerDimension =
        type === SamplerType.CUBE ? 'cube' : type === SamplerType.VOLUME ? '3d' : '2d';
      const name = `${prefix}_s${register}`;
      lines.push(
        `uniform ${dimension === 'cube' ? 'samplerCube' : dimension === '3d' ? 'sampler3D' : 'sampler2D'} ${name};`,
      );
      result.samplers.push({name, register, dimension});
    }
    for (const [n, v] of [...this.floatDefs].sort((a, b) => a[0] - b[0]))
      lines.push(`const vec4 dx_def_c${n} = vec4(${v.map(glslFloat).join(', ')});`);
    for (const [n, v] of [...this.intDefs].sort((a, b) => a[0] - b[0]))
      lines.push(`const ivec4 dx_def_i${n} = ivec4(${v.join(', ')});`);
    for (const [n, v] of [...this.boolDefs].sort((a, b) => a[0] - b[0]))
      lines.push(`const bool dx_def_b${n} = ${v};`);
    const prologue: string[] = [],
      epilogue: string[] = [];
    if (this.floatRelative && this.floatDefs.size) {
      lines.push(`vec4 dx_c[${floatCount}];`);
      prologue.push(`dx_c = ${prefix}_c;`);
      for (const [n] of [...this.floatDefs].sort((a, b) => a[0] - b[0]))
        if (n < floatCount) prologue.push(`dx_c[${n}] = dx_def_c${n};`);
    }

    if (this.vertex) this.vertexInterface(lines, epilogue, result);
    else this.fragmentInterface(lines, prologue, epilogue, result);

    for (const t of [...this.temps].sort((a, b) => a - b)) lines.push(`vec4 r${t} = vec4(0.0);`);
    if (this.usesAddress) lines.push('ivec4 dx_a0 = ivec4(0);');
    if (this.usesAL) lines.push('int dx_aL = 0;');
    if (this.usesPredicate) lines.push('bvec4 dx_p0 = bvec4(false);');

    for (const name of Object.keys(helperSources))
      if (this.helpers.has(name)) lines.push(helperSources[name]!);
    const labels = [...functions.keys()]
      .filter((k): k is number => k !== 'main')
      .sort((a, b) => a - b);
    for (const label of this.labels)
      if (!functions.has(label)) this.fail(undefined, `missing label l${label}`);
    for (const label of labels) lines.push(`void dx_label${label}();`);
    lines.push('void dx_main() {', ...functions.get('main')!, '}');
    for (const label of labels)
      lines.push(`void dx_label${label}() {`, ...functions.get(label)!, '}');
    lines.push(
      'void main() {',
      ...prologue.map((l) => `  ${l}`),
      '  dx_main();',
      ...epilogue.map((l) => `  ${l}`),
      '}',
    );
    result.source = lines.join('\n') + '\n';
    return result;
  }

  vertexInterface(lines: string[], epilogue: string[], result: D3D9GlslShader): void {
    const attributes = [...this.inputDecls].map(([reg, d]) => ({reg: Number(reg.slice(1)), ...d}));
    attributes.sort((a, b) => a.reg - b.reg);
    for (const a of attributes) {
      const name = `a_${usageName(a.usage, a.usageIndex)}`;
      lines.push(`in vec4 ${name};`);
      result.attributes.push({name, register: a.reg, usage: a.usage, usageIndex: a.usageIndex});
    }
    lines.push(`uniform vec4 ${POSITION_FIXUP_UNIFORM};`);
    const centroid = this.options.centroidVaryings ?? new Set<string>();
    const varying = (register: string, usage: number, usageIndex: number, clamp: boolean) => {
      const name = `v_${usageName(usage, usageIndex)}`,
        isCentroid = centroid.has(name);
      lines.push(`${isCentroid ? 'centroid ' : ''}out vec4 ${name};`);
      epilogue.push(`${name} = ${clamp ? `clamp(${register}, 0.0, 1.0)` : register};`);
      result.outputs.push({name, usage, usageIndex, centroid: isCentroid, linked: true});
    };
    let position: string | undefined;
    const registers: string[] = [];
    if (this.version.major >= 3) {
      for (const [index, d] of [...this.outputDecls].sort((a, b) => a[0] - b[0])) {
        const reg = `o${index}`;
        registers.push(reg);
        if (d.usage === DeclUsage.POSITION && d.usageIndex === 0) position = reg;
        else if (d.usage === DeclUsage.PSIZE && d.usageIndex === 0) {
          epilogue.push(`gl_PointSize = ${reg}.x;`);
          result.writesPointSize = true;
        } else varying(reg, d.usage, d.usageIndex, false);
      }
      for (const name of this.outputRegisters.keys())
        if (!registers.includes(name)) this.fail(undefined, `${name} written without dcl`);
    } else {
      const written = [...this.outputRegisters.keys()].sort();
      position = 'oPos';
      registers.push('oPos');
      for (const reg of written) {
        if (reg === 'oPos') continue;
        registers.push(reg);
        if (reg === 'oPts') {
          epilogue.push('gl_PointSize = oPts.x;');
          result.writesPointSize = true;
        } else if (reg === 'oFog') varying(reg, DeclUsage.FOG, 0, false);
        else if (reg.startsWith('oD')) varying(reg, DeclUsage.COLOR, Number(reg.slice(2)), true);
        else if (reg.startsWith('oT'))
          varying(reg, DeclUsage.TEXCOORD, Number(reg.slice(2)), false);
      }
    }
    for (const reg of registers) lines.push(`vec4 ${reg} = vec4(0.0);`);
    if (position) {
      const f = POSITION_FIXUP_UNIFORM;
      epilogue.push(
        `gl_Position = vec4(${position}.x * ${f}.x + ${f}.z * ${position}.w, ${position}.y * ${f}.y + ${f}.w * ${position}.w, ${position}.z * 2.0 - ${position}.w, ${position}.w);`,
      );
    }
  }

  fragmentInterface(
    lines: string[],
    prologue: string[],
    epilogue: string[],
    result: D3D9GlslShader,
  ): void {
    const available = this.options.availableVaryings;
    for (const [reg, d] of [...this.inputDecls].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const name = `v_${usageName(d.usage, d.usageIndex)}`,
        linked = !available || available.has(name);
      lines.push(`vec4 ${reg} = vec4(0.0);`);
      if (linked) {
        lines.push(`${d.centroid ? 'centroid ' : ''}in vec4 ${name};`);
        prologue.push(`${reg} = ${name};`);
      }
      result.inputs.push({
        name,
        usage: d.usage,
        usageIndex: d.usageIndex,
        centroid: d.centroid,
        linked,
      });
    }
    if (this.usesScreenFixup) lines.push(`uniform vec4 ${SCREEN_FIXUP_UNIFORM};`);
    if (this.usesVPos) {
      lines.push('vec4 dx_vPos = vec4(0.0);');
      prologue.push(
        `dx_vPos = vec4(gl_FragCoord.xy * ${SCREEN_FIXUP_UNIFORM}.xy + ${SCREEN_FIXUP_UNIFORM}.zw, 0.0, 0.0);`,
      );
    }
    if (this.usesVFace) {
      lines.push('vec4 dx_vFace = vec4(0.0);');
      prologue.push('dx_vFace = vec4(gl_FrontFacing ? 1.0 : -1.0);');
    }
    for (const [name, type] of [...this.outputRegisters].sort()) {
      lines.push(`vec4 ${name} = vec4(0.0);`);
      if (type === RegisterType.COLOROUT) {
        const index = Number(name.slice(2));
        lines.push(`layout(location = ${index}) out vec4 dx_${name};`);
        epilogue.push(`dx_${name} = ${name};`);
        result.colorOutputs.push(index);
      } else {
        epilogue.push(`gl_FragDepth = ${name}.x;`);
        result.writesDepth = true;
      }
    }
    result.colorOutputs.sort((a, b) => a - b);
  }
}

/** Translate one parsed shader. Throws on constructs outside SM2/SM3 or not yet supported. */
export function translateD3D9ShaderToGlsl(
  shader: D3D9Shader,
  options: GlslTranslateOptions = {},
): D3D9GlslShader {
  return new Translator(shader, options).translate();
}

/** Translate a vertex/pixel pair so varyings link: pixel inputs the vertex shader does not
 * write read vec4(0), and centroid qualifiers match on both sides. */
export function translateD3D9ProgramToGlsl(
  vertexShader: D3D9Shader,
  pixelShader: D3D9Shader,
): {vertex: D3D9GlslShader; fragment: D3D9GlslShader} {
  if (vertexShader.version.stage !== 'vertex' || pixelShader.version.stage !== 'pixel')
    throw new Error('Expected a vertex shader and a pixel shader');
  const probe = translateD3D9ShaderToGlsl(pixelShader);
  const centroid = new Set(probe.inputs.filter((i) => i.centroid).map((i) => i.name));
  const vertex = translateD3D9ShaderToGlsl(vertexShader, {centroidVaryings: centroid});
  const fragment = translateD3D9ShaderToGlsl(pixelShader, {
    availableVaryings: new Set(vertex.outputs.map((o) => o.name)),
  });
  return {vertex, fragment};
}
