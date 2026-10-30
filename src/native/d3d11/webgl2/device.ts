import {dxgiLayout} from '../../../graphics/dxgi-layout.js';
import type {
  D3d11BlendDesc,
  D3d11BufferDesc,
  D3d11DepthStencilDesc,
  D3d11DepthStencilViewDesc,
  D3d11InputElementDesc,
  D3d11RasterizerDesc,
  D3d11RenderTargetViewDesc,
  D3d11Result,
  D3d11SamplerDesc,
  D3d11ShaderResourceViewDesc,
  D3d11SubresourceData,
  D3d11Texture2DDesc,
  ID3D11ClassLinkage,
  ID3D11Device,
  ID3D11Resource,
  ID3D11Texture2D,
} from '../contract.js';
import {D3d11Lifetime, D3d11Object} from '../runtime/com.js';
import {createInputLayoutStorage} from '../runtime/input-layout.js';
import {
  createBufferStorage,
  createTexture2DStorage,
  type D3d11ResourceOwner,
  D3d11Texture2D,
} from '../runtime/resources.js';
import {createShaderStorage} from '../runtime/shaders.js';
import {D3d11StateCache} from '../runtime/states.js';
import {
  createDepthStencilViewStorage,
  createRenderTargetViewStorage,
  createShaderResourceViewStorage,
} from '../runtime/views.js';
import {D3d11DrawContext} from './context.js';
import {D3d11GpuOutput} from './output.js';
import {D3d11GpuSamplers} from './samplers.js';
import {D3d11ProgramCache} from './shaders.js';
import {D3d11GpuTextures, D3d11TextureError} from './textures.js';
import type {D3d11WebGl2TextureLease, D3d11WebGl2TextureSharing} from './shared-texture.js';

function attemptAll(actions: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const action of actions)
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, 'D3D11 device cleanup failed');
}

