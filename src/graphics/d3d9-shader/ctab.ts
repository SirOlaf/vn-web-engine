/** D3DX constant table (the `CTAB` comment of compiled D3D9 shaders). */

/** D3DXREGISTER_SET. */
export const RegisterSet = {BOOL: 0, INT4: 1, FLOAT4: 2, SAMPLER: 3} as const;
export const registerSetNames = ['bool', 'int4', 'float4', 'sampler'];

/** D3DXPARAMETER_CLASS. */
export const parameterClassNames = [
  'scalar',
  'vector',
  'matrix_rows',
  'matrix_columns',
  'object',
  'struct',
];

/** D3DXPARAMETER_TYPE. */
export const parameterTypeNames = [
  'void',
  'bool',
  'int',
  'float',
  'string',
  'texture',
  'texture1d',
  'texture2d',
  'texture3d',
  'texturecube',
  'sampler',
  'sampler1d',
  'sampler2d',
  'sampler3d',
  'samplercube',
  'pixelshader',
  'vertexshader',
  'pixelfragment',
  'vertexfragment',
  'unsupported',
];

export interface D3D9ConstantType {
  class: number;
  type: number;
  rows: number;
  columns: number;
  elements: number;
  members: {name: string; type: D3D9ConstantType}[];
}

export interface D3D9Constant {
  name: string;
  registerSet: number;
  registerIndex: number;
  registerCount: number;
  type: D3D9ConstantType;
  /** Raw default value bytes (registerCount × 16) when the table carries one. */
  defaultValue?: Uint8Array;
}

export interface D3D9ConstantTable {
  creator: string;
  /** Shader version token recorded in the table. */
  version: number;
  target: string;
  flags: number;
  constants: D3D9Constant[];
}

/** Parse CTAB data (the bytes after the `CTAB` FourCC; offsets are relative to it). */
export function parseConstantTable(data: Uint8Array): D3D9ConstantTable {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const check = (offset: number, size: number): number => {
    if (offset < 0 || offset + size > data.byteLength) throw new Error('Truncated D3D9 CTAB');
    return offset;
  };
  const u32 = (o: number) => view.getUint32(check(o, 4), true),
    u16 = (o: number) => view.getUint16(check(o, 2), true);
  const string = (offset: number): string => {
    check(offset, 1);
    let end = offset;
    while (end < data.byteLength && data[end] !== 0) end++;
    if (end >= data.byteLength) throw new Error('Unterminated D3D9 CTAB string');
    return new TextDecoder('latin1').decode(data.subarray(offset, end));
  };
  if (u32(0) < 28) throw new Error('Invalid D3D9 CTAB header size');
  const creator = string(u32(4)),
    version = u32(8),
    count = u32(12),
    infoOffset = u32(16),
    flags = u32(20),
    target = string(u32(24));
  if (count > 4096) throw new Error('D3D9 CTAB constant count exceeds limit');
  let typeBudget = 4096;
  const readType = (offset: number, depth: number): D3D9ConstantType => {
    if (depth > 8 || --typeBudget < 0) throw new Error('D3D9 CTAB type nesting exceeds limit');
    const type: D3D9ConstantType = {
      class: u16(offset),
      type: u16(offset + 2),
      rows: u16(offset + 4),
      columns: u16(offset + 6),
      elements: u16(offset + 8),
      members: [],
    };
    const memberCount = u16(offset + 10),
      memberOffset = u32(offset + 12);
    for (let i = 0; i < memberCount; i++) {
      const m = memberOffset + i * 8;
      type.members.push({name: string(u32(m)), type: readType(u32(m + 4), depth + 1)});
    }
    return type;
  };
  const constants: D3D9Constant[] = [];
  for (let i = 0; i < count; i++) {
    const p = check(infoOffset + i * 20, 20);
    const constant: D3D9Constant = {
      name: string(u32(p)),
      registerSet: u16(p + 4),
      registerIndex: u16(p + 6),
      registerCount: u16(p + 8),
      type: readType(u32(p + 12), 0),
    };
    const defaultOffset = u32(p + 16);
    if (defaultOffset) {
      const size = constant.registerCount * 16;
      constant.defaultValue = data.subarray(check(defaultOffset, size), defaultOffset + size);
    }
    constants.push(constant);
  }
  return {creator, version, target, flags, constants};
}

/** Short HLSL-like type description, e.g. `float4x4`, `float4[2]`, `sampler2D`. */
export function describeConstantType(type: D3D9ConstantType): string {
  let base: string;
  const scalar = parameterTypeNames[type.type] ?? `type${type.type}`;
  if (type.class === 0) base = scalar;
  else if (type.class === 1) base = `${scalar}${type.columns}`;
  else if (type.class === 2 || type.class === 3)
    base = `${type.class === 3 ? 'column_major ' : 'row_major '}${scalar}${type.rows}x${type.columns}`;
  else if (type.class === 5) base = `struct{${type.members.map((m) => m.name).join(',')}}`;
  else base = scalar.replace(/^sampler(\w+)$/, (_, d: string) => `sampler${d.toUpperCase()}`);
  return type.elements > 1 ? `${base}[${type.elements}]` : base;
}
