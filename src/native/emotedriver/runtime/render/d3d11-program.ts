import type {
  D3d11InputElementDesc,
  D3d11Result,
  ID3D11Buffer,
  ID3D11Device,
  ID3D11DeviceContext,
  ID3D11InputLayout,
  ID3D11PixelShader,
  ID3D11VertexShader,
  IUnknown,
} from '../../../d3d11/contract.js';
import type {Sm4Reflection} from '../../../../graphics/d3d11-shader/reflection.js';

interface ConstantBuffer {
  readonly resource: ID3D11Buffer;
  readonly bytes: Uint8Array;
  readonly view: DataView;
  dirty: boolean;
}
interface Parameter {
  readonly buffer: ConstantBuffer;
  readonly offset: number;
  readonly bytes: number;
}

/**
 * Private x64 MShaderProgram/vertex/pixel resource owner (0x180064410..0x1800651e0).
 * Native D3D11 interfaces own the executable resources; RDEF supplies byte spans.
 * All writes stay in CPU shadows until bind, which uploads dirty buffers before use.
 */
export class EmoteD3d11Program {
  private readonly owned: IUnknown[] = [];
  private readonly buffers: ConstantBuffer[] = [];
  private readonly bindings: (ID3D11Buffer | null)[] = [];
  private readonly parameters = new Map<string, Map<string, Parameter>>();
  private readonly vertex: ID3D11VertexShader | null;
  private readonly pixel: ID3D11PixelShader | null;
  private readonly layout: ID3D11InputLayout | null;
  private closed = false;

  constructor(
    device: ID3D11Device,
    bytecode: Uint8Array,
    reflection: Sm4Reflection,
    inputLayout: readonly D3d11InputElementDesc[] | null,
  ) {
    if ((reflection.stage === 'vertex') !== (inputLayout !== null))
      throw new TypeError('E-mote vertex programs require an input layout');
    try {
      for (const source of reflection.buffers) {
        if (source.bufferType !== 0 || source.slot === null)
          throw new Error('E-mote shader requires a bound native constant buffer');
        const bytes = new Uint8Array(source.bytes),
          resource = this.take(
            device.createBuffer(
              {
                byteWidth: source.bytes,
                usage: 0,
                bindFlags: 4,
                cpuAccessFlags: 0,
                miscFlags: 0,
                structureByteStride: 0,
              },
              null,
            ),
          ),
          buffer: ConstantBuffer = {
            resource,
            bytes,
            view: new DataView(bytes.buffer),
            dirty: false,
          },
          variables = new Map<string, Parameter>();
        this.buffers.push(buffer);
        while (this.bindings.length <= source.slot) this.bindings.push(null);
        this.bindings[source.slot] = resource;
        for (const variable of source.variables)
          variables.set(variable.name, {buffer, offset: variable.offset, bytes: variable.bytes});
        this.parameters.set(source.name, variables);
      }
      if (inputLayout !== null) {
        this.layout = this.take(device.createInputLayout(inputLayout, bytecode));
        this.vertex = this.take(device.createVertexShader(bytecode, null));
        this.pixel = null;
      } else {
        this.layout = null;
        this.vertex = null;
        this.pixel = this.take(device.createPixelShader(bytecode, null));
      }
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'E-mote program construction and cleanup failed',
        );
      }
      throw error;
    }
  }

  /** Native parameter lookup defaults to $Globals (0x180064d90); a missing name is a no-op. */
  setRaw(name: string, data: Uint8Array, buffer = '$Globals'): boolean {
    const parameter = this.parameter(name, buffer);
    if (!parameter) return false;
    if (data.length > parameter.bytes)
      throw new RangeError('E-mote constant write exceeds variable');
    if (data.length) {
      parameter.buffer.bytes.set(data, parameter.offset);
      parameter.buffer.dirty = true;
    }
    return true;
  }

  /** Float32 stores into the native byte span; matrix values keep the caller's native order. */
  setFloats(name: string, values: ArrayLike<number>, buffer = '$Globals'): boolean {
    const parameter = this.parameter(name, buffer);
    if (!parameter) return false;
    if (
      !Number.isSafeInteger(values.length) ||
      values.length < 0 ||
      values.length * 4 > parameter.bytes
    )
      throw new RangeError('E-mote float write exceeds variable');
    for (let i = 0; i < values.length; i++)
      parameter.buffer.view.setFloat32(parameter.offset + i * 4, values[i]!, true);
    if (values.length) parameter.buffer.dirty = true;
    return true;
  }

  /** 0x180064f90 uploads only dirty shadows; stage helpers select shaders/layout and buffers. */
  bind(context: ID3D11DeviceContext): void {
    this.live();
    for (const buffer of this.buffers)
      if (buffer.dirty) {
        context.updateSubresource(buffer.resource, 0, null, buffer.bytes, 0, 0);
        buffer.dirty = false;
      }
    if (this.vertex) {
      context.vsSetShader(this.vertex, []);
      context.iaSetInputLayout(this.layout);
      if (this.bindings.length) context.vsSetConstantBuffers(0, this.bindings);
    } else {
      context.psSetShader(this.pixel, []);
      if (this.bindings.length) context.psSetConstantBuffers(0, this.bindings);
    }
  }

  /** Release owned references; context bindings retain their separate native references. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const resource of this.owned.splice(0).reverse())
      try {
        resource.release();
      } catch (error) {
        errors.push(error);
      }
    this.parameters.clear();
    this.buffers.length = this.bindings.length = 0;
    if (errors.length)
      throw new AggregateError(errors, 'E-mote shader resources failed to release');
  }

  private take<T extends IUnknown>(result: D3d11Result<T>): T {
    if (result.hr < 0 || result.value === null) {
      // A failed COM factory must not publish a resource, but release a malformed host's
      // output too so construction cannot leak a partially returned reference.
      if (result.value) this.owned.push(result.value);
      throw new Error('E-mote D3D11 resource creation failed: 0x' + (result.hr >>> 0).toString(16));
    }
    this.owned.push(result.value);
    return result.value;
  }
  private parameter(name: string, buffer: string): Parameter | undefined {
    this.live();
    return this.parameters.get(buffer)?.get(name);
  }
  private live(): void {
    if (this.closed) throw new Error('E-mote shader program is released');
  }
}
