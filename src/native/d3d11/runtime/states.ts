import type {
  D3d11BlendDesc,
  D3d11DepthStencilDesc,
  D3d11DepthStencilOpDesc,
  D3d11RasterizerDesc,
  D3d11Result,
  D3d11SamplerDesc,
  ID3D11Device,
  ID3D11DeviceChild,
} from '../contract.js';
import {D3d11ChildObject, type D3d11Lifetime} from './com.js';

const INVALID = 0x80070057 | 0;
const TOO_MANY_STATES = 0x887c0001 | 0;
type Kind = 'blend' | 'depth-stencil' | 'rasterizer' | 'sampler';
interface Owner {
  readonly lifetime: D3d11Lifetime;
  readonly device: ID3D11Device;
}
const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const range = (n: number, lo: number, hi: number): boolean =>
  Number.isInteger(n) && n >= lo && n <= hi;
const bool = (b: boolean): boolean => typeof b === 'boolean';
const f32 = Math.fround;
const floatBits = new DataView(new ArrayBuffer(4));
function word(n: number): number {
  floatBits.setFloat32(0, n, true);
  return floatBits.getUint32(0, true);
}
const key = (values: readonly number[]): string =>
  values.map((n) => (n >>> 0).toString(16)).join('/');
const copyBlend = (d: D3d11BlendDesc): D3d11BlendDesc => ({
  ...d,
  renderTarget: d.renderTarget.map((t) => ({...t})),
});
const copyDepth = (d: D3d11DepthStencilDesc): D3d11DepthStencilDesc => ({
  ...d,
  frontFace: {...d.frontFace},
  backFace: {...d.backFace},
});
const copyRaster = (d: D3d11RasterizerDesc): D3d11RasterizerDesc => ({...d});
const copySampler = (d: D3d11SamplerDesc): D3d11SamplerDesc => ({
  ...d,
  borderColor: [...d.borderColor],
});

/** Immutable device state, held by both public callers and pipeline bindings. */
export class D3d11State<T> extends D3d11ChildObject implements ID3D11DeviceChild {
  constructor(
    owner: Owner,
    readonly kind: Kind,
    readonly description: T,
    private readonly copy: (value: T) => T,
    iid: string,
    dispose: () => void,
  ) {
    super(owner, [iid], dispose);
  }
  getDesc(): T {
    return this.copy(this.description);
  }
}

/** Native state interning: at most4096 live unique descriptors per state kind/device. */
export class D3d11StateCache {
  private readonly blend = new Map<string, D3d11State<D3d11BlendDesc>>();
  private readonly depth = new Map<string, D3d11State<D3d11DepthStencilDesc>>();
  private readonly raster = new Map<string, D3d11State<D3d11RasterizerDesc>>();
  private readonly sampler = new Map<string, D3d11State<D3d11SamplerDesc>>();
  constructor(private readonly owner: Owner) {}

