import {
  Sm4Opcode as Op,
  type Sm4Instruction,
  type Sm4Operand,
  type Sm4Program,
} from './bytecode.js';

export interface Sm4GlslIo {
  readonly register: number;
  readonly mask: number;
  readonly systemValue: number;
  /** Native interpolation mode;0 for non-pixel-input declarations. */
  readonly interpolation: number;
}
export interface Sm4GlslConstantBuffer {
  readonly slot: number;
  readonly vectors: number;
  /** Upload raw DWORDs with uniform4uiv; missing bound bytes must be zero-filled. */
  readonly uniform: string;
}
export interface Sm4GlslSample {
  readonly resource: number;
  readonly sampler: number;
  readonly uniform: string;
}
export interface Sm4GlslProgram {
  readonly stage: 'vertex' | 'pixel';
  /** GLSL ES3 declarations and a callable stage function, without main or a version directive. */
  readonly source: string;
  readonly entry: string;
  /** Lengths of the entry's input and output register array parameters. */
  readonly inputRegisters: number;
  readonly outputRegisters: number;
  readonly inputs: readonly Sm4GlslIo[];
  readonly outputs: readonly Sm4GlslIo[];
  readonly constantBuffers: readonly Sm4GlslConstantBuffer[];
  readonly samples: readonly Sm4GlslSample[];
}

