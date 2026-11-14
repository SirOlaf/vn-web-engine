import type {
  D3d11DepthStencilViewDesc,
  D3d11RenderTargetViewDesc,
  D3d11Result,
  D3d11ShaderResourceViewDesc,
  ID3D11Device,
  ID3D11Resource,
  ID3D11View,
} from '../contract.js';
import {D3d11Object} from './com.js';
import {D3d11Texture2D, type D3d11ResourceOwner} from './resources.js';

const INVALID = 0x80070057 | 0;
type ViewDesc = D3d11ShaderResourceViewDesc | D3d11RenderTargetViewDesc | D3d11DepthStencilViewDesc;
const copy = <T extends ViewDesc>(desc: T): T => ({...desc, texture2D: {...desc.texture2D}});
const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

/** A view retains its resource even when no caller owns the original resource handle. */
export class D3d11TextureView<T extends ViewDesc> extends D3d11Object implements ID3D11View {
  constructor(
    readonly resource: D3d11Texture2D,
    readonly kind: 'shader-resource' | 'render-target' | 'depth-stencil',
    private readonly desc: T,
    readonly firstMip: number,
    readonly mipCount: number,
    iid: string,
  ) {
    if (!resource.live) throw new Error('Creating a view of a released D3D11 resource');
    super(
      resource.lifetime,
      ['1841e5c8-16b0-489b-bcc8-44cfb0d5deae', '839d1216-bb2e-412b-b7f4-a9dbebe08ed1', iid],
      () => resource.releaseBinding(),
    );
    resource.retainBinding();
  }
  getDevice(): ID3D11Device {
    this.checkLive();
    return this.resource.getDevice();
  }
  getResource(): ID3D11Resource {
    this.checkLive();
    this.resource.addRef();
    return this.resource;
  }
  getDesc(): T {
    return copy(this.desc);
  }
  private checkLive(): void {
    if (!this.live) throw new Error('Using a released D3D11 view');
  }
}

function ownedTexture(
  owner: D3d11ResourceOwner,
  resource: ID3D11Resource,
  bind: number,
): resource is D3d11Texture2D {
  return (
    resource instanceof D3d11Texture2D &&
    resource.live &&
    resource.lifetime === owner.lifetime &&
    resource.getDesc().arraySize === 1 &&
    (resource.getDesc().bindFlags & bind) !== 0
  );
}

export function createShaderResourceViewStorage(
  owner: D3d11ResourceOwner,
  resource: ID3D11Resource,
  desc: D3d11ShaderResourceViewDesc | null,
  validateOnly = false,
): D3d11Result<D3d11TextureView<D3d11ShaderResourceViewDesc>> {
  if (!ownedTexture(owner, resource, 8) || resource.layout.depth) return {hr: INVALID, value: null};
  const texture = resource.getDesc();
  const d = copy(
    desc ?? {
      format: texture.format,
      viewDimension: 4,
      texture2D: {mostDetailedMip: 0, mipLevels: texture.mipLevels},
    },
  );
  const first = d.texture2D.mostDetailedMip,
    count = d.texture2D.mipLevels;
  const mipCount = count === 0xffffffff ? texture.mipLevels - first : count;
  if (
    d.format !== texture.format ||
    d.viewDimension !== 4 ||
    !uint(first) ||
    !uint(count) ||
    first >= texture.mipLevels ||
    mipCount < 1 ||
    first + mipCount > texture.mipLevels
  )
    return {hr: INVALID, value: null};
  if (validateOnly) return {hr: 1, value: null};
  return {
    hr: 0,
    value: new D3d11TextureView(
      resource,
      'shader-resource',
      {...d, texture2D: {mostDetailedMip: first, mipLevels: mipCount}},
      first,
      mipCount,
      'b0e06fe0-8192-4e1a-b1ca-36d7414710b2',
    ),
  };
}

export function createRenderTargetViewStorage(
  owner: D3d11ResourceOwner,
  resource: ID3D11Resource,
  desc: D3d11RenderTargetViewDesc | null,
  validateOnly = false,
): D3d11Result<D3d11TextureView<D3d11RenderTargetViewDesc>> {
  if (
    !ownedTexture(owner, resource, 0x20) ||
    resource.layout.depth ||
    resource.layout.blockWidth !== 1
  )
    return {hr: INVALID, value: null};
  const texture = resource.getDesc();
  const d = copy(desc ?? {format: texture.format, viewDimension: 4, texture2D: {mipSlice: 0}});
  if (
    d.format !== texture.format ||
    d.viewDimension !== 4 ||
    !uint(d.texture2D.mipSlice) ||
    d.texture2D.mipSlice >= texture.mipLevels
  )
    return {hr: INVALID, value: null};
  if (validateOnly) return {hr: 1, value: null};
  return {
    hr: 0,
    value: new D3d11TextureView(
      resource,
      'render-target',
      d,
      d.texture2D.mipSlice,
      1,
      'dfdba067-0b8d-4865-875b-d7b4516cc164',
    ),
  };
}

export function createDepthStencilViewStorage(
  owner: D3d11ResourceOwner,
  resource: ID3D11Resource,
  desc: D3d11DepthStencilViewDesc | null,
  validateOnly = false,
): D3d11Result<D3d11TextureView<D3d11DepthStencilViewDesc>> {
  if (!ownedTexture(owner, resource, 0x40) || !resource.layout.depth)
    return {hr: INVALID, value: null};
  const texture = resource.getDesc();
  const d = copy(
    desc ?? {format: texture.format, viewDimension: 3, flags: 0, texture2D: {mipSlice: 0}},
  );
  if (
    d.format !== texture.format ||
    d.viewDimension !== 3 ||
    !uint(d.texture2D.mipSlice) ||
    d.texture2D.mipSlice >= texture.mipLevels ||
    !uint(d.flags) ||
    (d.flags & ~3) !== 0 ||
    ((d.flags & 2) !== 0 && texture.format !== 45)
  )
    return {hr: INVALID, value: null};
  if (validateOnly) return {hr: 1, value: null};
  return {
    hr: 0,
    value: new D3d11TextureView(
      resource,
      'depth-stencil',
      d,
      d.texture2D.mipSlice,
      1,
      '9fdac92a-1876-48c3-afad-25b94f84a9b6',
    ),
  };
}
