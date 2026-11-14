import {
  comparisonNames,
  declUsageNames,
  DEFAULT_SWIZZLE,
  MiscRegister,
  Opcode,
  opcodeName,
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
  type D3D9ShaderVersion,
  type D3D9SourceParameter,
} from './bytecode.js';
import {describeConstantType} from './ctab.js';

const components = 'xyzw';

/** fxc-style register name, e.g. `r0`, `c12`, `oPos`, `vFace`, `o3` (vs_3_0) or `oT3`. */
export function registerName(version: D3D9ShaderVersion, type: number, index: number): string {
  switch (type) {
    case RegisterType.TEMP:
      return `r${index}`;
    case RegisterType.INPUT:
      return `v${index}`;
    case RegisterType.CONST:
      return `c${index}`;
    case RegisterType.CONST2:
      return `c${index + 2048}`;
    case RegisterType.CONST3:
      return `c${index + 4096}`;
    case RegisterType.CONST4:
      return `c${index + 6144}`;
    case RegisterType.ADDR_TEXTURE:
      return version.stage === 'vertex' ? `a${index}` : `t${index}`;
    case RegisterType.RASTOUT:
      return (['oPos', 'oFog', 'oPts'][index] ?? `oRast${index}`) as string;
    case RegisterType.ATTROUT:
      return `oD${index}`;
    case RegisterType.TEXCRDOUT_OUTPUT:
      return version.major >= 3 ? `o${index}` : `oT${index}`;
    case RegisterType.CONSTINT:
      return `i${index}`;
    case RegisterType.COLOROUT:
      return `oC${index}`;
    case RegisterType.DEPTHOUT:
      return 'oDepth';
    case RegisterType.SAMPLER:
      return `s${index}`;
    case RegisterType.CONSTBOOL:
      return `b${index}`;
    case RegisterType.LOOP:
      return 'aL';
    case RegisterType.TEMPFLOAT16:
      return `half${index}`;
    case RegisterType.MISCTYPE:
      return index === MiscRegister.POSITION
        ? 'vPos'
        : index === MiscRegister.FACE
          ? 'vFace'
          : `misc${index}`;
    case RegisterType.LABEL:
      return `l${index}`;
    case RegisterType.PREDICATE:
      return `p${index}`;
    default:
      return `reg${type}_${index}`;
  }
}

/** Swizzle text; fxc drops `.xyzw` and repeated trailing components (`.xyy` → `.xy`). */
export function swizzleText(swizzle: number): string {
  if (swizzle === DEFAULT_SWIZZLE) return '';
  const c = [0, 1, 2, 3].map((i) => (swizzle >>> (i * 2)) & 3);
  let length = 4;
  while (length > 1 && c[length - 1] === c[length - 2]) length--;
  return (
    '.' +
    c
      .slice(0, length)
      .map((i) => components[i])
      .join('')
  );
}

export function writeMaskText(mask: number): string {
  if (mask === 0xf) return '';
  let text = '.';
  for (let i = 0; i < 4; i++) if (mask & (1 << i)) text += components[i];
  return text;
}

function relativeText(version: D3D9ShaderVersion, relative: D3D9RelativeAddress): string {
  const base = registerName(version, relative.type, relative.index);
  return relative.type === RegisterType.LOOP ? base : `${base}.${components[relative.component]}`;
}

function destinationText(version: D3D9ShaderVersion, d: D3D9DestinationParameter): string {
  let text = registerName(version, d.type, d.index);
  if (d.relative) text += `[${relativeText(version, d.relative)}]`;
  return text + writeMaskText(d.writeMask);
}

export function sourceText(version: D3D9ShaderVersion, s: D3D9SourceParameter): string {
  let text = registerName(version, s.type, s.index);
  if (s.relative) text += `[${relativeText(version, s.relative)}]`;
  const swizzle = swizzleText(s.swizzle);
  switch (s.modifier) {
    case SourceModifier.NONE:
      return text + swizzle;
    case SourceModifier.NEG:
      return `-${text}${swizzle}`;
    case SourceModifier.BIAS:
      return `${text}_bias${swizzle}`;
    case SourceModifier.BIASNEG:
      return `-${text}_bias${swizzle}`;
    case SourceModifier.SIGN:
      return `${text}_bx2${swizzle}`;
    case SourceModifier.SIGNNEG:
      return `-${text}_bx2${swizzle}`;
    case SourceModifier.COMP:
      return `1 - ${text}${swizzle}`;
    case SourceModifier.X2:
      return `${text}_x2${swizzle}`;
    case SourceModifier.X2NEG:
      return `-${text}_x2${swizzle}`;
    case SourceModifier.DZ:
      return `${text}_dz${swizzle}`;
    case SourceModifier.DW:
      return `${text}_dw${swizzle}`;
    case SourceModifier.ABS:
      return `${text}_abs${swizzle}`;
    case SourceModifier.ABSNEG:
      return `-${text}_abs${swizzle}`;
    case SourceModifier.NOT:
      return `!${text}${swizzle}`;
    default:
      return `${text}_mod${s.modifier}${swizzle}`;
  }
}

/** Float text close to fxc's `%g`-style output, exact for float32. */
export function floatText(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Inf' : '-Inf';
  for (let precision = 1; precision <= 9; precision++) {
    const text = value.toPrecision(precision);
    if (Math.fround(Number(text)) === value) return String(Number(text));
  }
  return String(value);
}