/** Real device/child lifetime and factories over the native immediate-context implementation. */
export class WebGl2D3d11Device
  extends D3d11Object
  implements ID3D11Device, D3d11WebGl2TextureSharing
{
  readonly context: D3d11DrawContext;
  private readonly owner: D3d11ResourceOwner;
  private readonly states: D3d11StateCache;
  private readonly textures: D3d11GpuTextures;
  private readonly output: D3d11GpuOutput;
  private readonly programs: D3d11ProgramCache;
  private readonly samplers: D3d11GpuSamplers;
  private readonly maxTextureSize: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly flags: number,
    private readonly featureLevel: number,
  ) {
    let cleanup = () => {};
    const lifetime = new D3d11Lifetime(() => cleanup());
    super(lifetime, ['db6f6ddb-ac77-4e88-8253-819df9bbf140'], () => {}, true);
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.owner = {
      lifetime,
      device: this,
      resourceDestroyed: (r) =>
        attemptAll([() => this.output.destroy(r), () => this.textures.destroy(r)]),
      synchronizeResource: (r) => this.textures.synchronize(r),
      resourceReady: (r) => this.textures.ready(r),
    };
    this.states = new D3d11StateCache(this.owner);
    this.textures = new D3d11GpuTextures(this.owner, gl);
    this.output = new D3d11GpuOutput(this.owner, gl, this.textures, true);
    this.programs = new D3d11ProgramCache(this.owner, gl);
    this.samplers = new D3d11GpuSamplers(this.owner, gl);
    this.context = new D3d11DrawContext(
      this.owner,
      gl,
      this.textures,
      this.output,
      this.programs,
      this.samplers,
    );
    cleanup = () =>
      attemptAll([
        () => this.context.disposeBindings(),
        () => this.context.disposeGpu(),
        () => this.output.dispose(),
        () => this.programs.dispose(),
        () => this.samplers.dispose(),
        () => this.textures.dispose(),
      ]);
  }

  createBuffer(desc: D3d11BufferDesc, initial: D3d11SubresourceData | null, validateOnly = false) {
    return this.create(() => createBufferStorage(this.owner, desc, initial, validateOnly));
  }
  createTexture2D(
    desc: D3d11Texture2DDesc,
    initial: readonly D3d11SubresourceData[] | null,
    validateOnly = false,
  ) {
    return this.create(() => {
      if (desc.width > this.maxTextureSize || desc.height > this.maxTextureSize)
        return {hr: 0x80070057 | 0, value: null};
      return createTexture2DStorage(this.owner, desc, initial, validateOnly);
    });
  }
  createShaderResourceView(
    resource: ID3D11Resource,
    desc: D3d11ShaderResourceViewDesc | null,
    validateOnly = false,
  ) {
    return this.create(() =>
      createShaderResourceViewStorage(this.owner, resource, desc, validateOnly),
    );
  }
  createRenderTargetView(
    resource: ID3D11Resource,
    desc: D3d11RenderTargetViewDesc | null,
    validateOnly = false,
  ) {
    return this.create(() =>
      createRenderTargetViewStorage(this.owner, resource, desc, validateOnly),
    );
  }
  createDepthStencilView(
    resource: ID3D11Resource,
    desc: D3d11DepthStencilViewDesc | null,
    validateOnly = false,
  ) {
    return this.create(() =>
      createDepthStencilViewStorage(this.owner, resource, desc, validateOnly),
    );
  }
  createInputLayout(
    elements: readonly D3d11InputElementDesc[],
    bytecode: Uint8Array,
    validateOnly = false,
  ) {
    return this.create(() =>
      createInputLayoutStorage(this.owner, elements, bytecode, validateOnly),
    );
  }
  createVertexShader(
    bytecode: Uint8Array,
    linkage: ID3D11ClassLinkage | null,
    validateOnly = false,
  ) {
    return this.create(() =>
      createShaderStorage(this.owner, 'vertex', bytecode, linkage, validateOnly),
    );
  }
  createPixelShader(
    bytecode: Uint8Array,
    linkage: ID3D11ClassLinkage | null,
    validateOnly = false,
  ) {
    return this.create(() =>
      createShaderStorage(this.owner, 'pixel', bytecode, linkage, validateOnly),
    );
  }
  createBlendState(desc: D3d11BlendDesc, validateOnly = false) {
    return this.create(() => this.states.createBlendState(desc, validateOnly));
  }
  createDepthStencilState(desc: D3d11DepthStencilDesc, validateOnly = false) {
    return this.create(() => this.states.createDepthStencilState(desc, validateOnly));
  }
  createRasterizerState(desc: D3d11RasterizerDesc, validateOnly = false) {
    return this.create(() => this.states.createRasterizerState(desc, validateOnly));
  }
  createSamplerState(desc: D3d11SamplerDesc, validateOnly = false) {
    return this.create(() => this.states.createSamplerState(desc, validateOnly));
  }

  checkFormatSupport(format: number) {
    this.checkLive();
    if (!Number.isInteger(format) || format < 0 || format > 115)
      return {hr: 0x80004005 | 0, value: null};
    if (format === 0) return {hr: 0x80070057 | 0, value: null};
    let support = [6, 16, 87].includes(format) ? 3 : [42, 57].includes(format) ? 5 : 0;
    const layout = dxgiLayout(format);
    if (layout) {
      support |= 0x20 | 0x1000; // Texture2D, mips.
      if (layout.depth) support |= 0x10000;
      else {
        support |= 0x100 | 0x200 | 0x20000; // Shader load/sample and CPU mapping.
        if (layout.blockWidth === 1) support |= 0x2000 | 0x4000 | 0x8000; // Autogen, target, blend.
      }
    }
    return {hr: 0, value: support};
  }
  getFeatureLevel(): number {
    this.checkLive();
    return this.featureLevel;
  }
  getCreationFlags(): number {
    this.checkLive();
    return this.flags;
  }
  getDeviceRemovedReason(): number {
    this.checkLive();
    return this.gl.isContextLost() ? 0x887a0005 | 0 : 0;
  }
  getImmediateContext(): D3d11DrawContext {
    this.checkLive();
    this.context.addRef();
    return this.context;
  }
  /** Borrowed GPU integration at UI registration; never an invented native device slot. */
  acquireColorTexture(resource: ID3D11Texture2D): D3d11WebGl2TextureLease {
    this.checkLive();
    if (
      !(resource instanceof D3d11Texture2D) ||
      resource.lifetime !== this.lifetime ||
      !resource.live
    )
      throw new D3d11TextureError('Invalid or foreign shared color texture');
    const desc = resource.getDesc();
    if (
      ![28, 87].includes(desc.format) ||
      desc.mipLevels !== 1 ||
      desc.arraySize !== 1 ||
      desc.sampleDesc.count !== 1 ||
      !(desc.bindFlags & 0x20)
    )
      throw new D3d11TextureError('Shared color image requires a single-level RGBA8 render target');
    resource.addRef();
    try {
      const texture = this.textures.image(resource);
      let closed = false;
      const images = this.textures,
        context = this.context;
      return {
        context: this.gl,
        texture,
        width: desc.width,
        height: desc.height,
        rowOrigin: 'bottom',
        prepare() {
          if (closed) throw new Error('Using a released shared texture');
          if (images.image(resource) !== texture)
            throw new Error('Shared texture allocation changed');
          context.publish();
        },
        dispose() {
          if (!closed) {
            closed = true;
            resource.release();
          }
        },
      };
    } catch (error) {
      resource.release();
      throw error;
    }
  }
  private checkLive(): void {
    if (!this.live) throw new D3d11TextureError('Using a retired D3D11 device');
  }
  private create<T>(factory: () => D3d11Result<T>): D3d11Result<T> {
    this.checkLive();
    if (this.gl.isContextLost()) return {hr: 0x887a0005 | 0, value: null};
    return factory();
  }
}
