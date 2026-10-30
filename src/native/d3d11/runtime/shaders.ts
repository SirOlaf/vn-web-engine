import {
  parseSm4GlslShader,
  Sm4ShaderError,
  type Sm4GlslShader,
} from '../../../graphics/d3d11-shader/program.js';
import type {
  D3d11Result,
  ID3D11ClassLinkage,
  ID3D11VertexShader,
  ID3D11PixelShader,
} from '../contract.js';
import {D3d11ChildObject, type D3d11DeviceOwner} from './com.js';

const INVALID = 0x80070057 | 0,
  NOT_IMPLEMENTED = 0x80004001 | 0;
const interfaces = {
  vertex: '3b301d64-d678-4289-8897-22f8928b72f3',
  pixel: 'ea82e40d-51dc-4f33-93d4-db7c9125ae8c',
};

/** Owned immutable shader plan. Public clients see only the native device-child interface. */
export class D3d11Shader extends D3d11ChildObject implements ID3D11VertexShader, ID3D11PixelShader {
  constructor(
    owner: D3d11DeviceOwner,
    readonly shader: Sm4GlslShader,
  ) {
    super(owner, [interfaces[shader.code.stage]], () => {});
  }
}

/** SM4 float-register shaders; dynamic class linkage belongs to a later shader model. */
export function createShaderStorage(
  owner: D3d11DeviceOwner,
  stage: 'vertex' | 'pixel',
  bytecode: Uint8Array,
  classLinkage: ID3D11ClassLinkage | null,
  validateOnly = false,
): D3d11Result<D3d11Shader> {
  if (owner.lifetime.closed) return {hr: INVALID, value: null};
  if (classLinkage !== null) return {hr: NOT_IMPLEMENTED, value: null};
  let shader: Sm4GlslShader;
  try {
    shader = parseSm4GlslShader(bytecode, stage);
  } catch (error) {
    return {
      hr: error instanceof Sm4ShaderError && error.unsupported ? NOT_IMPLEMENTED : INVALID,
      value: null,
    };
  }
  return validateOnly ? {hr: 1, value: null} : {hr: 0, value: new D3d11Shader(owner, shader)};
}