export function instructionMnemonic(version: D3D9ShaderVersion, ins: D3D9Instruction): string {
  let name = opcodeName(ins.opcode);
  if (ins.opcode === Opcode.TEX) {
    if (ins.control === TexldControl.PROJECT) name = 'texldp';
    else if (ins.control === TexldControl.BIAS) name = 'texldb';
  } else if (ins.opcode === Opcode.IFC || ins.opcode === Opcode.BREAKC) {
    name = `${ins.opcode === Opcode.IFC ? 'if' : 'break'}_${comparisonNames[ins.control & 7]}`;
  } else if (ins.opcode === Opcode.SETP) {
    name = `setp_${comparisonNames[ins.control & 7]}`;
  } else if (ins.opcode === Opcode.DCL && ins.declaration && ins.destination) {
    const d = ins.declaration,
      t = ins.destination.type;
    if (t === RegisterType.SAMPLER) {
      name =
        d.samplerType === SamplerType.TEX_2D
          ? 'dcl_2d'
          : d.samplerType === SamplerType.CUBE
            ? 'dcl_cube'
            : d.samplerType === SamplerType.VOLUME
              ? 'dcl_volume'
              : 'dcl';
    } else if (
      t === RegisterType.MISCTYPE ||
      (version.stage === 'pixel' && version.major < 3) ||
      (version.stage === 'vertex' && t !== RegisterType.INPUT && version.major < 3)
    ) {
      name = 'dcl';
    } else {
      name = `dcl_${declUsageNames[d.usage] ?? `usage${d.usage}`}${d.usageIndex || ''}`;
    }
  }
  const m = ins.destination?.modifiers ?? 0;
  if (m & ResultModifier.SATURATE) name += '_sat';
  if (m & ResultModifier.PARTIAL_PRECISION) name += '_pp';
  if (m & ResultModifier.CENTROID) name += '_centroid';
  return name;
}

export function disassembleInstruction(version: D3D9ShaderVersion, ins: D3D9Instruction): string {
  const operands: string[] = [];
  if (ins.destination) operands.push(destinationText(version, ins.destination));
  if (ins.floatValues) operands.push(...ins.floatValues.map(floatText));
  else if (ins.intValues) operands.push(...ins.intValues.map(String));
  else if (ins.boolValue !== undefined) operands.push(ins.boolValue ? 'true' : 'false');
  for (const s of ins.sources) operands.push(sourceText(version, s));
  const predicate = ins.predicate ? `(${sourceText(version, ins.predicate)}) ` : '';
  const coissue = ins.coissue ? '+' : '';
  const mnemonic = instructionMnemonic(version, ins);
  return `${coissue}${predicate}${mnemonic}${operands.length ? ' ' + operands.join(', ') : ''}`;
}

/** fxc-style listing: constant-table comment block, version line, one instruction per line. */
export function disassembleD3D9Shader(shader: D3D9Shader): string {
  const lines: string[] = [];
  const table = shader.constantTable;
  if (table) {
    lines.push(`// Generated by ${table.creator}`, '//');
    if (table.constants.length) {
      lines.push('// Parameters:', '//');
      for (const c of table.constants)
        lines.push(`//   ${describeConstantType(c.type)} ${c.name};`);
      lines.push('//', '//', '// Registers:', '//');
      const prefix = ['b', 'i', 'c', 's'];
      const rows = table.constants
        .slice()
        .sort((a, b) => a.registerSet - b.registerSet || a.registerIndex - b.registerIndex)
        .map((c) => [
          c.name,
          `${prefix[c.registerSet] ?? '?'}${c.registerIndex}`,
          String(c.registerCount),
        ]);
      const width = rows.reduce((w, r) => Math.max(w, r[0]!.length), 4);
      lines.push(`//   ${'Name'.padEnd(width)} Reg   Size`);
      lines.push(`//   ${'-'.repeat(width)} ----- ----`);
      for (const [name, reg, size] of rows)
        lines.push(`//   ${name!.padEnd(width)} ${reg!.padEnd(5)} ${size!.padStart(4)}`);
      lines.push('//');
    }
    lines.push('');
  }
  lines.push(`    ${versionName(shader.version)}`);
  let indent = 0;
  for (const ins of shader.instructions) {
    if (
      ins.opcode === Opcode.ENDIF ||
      ins.opcode === Opcode.ENDLOOP ||
      ins.opcode === Opcode.ENDREP ||
      ins.opcode === Opcode.ELSE
    )
      indent = Math.max(0, indent - 1);
    lines.push(`    ${'  '.repeat(indent)}${disassembleInstruction(shader.version, ins)}`);
    if (
      ins.opcode === Opcode.IF ||
      ins.opcode === Opcode.IFC ||
      ins.opcode === Opcode.LOOP ||
      ins.opcode === Opcode.REP ||
      ins.opcode === Opcode.ELSE
    )
      indent++;
  }
  const count = shader.instructions.filter(
    (i) =>
      i.opcode !== Opcode.DCL &&
      i.opcode !== Opcode.DEF &&
      i.opcode !== Opcode.DEFI &&
      i.opcode !== Opcode.DEFB,
  ).length;
  lines.push('', `// ${count} instruction${count === 1 ? '' : 's'} (excluding dcl/def)`);
  return lines.join('\n') + '\n';
}
