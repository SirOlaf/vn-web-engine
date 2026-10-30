import {ByteView} from '../../core/binary.js';

/** The serialized D3D10 signature record used by SM4 ISGN/OSGN parts. */
export interface Sm4SignatureParameter {
  readonly semanticName: string;
  readonly semanticIndex: number;
  /** Serialized D3D_NAME value, before any backend-specific conversion. */
  readonly systemValue: number;
  /** D3D_REGISTER_COMPONENT_TYPE. */
  readonly componentType: number;
  readonly register: number;
  readonly mask: number;
  /** Always-reads for an input signature, never-writes for an output signature. */
  readonly readWriteMask: number;
}

/** Read an ISGN/OSGN payload; newer signature record layouts require a separate reader. */
export function parseSm4Signature(bytes: Uint8Array): readonly Sm4SignatureParameter[] {
  const v = new ByteView(bytes, {littleEndian: true});
  v.check(0, 8);
  const count = v.u32(0),
    offset = v.u32(4);
  if (count > 4096) throw new Error('SM4 signature count exceeds allocation limit');
  if (count === 0) return [];
  if (offset < 8) throw new Error('SM4 signature parameters overlap the header');
  v.check(offset, count * 24);
  const parameters: Sm4SignatureParameter[] = [];
  let previousRegister = 0;
  for (let i = 0; i < count; i++) {
    const p = offset + i * 24,
      name = v.u32(p),
      register = v.u32(p + 16);
    v.check(name, 1);
    const length = bytes.subarray(name, Math.min(name + 4097, bytes.length)).indexOf(0);
    if (length < 0) throw new Error('Invalid or oversized SM4 semantic name');
    if (register < previousRegister) throw new Error('Unordered SM4 signature registers');
    previousRegister = register;
    const mask = v.u8(p + 20),
      readWriteMask = v.u8(p + 21);
    if (((mask | readWriteMask) & ~15) !== 0)
      throw new Error('Invalid SM4 signature component mask');
    parameters.push({
      semanticName: v.ascii(name, length),
      semanticIndex: v.u32(p + 4),
      systemValue: v.u32(p + 8),
      componentType: v.u32(p + 12),
      register,
      mask,
      readWriteMask,
    });
  }
  return parameters;
}