  createBlendState(
    d: D3d11BlendDesc,
    validateOnly = false,
  ): D3d11Result<D3d11State<D3d11BlendDesc>> {
    if (
      !bool(d.alphaToCoverageEnable) ||
      !bool(d.independentBlendEnable) ||
      d.renderTarget.length !== 8
    )
      return {hr: INVALID, value: null};
    const blendFactors = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19];
    for (let i = 0; i < 8; i++) {
      const t = d.renderTarget[i]!;
      if (
        !bool(t.blendEnable) ||
        ![
          t.srcBlend,
          t.destBlend,
          t.blendOp,
          t.srcBlendAlpha,
          t.destBlendAlpha,
          t.blendOpAlpha,
          t.renderTargetWriteMask,
        ].every(uint)
      )
        return {hr: INVALID, value: null};
      if (i > 0 && !d.independentBlendEnable) continue;
      if (
        t.renderTargetWriteMask > 15 ||
        (t.blendEnable &&
          (![t.srcBlend, t.destBlend, t.srcBlendAlpha, t.destBlendAlpha].every((n) =>
            blendFactors.includes(n),
          ) ||
            [t.srcBlendAlpha, t.destBlendAlpha].some((n) => [3, 4, 9, 10].includes(n)) ||
            !range(t.blendOp, 1, 5) ||
            !range(t.blendOpAlpha, 1, 5)))
      )
        return {hr: INVALID, value: null};
    }
    const desc = copyBlend(d);
    const values = [+d.alphaToCoverageEnable, +d.independentBlendEnable];
    for (const t of desc.renderTarget)
      values.push(
        +t.blendEnable,
        t.srcBlend,
        t.destBlend,
        t.blendOp,
        t.srcBlendAlpha,
        t.destBlendAlpha,
        t.blendOpAlpha,
        t.renderTargetWriteMask,
      );
    for (const t of desc.renderTarget) Object.freeze(t);
    Object.freeze(desc.renderTarget);
    Object.freeze(desc);
    return this.create(
      this.blend,
      'blend',
      desc,
      copyBlend,
      key(values),
      '75b68faa-347d-4159-8f45-a0640f01cd9a',
      validateOnly,
    );
  }

  createDepthStencilState(
    d: D3d11DepthStencilDesc,
    validateOnly = false,
  ): D3d11Result<D3d11State<D3d11DepthStencilDesc>> {
    const faces = [d.frontFace, d.backFace];
    const validFace = (f: D3d11DepthStencilOpDesc): boolean =>
      [f.stencilFailOp, f.stencilDepthFailOp, f.stencilPassOp, f.stencilFunc].every((n) =>
        range(n, 1, 8),
      );
    if (
      !bool(d.depthEnable) ||
      !bool(d.stencilEnable) ||
      ![d.depthWriteMask, d.depthFunc].every(uint) ||
      !range(d.stencilReadMask, 0, 255) ||
      !range(d.stencilWriteMask, 0, 255) ||
      !faces.every((f) =>
        [f.stencilFailOp, f.stencilDepthFailOp, f.stencilPassOp, f.stencilFunc].every(uint),
      ) ||
      (d.depthEnable && (!range(d.depthWriteMask, 0, 1) || !range(d.depthFunc, 1, 8))) ||
      (d.stencilEnable && !faces.every(validFace))
    )
      return {hr: INVALID, value: null};
    const desc = copyDepth(d),
      values = [
        +d.depthEnable,
        d.depthWriteMask,
        d.depthFunc,
        +d.stencilEnable,
        d.stencilReadMask,
        d.stencilWriteMask,
      ];
    for (const f of faces)
      values.push(f.stencilFailOp, f.stencilDepthFailOp, f.stencilPassOp, f.stencilFunc);
    Object.freeze(desc.frontFace);
    Object.freeze(desc.backFace);
    Object.freeze(desc);
    return this.create(
      this.depth,
      'depth-stencil',
      desc,
      copyDepth,
      key(values),
      '03823efb-8d8f-4e1c-9aa2-f64bb2cbfdf1',
      validateOnly,
    );
  }

  createRasterizerState(
    d: D3d11RasterizerDesc,
    validateOnly = false,
  ): D3d11Result<D3d11State<D3d11RasterizerDesc>> {
    if (
      !range(d.fillMode, 2, 3) ||
      !range(d.cullMode, 1, 3) ||
      !range(d.depthBias, -0x80000000, 0x7fffffff) ||
      ![
        d.frontCounterClockwise,
        d.depthClipEnable,
        d.scissorEnable,
        d.multisampleEnable,
        d.antialiasedLineEnable,
      ].every(bool) ||
      ![d.depthBiasClamp, d.slopeScaledDepthBias].every((n) => Number.isFinite(f32(n)))
    )
      return {hr: INVALID, value: null};
    const desc = Object.freeze({
      ...d,
      depthBiasClamp: f32(d.depthBiasClamp),
      slopeScaledDepthBias: f32(d.slopeScaledDepthBias),
    });
    const values = [
      d.fillMode,
      d.cullMode,
      +d.frontCounterClockwise,
      d.depthBias,
      word(desc.depthBiasClamp),
      word(desc.slopeScaledDepthBias),
      +d.depthClipEnable,
      +d.scissorEnable,
      +d.multisampleEnable,
      +d.antialiasedLineEnable,
    ];
    return this.create(
      this.raster,
      'rasterizer',
      desc,
      copyRaster,
      key(values),
      '9bb4ab81-ab1a-4d8f-b506-fc04200b6ee7',
      validateOnly,
    );
  }

  createSamplerState(
    d: D3d11SamplerDesc,
    validateOnly = false,
  ): D3d11Result<D3d11State<D3d11SamplerDesc>> {
    const filters = [0, 1, 4, 5, 16, 17, 20, 21, 85, 128, 129, 132, 133, 144, 145, 148, 149, 213];
    const floats = [d.mipLodBias, d.minLod, d.maxLod, ...d.borderColor].map(f32);
    if (
      !filters.includes(d.filter) ||
      ![d.addressU, d.addressV, d.addressW].every((n) => range(n, 1, 5)) ||
      !uint(d.maxAnisotropy) ||
      !uint(d.comparisonFunc) ||
      d.borderColor.length !== 4 ||
      !floats.every(Number.isFinite) ||
      f32(d.mipLodBias) < -16 ||
      f32(d.mipLodBias) > f32(15.99) ||
      f32(d.minLod) > f32(d.maxLod) ||
      ((d.filter & 0x40) !== 0 && !range(d.maxAnisotropy, 1, 16)) ||
      ((d.filter & 0x80) !== 0 && !range(d.comparisonFunc, 1, 8)) ||
      ([d.addressU, d.addressV, d.addressW].includes(4) &&
        !d.borderColor.every((n) => f32(n) >= 0 && f32(n) <= 1))
    )
      return {hr: INVALID, value: null};
    const desc: D3d11SamplerDesc = {
      ...d,
      mipLodBias: f32(d.mipLodBias),
      minLod: f32(d.minLod),
      maxLod: f32(d.maxLod),
      borderColor: [
        f32(d.borderColor[0]),
        f32(d.borderColor[1]),
        f32(d.borderColor[2]),
        f32(d.borderColor[3]),
      ],
    };
    Object.freeze(desc.borderColor);
    Object.freeze(desc);
    const values = [
      d.filter,
      d.addressU,
      d.addressV,
      d.addressW,
      word(desc.mipLodBias),
      d.maxAnisotropy,
      d.comparisonFunc,
      ...desc.borderColor.map(word),
      word(desc.minLod),
      word(desc.maxLod),
    ];
    return this.create(
      this.sampler,
      'sampler',
      desc,
      copySampler,
      key(values),
      'da6fea51-564c-4487-9810-f0d0f9b4e3a5',
      validateOnly,
    );
  }

  private create<T>(
    pool: Map<string, D3d11State<T>>,
    kind: Kind,
    desc: T,
    copy: (d: T) => T,
    key: string,
    iid: string,
    validateOnly: boolean,
  ): D3d11Result<D3d11State<T>> {
    if (this.owner.lifetime.closed) return {hr: INVALID, value: null};
    if (validateOnly) return {hr: 1, value: null};
    const existing = pool.get(key);
    if (existing) {
      existing.addRef();
      return {hr: 0, value: existing};
    }
    if (pool.size >= 4096) return {hr: TOO_MANY_STATES, value: null};
    const state = new D3d11State(this.owner, kind, desc, copy, iid, () => pool.delete(key));
    pool.set(key, state);
    return {hr: 0, value: state};
  }
}
