import {ByteView, ascii} from '../../core/binary.js';

/** Flat float type in a shader-model-4 RDEF record; enum values follow D3D_SHADER_VARIABLE_CLASS. */
export interface Sm4ConstantType {
  readonly variableClass: number;
  readonly rows: number;
  readonly columns: number;
}
export interface Sm4ConstantVariable {
  readonly name: string;
  readonly offset: number;
  readonly bytes: number;
  readonly flags: number;
  readonly type: Sm4ConstantType;
  /** Borrowed immutable bytes, or null when the compiler supplied no default. */
  readonly defaultValue: Uint8Array | null;
}
export interface Sm4ConstantBuffer {
  readonly name: string;
  readonly bytes: number;
  readonly flags: number;
  readonly bufferType: number;
  /** Null for a reflected buffer with no bound resource. */
  readonly slot: number | null;
  readonly variables: readonly Sm4ConstantVariable[];
}
export interface Sm4ResourceBinding {
  readonly name: string;
  readonly inputType: number;
  readonly returnType: number;
  readonly dimension: number;
  readonly samples: number;
  readonly slot: number;
  readonly count: number;
  readonly flags: number;
}
export interface Sm4Reflection {
  readonly stage: 'vertex' | 'pixel';
  readonly flags: number;
  readonly creator: string;
  readonly buffers: readonly Sm4ConstantBuffer[];
  readonly resources: readonly Sm4ResourceBinding[];
}

/**
 * Read an SM4.0 RDEF payload, including byte offsets rather than inferred register
 * positions. This subset covers flat float scalars, vectors and matrices. Arrays,
 * structures, other scalar types and other profiles are explicitly unsupported.
 * No compiler, native reflection DLL or GPU context is needed.
 */
export function parseSm4Reflection(bytes: Uint8Array): Sm4Reflection {
  const v = new ByteView(bytes, {littleEndian: true});
  v.check(0, 28);
  const profile = v.u32(16);
  if (profile !== 0xfffe0400 && profile !== 0xffff0400)
    throw new Error('Unsupported RDEF shader profile');
  const string = (offset: number): string => {
    v.check(offset, 1);
    if (offset < 28) throw new Error('RDEF string overlaps header');
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end - offset > 4096) throw new Error('Invalid RDEF string');
    return ascii(bytes, offset, end - offset);
  };
  const table = (offset: number, count: number, stride: number, limit: number) => {
    if (count > limit) throw new Error('RDEF record count exceeds limit');
    if (count && offset < 28) throw new Error('RDEF table overlaps header');
    v.check(offset, count * stride);
  };
  const bufferCount = v.u32(0),
    bufferOffset = v.u32(4),
    resourceCount = v.u32(8),
    resourceOffset = v.u32(12);
  table(bufferOffset, bufferCount, 24, 14);
  table(resourceOffset, resourceCount, 32, 256);
  const resources: Sm4ResourceBinding[] = [],
    names = new Set<string>();
  for (let i = 0; i < resourceCount; i++) {
    const at = resourceOffset + i * 32,
      name = string(v.u32(at)),
      inputType = v.u32(at + 4),
      slot = v.u32(at + 20),
      count = v.u32(at + 24),
      limit = inputType === 0 ? 14 : inputType === 3 ? 16 : 128;
    if (inputType > 3 || count < 1 || slot + count > limit || names.has(name))
      throw new Error('Unsupported or invalid RDEF resource binding');
    names.add(name);
    resources.push({
      name,
      inputType,
      returnType: v.u32(at + 8),
      dimension: v.u32(at + 12),
      samples: v.u32(at + 16),
      slot,
      count,
      flags: v.u32(at + 28),
    });
  }
  const buffers: Sm4ConstantBuffer[] = [];
  names.clear();
  let variableCount = 0;
  for (let i = 0; i < bufferCount; i++) {
    const at = bufferOffset + i * 24,
      name = string(v.u32(at)),
      count = v.u32(at + 4),
      variablesOffset = v.u32(at + 8),
      size = v.u32(at + 12),
      bufferType = v.u32(at + 20),
      binding = resources.find((r) => r.name === name && r.inputType === bufferType);
    if (size < 16 || size > 65536 || size % 16 || bufferType > 1 || names.has(name))
      throw new Error('Unsupported or invalid RDEF constant buffer');
    if (binding && binding.count !== 1) throw new Error('Unsupported RDEF buffer array');
    names.add(name);
    variableCount += count;
    if (variableCount > 4096) throw new Error('RDEF variable count exceeds limit');
    table(variablesOffset, count, 24, 4096);
    const variables: Sm4ConstantVariable[] = [],
      variableNames = new Set<string>();
    for (let j = 0; j < count; j++) {
      const entry = variablesOffset + j * 24,
        variableName = string(v.u32(entry)),
        offset = v.u32(entry + 4),
        length = v.u32(entry + 8),
        typeOffset = v.u32(entry + 16),
        defaultOffset = v.u32(entry + 20);
      if (!length || offset + length > size || variableNames.has(variableName))
        throw new Error('Invalid RDEF variable span or name');
      variableNames.add(variableName);
      v.check(typeOffset, 16);
      if (typeOffset < 28) throw new Error('RDEF type overlaps header');
      const variableClass = v.u16(typeOffset),
        scalarType = v.u16(typeOffset + 2),
        rows = v.u16(typeOffset + 4),
        columns = v.u16(typeOffset + 6);
      if (
        scalarType !== 3 ||
        variableClass > 3 ||
        !rows ||
        rows > 4 ||
        !columns ||
        columns > 4 ||
        v.u16(typeOffset + 8) ||
        v.u16(typeOffset + 10) ||
        (variableClass === 0 && (rows !== 1 || columns !== 1)) ||
        (variableClass === 1 && rows !== 1)
      )
        throw new Error('Unsupported or invalid RDEF constant type');
      if (defaultOffset) {
        if (defaultOffset < 28) throw new Error('RDEF default overlaps header');
        v.check(defaultOffset, length);
      }
      variables.push({
        name: variableName,
        offset,
        bytes: length,
        flags: v.u32(entry + 12),
        type: {variableClass, rows, columns},
        defaultValue: defaultOffset ? bytes.subarray(defaultOffset, defaultOffset + length) : null,
      });
    }
    buffers.push({
      name,
      bytes: size,
      flags: v.u32(at + 16),
      bufferType,
      slot: binding?.slot ?? null,
      variables,
    });
  }
  return {
    stage: profile === 0xfffe0400 ? 'vertex' : 'pixel',
    flags: v.u32(20),
    creator: string(v.u32(24)),
    buffers,
    resources,
  };
}