const channels = 'xyzw';
const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}u`;
const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
function fail(message: string): never {
  throw new Error(`Unsupported or invalid SM4 GLSL program: ${message}`);
}
function index(operand: Sm4Operand, dimension: number): number {
  const value = operand.indices[dimension];
  if (!value || value.relative || value.immediate.length !== 1 || !uint(value.immediate[0]!))
    fail('non-immediate32 register index');
  return value.immediate[0]!;
}
function reg(operand: Sm4Operand, type: number, limit: number): number {
  if (operand.type !== type || operand.indices.length !== 1) fail('register type or dimension');
  const value = index(operand, 0);
  if (value >= limit) fail('register index');
  return value;
}
function mask(operand: Sm4Operand): number {
  if (
    operand.componentCount !== 4 ||
    operand.selectionMode !== 'mask' ||
    operand.components.length === 0 ||
    operand.components.some(
      (c, i) =>
        !Number.isInteger(c) || c < 0 || c > 3 || (i > 0 && c <= operand.components[i - 1]!),
    ) ||
    operand.extended.length
  )
    fail('destination component mask');
  return operand.components.reduce((bits, c) => bits | (1 << c), 0);
}

interface GlslHelper {
  readonly name: string;
  readonly source: string;
  readonly dependencies: readonly string[];
}
function makeHelpers(prefix: string) {
  const helpers = [
    // Per-component choice: Mali compilers (ANGLE on GLES) miscompile the bit mask
    // `(a & ~bits) | (b & bits)` with `bits = uvec4(takeB) * 0xffffffffu` inside callers.
    `uvec4 ${prefix}_select(uvec4 a, uvec4 b, bvec4 takeB) { return uvec4(takeB.x ? b.x : a.x, takeB.y ? b.y : a.y, takeB.z ? b.z : a.z, takeB.w ? b.w : a.w); }`,
    `uvec4 ${prefix}_flush(uvec4 a) { return ${prefix}_select(a, a & uvec4(0x80000000u), lessThan(a & uvec4(0x7fffffffu), uvec4(0x00800000u))); }`,
    `vec4 ${prefix}_float(uvec4 a) { return uintBitsToFloat(${prefix}_flush(a)); }`,
    `uvec4 ${prefix}_store(vec4 a) { return ${prefix}_flush(floatBitsToUint(a)); }`,
    `vec4 ${prefix}_min(vec4 a, vec4 b) { return mix(mix(min(a,b), b, isnan(a)), a, isnan(b)); }`,
    `vec4 ${prefix}_max(vec4 a, vec4 b) { return mix(mix(max(a,b), b, isnan(a)), a, isnan(b)); }`,
    `vec4 ${prefix}_sat(vec4 a) { return mix(clamp(a,0.0,1.0), vec4(0.0), isnan(a)); }`,
    `float ${prefix}_div1(float a, float b) {
      uint sign = (floatBitsToUint(a) ^ floatBitsToUint(b)) & 0x80000000u;
      if (isnan(a) || isnan(b) || (a==0.0 && b==0.0) || (isinf(a) && isinf(b))) return uintBitsToFloat(0x7fc00000u);
      if (b==0.0 || isinf(a)) return uintBitsToFloat(sign | 0x7f800000u);
      if (isinf(b)) return uintBitsToFloat(sign);
      return a/b;
    }`,
    `vec4 ${prefix}_div(vec4 a, vec4 b) { return vec4(${prefix}_div1(a.x,b.x), ${prefix}_div1(a.y,b.y), ${prefix}_div1(a.z,b.z), ${prefix}_div1(a.w,b.w)); }`,
    `float ${prefix}_log1(float a) {
      if (isnan(a)) return a;
      if (a==0.0) return uintBitsToFloat(0xff800000u);
      if (a<0.0) return uintBitsToFloat(0x7fc00000u);
      if (isinf(a)) return a;
      return log2(a);
    }`,
    `vec4 ${prefix}_log(vec4 a) { return vec4(${prefix}_log1(a.x), ${prefix}_log1(a.y), ${prefix}_log1(a.z), ${prefix}_log1(a.w)); }`,
    `float ${prefix}_rsq1(float a) {
      if (isnan(a)) return a;
      if (a==0.0) return uintBitsToFloat((floatBitsToUint(a) & 0x80000000u) | 0x7f800000u);
      if (a<0.0) return uintBitsToFloat(0x7fc00000u);
      if (isinf(a)) return 0.0;
      return inversesqrt(a);
    }`,
    `vec4 ${prefix}_rsq(vec4 a) { return vec4(${prefix}_rsq1(a.x), ${prefix}_rsq1(a.y), ${prefix}_rsq1(a.z), ${prefix}_rsq1(a.w)); }`,
    `float ${prefix}_exp1(float a) { if (isnan(a)) return a; if (isinf(a)) return a<0.0 ? 0.0 : a; return exp2(a); }`,
    `vec4 ${prefix}_exp(vec4 a) { return vec4(${prefix}_exp1(a.x), ${prefix}_exp1(a.y), ${prefix}_exp1(a.z), ${prefix}_exp1(a.w)); }`,
  ];
  const pattern = new RegExp(`\\b${prefix}_([a-zA-Z0-9]+)\\(`, 'g');
  const definitions: readonly GlslHelper[] = helpers.map((source) => {
    const name = source.match(pattern)![0]!.slice(prefix.length + 1, -1);
    return {
      name,
      source,
      dependencies: [...new Set([...source.matchAll(pattern)].map((m) => m[1]!))].filter(
        (dependency) => dependency !== name,
      ),
    };
  });
  const byName = new Map(definitions.map((d) => [d.name, d])),
    masks: Record<string, number> = Object.create(null);
  function dependencies(name: string): number {
    if (masks[name] !== undefined) return masks[name];
    const definition = byName.get(name)!;
    let mask = 1 << definitions.indexOf(definition);
    for (const dependency of definition.dependencies) mask |= dependencies(dependency);
    return (masks[name] = mask);
  }
  for (const definition of definitions) dependencies(definition.name);
  const blocks = new Map<number, string>();
  function source(mask: number): string {
    const found = blocks.get(mask);
    if (found !== undefined) {
      blocks.delete(mask);
      blocks.set(mask, found);
      return found;
    }
    const text = definitions
      .filter((_, i) => mask & (1 << i))
      .map((d) => d.source)
      .join('\n');
    blocks.set(mask, text);
    if (blocks.size > 64) blocks.delete(blocks.keys().next().value!);
    return text;
  }
  return {masks, source};
}
const HELPERS = {vertex: makeHelpers('sm4_vs'), pixel: makeHelpers('sm4_ps')};

/**
 * Lower the surveyed SM4 arithmetic/2D-sample subset. Raw register words preserve moves,
 * condition bits and source sign modifiers. Backend wrappers supply stage linkage,
 * position conventions, raw constant uploads, texture formats and sampler bindings.
 */
export function translateSm4ToGlsl(program: Sm4Program): Sm4GlslProgram {
  const prefix = program.stage === 'vertex' ? 'sm4_vs' : 'sm4_ps',
    builtins = HELPERS[program.stage];
  let requiredHelpers = 0;
  const inputs = new Map<number, Sm4GlslIo[]>(),
    outputs = new Map<number, Sm4GlslIo[]>();
  const constants = new Map<number, Sm4GlslConstantBuffer>(),
    resources = new Set<number>(),
    samplers = new Set<number>();
  const samples = new Map<string, Sm4GlslSample>();
  const body: Sm4Instruction[] = [];
  let temps = 0,
    tempsDeclared = false,
    started = false;
  function io(instruction: Sm4Instruction, output: boolean, system: boolean): void {
    const operand = instruction.operands[0]!,
      r = reg(operand, output ? 2 : 1, 32),
      m = mask(operand);
    const map = output ? outputs : inputs;
    const systemValue = system ? instruction.data[0]! : 0;
    if (!uint(systemValue)) fail('system-value declaration');
    const existing = map.get(r) ?? [];
    if (existing.some((value) => (value.mask & m) !== 0))
      fail('overlapping input/output components');
    const interpolation = !output && program.stage === 'pixel' ? instruction.controls : 0;
    if (output || program.stage === 'vertex') {
      if (instruction.controls) fail('input/output declaration controls');
    } else if (interpolation < 1 || interpolation > 7) fail('input interpolation mode');
    map.set(r, [...existing, {register: r, mask: m, systemValue, interpolation}]);
  }
  for (const instruction of program.instructions) {
    if (instruction.extended.length) fail('instruction extensions');
    const operand = instruction.operands[0];
    let declaration = true;
    switch (instruction.opcode) {
      case Op.DCL_TEMPS:
        if (
          tempsDeclared ||
          instruction.controls ||
          instruction.data.length !== 1 ||
          !uint(instruction.data[0]!) ||
          instruction.data[0]! > 4096
        )
          fail('temporary declaration');
        temps = instruction.data[0]!;
        tempsDeclared = true;
        break;
      case Op.DCL_CONSTANT_BUFFER: {
        if (
          !operand ||
          operand.type !== 8 ||
          operand.indices.length !== 2 ||
          operand.extended.length ||
          instruction.controls > 1
        )
          fail('constant-buffer declaration');
        const slot = index(operand, 0),
          vectors = index(operand, 1);
        if (slot >= 14 || vectors < 1 || vectors > 4096 || constants.has(slot))
          fail('constant-buffer bounds');
        constants.set(slot, {slot, vectors, uniform: `${prefix}_cb${slot}`});
        break;
      }
      case Op.DCL_RESOURCE: {
        if (
          !operand ||
          instruction.controls !== 3 ||
          instruction.data[0] !== 0x5555 ||
          operand.extended.length
        )
          fail('non-float Texture2D declaration');
        const slot = reg(operand, 7, 128);
        if (resources.has(slot)) fail('duplicate resource');
        resources.add(slot);
        break;
      }
      case Op.DCL_SAMPLER: {
        if (!operand || instruction.controls || operand.extended.length)
          fail('non-default sampler declaration');
        const slot = reg(operand, 6, 16);
        if (samplers.has(slot)) fail('duplicate sampler');
        samplers.add(slot);
        break;
      }
      case Op.DCL_INPUT:
        if (program.stage !== 'vertex') fail('vertex input declaration in pixel stage');
        io(instruction, false, false);
        break;
      case Op.DCL_INPUT_PS:
        if (program.stage !== 'pixel') fail('pixel input declaration in vertex stage');
        io(instruction, false, false);
        break;
      case Op.DCL_INPUT_PS_SIV:
        if (program.stage !== 'pixel') fail('pixel system input declaration in vertex stage');
        io(instruction, false, true);
        break;
      case Op.DCL_OUTPUT:
        io(instruction, true, false);
        break;
      case Op.DCL_OUTPUT_SIV:
        io(instruction, true, true);
        break;
      case Op.CUSTOMDATA:
        if (instruction.customClass !== 0 && instruction.customClass !== 1)
          fail('executable or opaque custom data');
        declaration = false;
        continue;
      default:
        declaration = false;
        started = true;
        body.push(instruction);
        break;
    }
    if (declaration && started) fail('declaration after executable instruction');
  }
  if (body.length === 0 || body[body.length - 1]!.opcode !== Op.RET)
    fail('missing terminal return');

  function select(base: string, operand: Sm4Operand): string {
    if (operand.componentCount === 1) return `uvec4((${base}).x)`;
    if (operand.componentCount !== 4) fail('source component count');
    if (operand.selectionMode === 'swizzle' && operand.components.length === 4)
      return `(${base}).${operand.components.map((c) => channels[c]).join('')}`;
    if (operand.selectionMode === 'select' && operand.components.length === 1)
      return `uvec4((${base}).${channels[operand.components[0]!]})`;
    if (operand.selectionMode === 'mask' && operand.components.join(',') === '0,1,2,3') return base;
    fail('source component selection');
  }
  function source(operand: Sm4Operand): string {
    let raw: string;
    switch (operand.type) {
      case 0:
        raw = `${prefix}_r${reg(operand, 0, temps)}`;
        break;
      case 1: {
        const r = reg(operand, 1, 32);
        if (!inputs.has(r)) fail('undeclared input');
        raw = `inputRegisters[${r}]`;
        break;
      }
      case 4:
        if (
          operand.indices.length ||
          ![1, 4].includes(operand.immediate.length) ||
          operand.immediate.some((n) => !uint(n))
        )
          fail('immediate literal');
        raw = `uvec4(${operand.immediate.map(hex).join(', ')})`;
        break;
      case 8: {
        if (operand.indices.length !== 2) fail('constant-buffer source dimensions');
        const slot = index(operand, 0),
          row = index(operand, 1),
          buffer = constants.get(slot);
        if (!buffer) fail('undeclared constant buffer');
        raw = row < buffer.vectors ? `${buffer.uniform}[${row}]` : 'uvec4(0u)';
        break;
      }
      default:
        fail(`source register type ${operand.type}`);
    }
    // Immediate vectors carry their own literal order, not an operand swizzle.
    if (operand.type !== 4) raw = select(raw, operand);
    else if (operand.componentCount !== operand.immediate.length) fail('literal component count');
    if (operand.extended.length > 1) fail('operand extension chain');
    if (operand.extended.length) {
      const extension = operand.extended[0]!;
      if ((extension & ~0xff) !== 0 || (extension & 63) !== 1)
        fail('operand precision or extension type');
      switch ((extension >>> 6) & 3) {
        case 0:
          break;
        case 1:
          raw = `(${raw} ^ uvec4(0x80000000u))`;
          break;
        case 2:
          raw = `(${raw} & uvec4(0x7fffffffu))`;
          break;
        case 3:
          raw = `(${raw} | uvec4(0x80000000u))`;
          break;
      }
    }
    return raw;
  }
  function destination(operand: Sm4Operand): string {
    mask(operand);
    let base: string;
    if (operand.type === 0) base = `${prefix}_r${reg(operand, 0, temps)}`;
    else if (operand.type === 2) {
      const r = reg(operand, 2, 32);
      if (!outputs.has(r)) fail('undeclared output');
      base = `${prefix}_o${r}`;
    } else fail('destination register type');
    return `${base}.${operand.components.map((c) => channels[c]).join('')}`;
  }
  const lines: string[] = [];
  const sortedOutputs = [...outputs.values()].flat().sort((a, b) => a.register - b.register);
  const outputRegisters = [...outputs.keys()].sort((a, b) => a - b);
  for (const instruction of body) {
    const operands = instruction.operands;
    if (instruction.opcode === Op.RET) {
      if (instruction.controls) fail('return controls');
      if (program.stage === 'pixel') lines.push(`if (${prefix}_discarded) discard;`);
      for (const output of outputRegisters)
        lines.push(`outputRegisters[${output}] = ${prefix}_o${output};`);
      lines.push('return;');
      continue;
    }
    if (instruction.opcode === Op.DISCARD) {
      if (program.stage !== 'pixel' || (instruction.controls & ~128) !== 0)
        fail('discard stage or controls');
      if (
        operands[0]!.extended.length ||
        (operands[0]!.componentCount !== 1 && operands[0]!.selectionMode !== 'select')
      )
        fail('discard condition selection');
      const value = source(operands[0]!);
      lines.push(
        `${prefix}_discarded = ${prefix}_discarded || ((${value}).x ${instruction.controls & 128 ? '!=' : '=='} 0u);`,
      );
      continue;
    }
    if ((instruction.controls & ~4) !== 0) fail('arithmetic instruction controls');
    let raw: string;
    const f = (i: number) => {
      requiredHelpers |= builtins.masks.float!;
      return `${prefix}_float(${source(operands[i]!)})`;
    };
    const store = (expression: string) => {
      requiredHelpers |= builtins.masks.store!;
      return `${prefix}_store(${expression})`;
    };
    switch (instruction.opcode) {
      case Op.MOV:
        raw = source(operands[1]!);
        break;
      case Op.MOVC:
        requiredHelpers |= builtins.masks.select!;
        if (operands[1]!.extended.length) fail('conditional source modifier');
        raw = `${prefix}_select(${source(operands[3]!)}, ${source(operands[2]!)}, notEqual(${source(operands[1]!)}, uvec4(0u)))`;
        break;
      case Op.GE:
        raw = `(uvec4(greaterThanEqual(${f(1)}, ${f(2)})) * 0xffffffffu)`;
        break;
      case Op.LT:
        raw = `(uvec4(lessThan(${f(1)}, ${f(2)})) * 0xffffffffu)`;
        break;
      case Op.ADD:
        raw = store(`${f(1)} + ${f(2)}`);
        break;
      case Op.MUL:
        raw = store(`${f(1)} * ${f(2)}`);
        break;
      case Op.DIV:
        requiredHelpers |= builtins.masks.div!;
        raw = store(`${prefix}_div(${f(1)}, ${f(2)})`);
        break;
      case Op.MAD:
        raw = store(`${f(1)} * ${f(2)} + ${f(3)}`);
        break;
      case Op.MIN:
        requiredHelpers |= builtins.masks.min!;
        raw = store(`${prefix}_min(${f(1)}, ${f(2)})`);
        break;
      case Op.MAX:
        requiredHelpers |= builtins.masks.max!;
        raw = store(`${prefix}_max(${f(1)}, ${f(2)})`);
        break;
      case Op.DP3:
        raw = store(`vec4(dot((${f(1)}).xyz, (${f(2)}).xyz))`);
        break;
      case Op.DP4:
        raw = store(`vec4(dot(${f(1)}, ${f(2)}))`);
        break;
      case Op.EXP:
        requiredHelpers |= builtins.masks.exp!;
        raw = store(`${prefix}_exp(${f(1)})`);
        break;
      case Op.LOG:
        requiredHelpers |= builtins.masks.log!;
        raw = store(`${prefix}_log(${f(1)})`);
        break;
      case Op.ROUND_NI:
        raw = store(`floor(${f(1)})`);
        break;
      case Op.RSQ:
        requiredHelpers |= builtins.masks.rsq!;
        raw = store(`${prefix}_rsq(${f(1)})`);
        break;
      case Op.SAMPLE: {
        if (program.stage !== 'pixel') fail('implicit sample outside pixel stage');
        const resource = reg(operands[2]!, 7, 128),
          sampler = reg(operands[3]!, 6, 16);
        if (
          !resources.has(resource) ||
          !samplers.has(sampler) ||
          operands[2]!.extended.length ||
          operands[3]!.extended.length
        )
          fail('sample bindings');
        const id = `${resource}_${sampler}`,
          uniform = `${prefix}_t${resource}_s${sampler}`;
        samples.set(id, {resource, sampler, uniform});
        // `<uniform>_view` and `<uniform>_coord` are identities unless linkage
        // selects another view.
        raw = select(
          `floatBitsToUint(${uniform}_view(texture(${uniform}, ${uniform}_coord((${f(1)}).xy))))`,
          operands[2]!,
        );
        break;
      }
      default:
        fail(`opcode ${instruction.opcode}`);
    }
    if (instruction.controls & 4) {
      requiredHelpers |= builtins.masks.sat!;
      raw = `floatBitsToUint(${prefix}_sat(uintBitsToFloat(${raw})))`;
    }
    const dest = destination(operands[0]!),
      swizzle = operands[0]!.components.map((c) => channels[c]).join('');
    lines.push(`{ uvec4 value = ${raw}; ${dest} = value.${swizzle}; }`);
  }
  const cb = [...constants.values()].sort((a, b) => a.slot - b.slot),
    sampleBindings = [...samples.values()];
  const declarations = cb.map((b) => `uniform highp uvec4 ${b.uniform}[${b.vectors}];`);
  declarations.push(...sampleBindings.map((s) => `uniform highp sampler2D ${s.uniform};`));
  for (const s of sampleBindings)
    declarations.push(
      `#ifndef ${s.uniform}_view`,
      `#define ${s.uniform}_view(t) t`,
      '#endif',
      `#ifndef ${s.uniform}_coord`,
      `#define ${s.uniform}_coord(c) c`,
      '#endif',
    );

  // Arrays end at the highest declared register: every access uses a declared
  // immediate index, and full32-entry arrays exhaust GPU registers.
  const inputCount = Math.max(0, ...inputs.keys()) + 1,
    outputCount = Math.max(0, ...outputs.keys()) + 1;
  const init: string[] = [`for (int i=0; i<${outputCount}; i++) outputRegisters[i] = uvec4(0u);`];
  if (program.stage === 'pixel') init.push(`bool ${prefix}_discarded = false;`);
  for (let i = 0; i < temps; i++) init.push(`uvec4 ${prefix}_r${i} = uvec4(0u);`);
  for (const output of outputRegisters) init.push(`uvec4 ${prefix}_o${output} = uvec4(0u);`);
  const sourceText = [
    ...declarations,
    ...(requiredHelpers ? [builtins.source(requiredHelpers)] : []),
    `void ${prefix}(in uvec4 inputRegisters[${inputCount}], out uvec4 outputRegisters[${outputCount}]) {`,
    ...init,
    ...lines,
    '}',
    '',
  ].join('\n');
  return {
    stage: program.stage,
    source: sourceText,
    entry: prefix,
    inputRegisters: inputCount,
    outputRegisters: outputCount,
    inputs: [...inputs.values()].flat().sort((a, b) => a.register - b.register),
    outputs: sortedOutputs,
    constantBuffers: cb,
    samples: sampleBindings,
  };
}
