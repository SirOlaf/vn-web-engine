import type {
  D3d11Box,
  D3d11DepthStencilViewDesc,
  D3d11RenderTargetViewDesc,
  D3d11ShaderResourceViewDesc,
  ID3D11DepthStencilView,
  ID3D11DeviceContext,
  ID3D11RenderTargetView,
  ID3D11Resource,
  ID3D11ShaderResourceView,
} from '../contract.js';
import type {D3d11DeviceOwner} from '../runtime/com.js';
import {D3d11ContextState} from '../runtime/context-state.js';
import {D3d11ResourceStorage} from '../runtime/resources.js';
import {D3d11TextureView} from '../runtime/views.js';
import {D3d11GpuTextures, D3d11TextureError} from './textures.js';

/** Immediate-context transfers share the same native bindings and resource ownership as draws. */
export class D3d11TransferContext
  extends D3d11ContextState
  implements Omit<ID3D11DeviceContext, 'draw' | 'drawIndexed'>
{
  constructor(
    owner: D3d11DeviceOwner,
    protected readonly gl: WebGL2RenderingContext,
    protected readonly textures: D3d11GpuTextures,
  ) {
    super(owner);
  }

  map(resource: ID3D11Resource, subresource: number, mapType: number, mapFlags: number) {
    this.checkLive();
    if (!this.isResource(resource)) return {hr: 0x80070057 | 0, value: null};
    if (this.gl.isContextLost()) return {hr: 0x887a0005 | 0, value: null};
    try {
      return resource.map(subresource, mapType, mapFlags);
    } catch (error) {
      if (error instanceof D3d11TextureError) return {hr: error.hr, value: null};
      throw error;
    }
  }

  unmap(resource: ID3D11Resource, subresource: number): void {
    this.resource(resource).unmap(subresource);
  }

  updateSubresource(
    destination: ID3D11Resource,
    subresource: number,
    box: D3d11Box | null,
    data: Uint8Array,
    rowPitch: number,
    _depthPitch: number,
  ): void {
    this.resource(destination).update(subresource, box, data, rowPitch);
  }

  copySubresourceRegion(
    destination: ID3D11Resource,
    destinationSubresource: number,
    x: number,
    y: number,
    z: number,
    source: ID3D11Resource,
    sourceSubresource: number,
    sourceBox: D3d11Box | null,
  ): void {
    this.textures.copyRegion(
      this.resource(destination),
      destinationSubresource,
      x,
      y,
      z,
      this.resource(source),
      sourceSubresource,
      sourceBox,
    );
  }

  copyResource(destination: ID3D11Resource, source: ID3D11Resource): void {
    this.textures.copyResource(this.resource(destination), this.resource(source));
  }

  clearRenderTargetView(
    view: ID3D11RenderTargetView,
    color: readonly [number, number, number, number],
  ): void {
    this.textures.clearColor(
      this.transferView<D3d11RenderTargetViewDesc>(view, 'render-target'),
      color,
    );
  }

  clearDepthStencilView(
    view: ID3D11DepthStencilView,
    flags: number,
    depth: number,
    stencil: number,
  ): void {
    this.textures.clearDepthStencil(
      this.transferView<D3d11DepthStencilViewDesc>(view, 'depth-stencil'),
      flags,
      depth,
      stencil,
    );
  }

  generateMips(view: ID3D11ShaderResourceView): void {
    this.textures.generateMips(
      this.transferView<D3d11ShaderResourceViewDesc>(view, 'shader-resource'),
    );
  }

  flush(): void {
    this.checkLive();
    if (this.gl.isContextLost())
      throw new D3d11TextureError('D3D11 device removed', 0x887a0005 | 0);
    this.gl.flush();
  }

  private isResource(value: ID3D11Resource): value is D3d11ResourceStorage {
    return value instanceof D3d11ResourceStorage && value.live && value.lifetime === this.lifetime;
  }

  private resource(value: ID3D11Resource): D3d11ResourceStorage {
    this.checkLive();
    if (!this.isResource(value)) throw new D3d11TextureError('Invalid or foreign D3D11 resource');
    return value;
  }

  private transferView<
    T extends D3d11DepthStencilViewDesc | D3d11RenderTargetViewDesc | D3d11ShaderResourceViewDesc,
  >(
    value: unknown,
    kind: 'render-target' | 'depth-stencil' | 'shader-resource',
  ): D3d11TextureView<T> {
    this.checkLive();
    if (
      !(value instanceof D3d11TextureView) ||
      !value.live ||
      value.lifetime !== this.lifetime ||
      value.kind !== kind
    )
      throw new D3d11TextureError('Invalid or foreign D3D11 view');
    return value as D3d11TextureView<T>;
  }
}
