import {defineNativeContract} from '../../platform/native-libraries.js';

/** D3D11_SDK_VERSION from the native SDK header. */
export const D3D11_SDK_VERSION = 7;

/** D3D11 COM subset used by native clients. Slot numbers include IUnknown. */
export interface D3d11Result<T> {
  readonly hr: number;
  readonly value: T | null;
}
export interface IUnknown {
  /** Slot 0; IID is a canonical GUID string. A successful query returns an owned reference. */
  queryInterface(iid: string): D3d11Result<IUnknown>;
  /** Slot 1. */
  addRef(): number;
  /** Slot 2. */
  release(): number;
}
/** IDXGIAdapter forward interface: clients here use only its IUnknown operations. */
export interface IDXGIAdapter extends IUnknown {}
export interface ID3D11DeviceChild extends IUnknown {
  /** Slot 3; the returned device has an additional reference. */
  getDevice(): ID3D11Device;
}
export interface ID3D11Resource extends ID3D11DeviceChild {
  /** Slot 7; D3D11_RESOURCE_DIMENSION. */
  getType(): number;
}
export interface D3d11BufferDesc {
  readonly byteWidth: number;
  readonly usage: number;
  readonly bindFlags: number;
  readonly cpuAccessFlags: number;
  readonly miscFlags: number;
  readonly structureByteStride: number;
}
export interface D3d11Texture2DDesc {
  readonly width: number;
  readonly height: number;
  readonly mipLevels: number;
  readonly arraySize: number;
  readonly format: number;
  readonly sampleDesc: {readonly count: number; readonly quality: number};
  readonly usage: number;
  readonly bindFlags: number;
  readonly cpuAccessFlags: number;
  readonly miscFlags: number;
}
export interface D3d11SubresourceData {
  readonly data: Uint8Array;
  readonly rowPitch: number;
  readonly slicePitch: number;
}
export interface D3d11MappedSubresource {
  /** Borrowed until unmap. Writes are committed by unmap, including across a Wasm boundary. */
  readonly data: Uint8Array;
  readonly rowPitch: number;
  readonly depthPitch: number;
}
export interface D3d11Box {
  readonly left: number;
  readonly top: number;
  readonly front: number;
  readonly right: number;
  readonly bottom: number;
  readonly back: number;
}
export interface ID3D11Buffer extends ID3D11Resource {
  /** Slot 10. */
  getDesc(): D3d11BufferDesc;
}
export interface ID3D11Texture2D extends ID3D11Resource {
  /** Slot 10. */
  getDesc(): D3d11Texture2DDesc;
}
export interface ID3D11View extends ID3D11DeviceChild {
  /** Slot 7; the returned resource has an additional reference. */
  getResource(): ID3D11Resource;
}
/** The Texture2D member of D3D11_SHADER_RESOURCE_VIEW_DESC. */
export interface D3d11ShaderResourceViewDesc {
  readonly format: number;
  readonly viewDimension: number;
  readonly texture2D: {readonly mostDetailedMip: number; readonly mipLevels: number};
}
/** The Texture2D member of D3D11_RENDER_TARGET_VIEW_DESC. */
export interface D3d11RenderTargetViewDesc {
  readonly format: number;
  readonly viewDimension: number;
  readonly texture2D: {readonly mipSlice: number};
}
/** The Texture2D member of D3D11_DEPTH_STENCIL_VIEW_DESC. */
export interface D3d11DepthStencilViewDesc {
  readonly format: number;
  readonly viewDimension: number;
  readonly flags: number;
  readonly texture2D: {readonly mipSlice: number};
}
export interface ID3D11ShaderResourceView extends ID3D11View {
  /** Slot 8. */
  getDesc(): D3d11ShaderResourceViewDesc;
}
export interface ID3D11RenderTargetView extends ID3D11View {
  /** Slot 8. */
  getDesc(): D3d11RenderTargetViewDesc;
}
export interface ID3D11DepthStencilView extends ID3D11View {
  /** Slot 8. */
  getDesc(): D3d11DepthStencilViewDesc;
}
export interface ID3D11VertexShader extends ID3D11DeviceChild {}
export interface ID3D11PixelShader extends ID3D11DeviceChild {}
export interface ID3D11ClassLinkage extends ID3D11DeviceChild {}
export interface ID3D11ClassInstance extends ID3D11DeviceChild {}
export interface ID3D11InputLayout extends ID3D11DeviceChild {}
export interface D3d11InputElementDesc {
  readonly semanticName: string;
  readonly semanticIndex: number;
  readonly format: number;
  readonly inputSlot: number;
  readonly alignedByteOffset: number;
  readonly inputSlotClass: number;
  readonly instanceDataStepRate: number;
}
export interface D3d11RenderTargetBlendDesc {
  readonly blendEnable: boolean;
  readonly srcBlend: number;
  readonly destBlend: number;
  readonly blendOp: number;
  readonly srcBlendAlpha: number;
  readonly destBlendAlpha: number;
  readonly blendOpAlpha: number;
  readonly renderTargetWriteMask: number;
}
export interface D3d11BlendDesc {
  readonly alphaToCoverageEnable: boolean;
  readonly independentBlendEnable: boolean;
  readonly renderTarget: readonly D3d11RenderTargetBlendDesc[];
}
export interface D3d11DepthStencilOpDesc {
  readonly stencilFailOp: number;
  readonly stencilDepthFailOp: number;
  readonly stencilPassOp: number;
  readonly stencilFunc: number;
}
export interface D3d11DepthStencilDesc {
  readonly depthEnable: boolean;
  readonly depthWriteMask: number;
  readonly depthFunc: number;
  readonly stencilEnable: boolean;
  readonly stencilReadMask: number;
  readonly stencilWriteMask: number;
  readonly frontFace: D3d11DepthStencilOpDesc;
  readonly backFace: D3d11DepthStencilOpDesc;
}
export interface D3d11RasterizerDesc {
  readonly fillMode: number;
  readonly cullMode: number;
  readonly frontCounterClockwise: boolean;
  readonly depthBias: number;
  readonly depthBiasClamp: number;
  readonly slopeScaledDepthBias: number;
  readonly depthClipEnable: boolean;
  readonly scissorEnable: boolean;
  readonly multisampleEnable: boolean;
  readonly antialiasedLineEnable: boolean;
}
export interface D3d11SamplerDesc {
  readonly filter: number;
  readonly addressU: number;
  readonly addressV: number;
  readonly addressW: number;
  readonly mipLodBias: number;
  readonly maxAnisotropy: number;
  readonly comparisonFunc: number;
  readonly borderColor: readonly [number, number, number, number];
  readonly minLod: number;
  readonly maxLod: number;
}
export interface ID3D11BlendState extends ID3D11DeviceChild {
  /** Slot 7. */
  getDesc(): D3d11BlendDesc;
}
export interface ID3D11DepthStencilState extends ID3D11DeviceChild {
  /** Slot 7. */
  getDesc(): D3d11DepthStencilDesc;
}
export interface ID3D11RasterizerState extends ID3D11DeviceChild {
  /** Slot 7. */
  getDesc(): D3d11RasterizerDesc;
}
export interface ID3D11SamplerState extends ID3D11DeviceChild {
  /** Slot 7. */
  getDesc(): D3d11SamplerDesc;
}
export interface D3d11Viewport {
  readonly topLeftX: number;
  readonly topLeftY: number;
  readonly width: number;
  readonly height: number;
  readonly minDepth: number;
  readonly maxDepth: number;
}
export interface D3d11Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Device creation returns resources with reference count one. Descriptors are copied. */
export interface ID3D11Device extends IUnknown {
  /** Slot 3. A null output pointer is represented by validateOnly. */
  createBuffer(
    desc: D3d11BufferDesc,
    initialData: D3d11SubresourceData | null,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11Buffer>;
  /** Slot 5. Subresources are in mip + arraySlice*mipLevels order. */
  createTexture2D(
    desc: D3d11Texture2DDesc,
    initialData: readonly D3d11SubresourceData[] | null,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11Texture2D>;
  /** Slot 7. */
  createShaderResourceView(
    resource: ID3D11Resource,
    desc: D3d11ShaderResourceViewDesc | null,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11ShaderResourceView>;
  /** Slot 9. */
  createRenderTargetView(
    resource: ID3D11Resource,
    desc: D3d11RenderTargetViewDesc | null,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11RenderTargetView>;
  /** Slot 10. */
  createDepthStencilView(
    resource: ID3D11Resource,
    desc: D3d11DepthStencilViewDesc | null,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11DepthStencilView>;
  /** Slot 11. */
  createInputLayout(
    elements: readonly D3d11InputElementDesc[],
    shaderBytecode: Uint8Array,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11InputLayout>;
  /** Slot 12. */
  createVertexShader(
    bytecode: Uint8Array,
    classLinkage: ID3D11ClassLinkage | null,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11VertexShader>;
  /** Slot 15. */
  createPixelShader(
    bytecode: Uint8Array,
    classLinkage: ID3D11ClassLinkage | null,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11PixelShader>;
  /** Slot 20. */
  createBlendState(desc: D3d11BlendDesc, validateOnly?: boolean): D3d11Result<ID3D11BlendState>;
  /** Slot 21. */
  createDepthStencilState(
    desc: D3d11DepthStencilDesc,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11DepthStencilState>;
  /** Slot 22. */
  createRasterizerState(
    desc: D3d11RasterizerDesc,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11RasterizerState>;
  /** Slot 23. */
  createSamplerState(
    desc: D3d11SamplerDesc,
    validateOnly?: boolean,
  ): D3d11Result<ID3D11SamplerState>;
  /** Slot 29. */
  checkFormatSupport(format: number): D3d11Result<number>;
  /** Slot 37. */
  getFeatureLevel(): number;
  /** Slot 38. */
  getCreationFlags(): number;
  /** Slot 39. */
  getDeviceRemovedReason(): number;
  /** Slot 40; returns an additional reference. */
  getImmediateContext(): ID3D11DeviceContext;
}

/** Setters retain bound interfaces; getters returning interfaces add references. */
export interface ID3D11DeviceContext extends ID3D11DeviceChild {
  /** Slot 7. */
  vsSetConstantBuffers(startSlot: number, buffers: readonly (ID3D11Buffer | null)[]): void;
  /** Slot 8. */
  psSetShaderResources(
    startSlot: number,
    views: readonly (ID3D11ShaderResourceView | null)[],
  ): void;
  /** Slot 9. */
  psSetShader(
    shader: ID3D11PixelShader | null,
    classInstances: readonly ID3D11ClassInstance[],
  ): void;
  /** Slot 10. */
  psSetSamplers(startSlot: number, samplers: readonly (ID3D11SamplerState | null)[]): void;
  /** Slot 11. */
  vsSetShader(
    shader: ID3D11VertexShader | null,
    classInstances: readonly ID3D11ClassInstance[],
  ): void;
  /** Slot 12. */
  drawIndexed(indexCount: number, startIndexLocation: number, baseVertexLocation: number): void;
  /** Slot 13. */
  draw(vertexCount: number, startVertexLocation: number): void;
  /** Slot 14. */
  map(
    resource: ID3D11Resource,
    subresource: number,
    mapType: number,
    mapFlags: number,
  ): D3d11Result<D3d11MappedSubresource>;
  /** Slot 15. */
  unmap(resource: ID3D11Resource, subresource: number): void;
  /** Slot 16. */
  psSetConstantBuffers(startSlot: number, buffers: readonly (ID3D11Buffer | null)[]): void;
  /** Slot 17. */
  iaSetInputLayout(layout: ID3D11InputLayout | null): void;
  /** Slot 18. Parallel arrays have identical lengths. */
  iaSetVertexBuffers(
    startSlot: number,
    buffers: readonly (ID3D11Buffer | null)[],
    strides: readonly number[],
    offsets: readonly number[],
  ): void;
  /** Slot 19. */
  iaSetIndexBuffer(buffer: ID3D11Buffer | null, format: number, offset: number): void;
  /** Slot 24. */
  iaSetPrimitiveTopology(topology: number): void;
  /** Slot 33. */
  omSetRenderTargets(
    views: readonly (ID3D11RenderTargetView | null)[],
    depthStencilView: ID3D11DepthStencilView | null,
  ): void;
  /** Slot 35. */
  omSetBlendState(
    state: ID3D11BlendState | null,
    blendFactor: readonly [number, number, number, number] | null,
    sampleMask: number,
  ): void;
  /** Slot 36. */
  omSetDepthStencilState(state: ID3D11DepthStencilState | null, stencilRef: number): void;
  /** Slot 43. */
  rsSetState(state: ID3D11RasterizerState | null): void;
  /** Slot 44. */
  rsSetViewports(viewports: readonly D3d11Viewport[]): void;
  /** Slot 45. */
  rsSetScissorRects(rects: readonly D3d11Rect[]): void;
  /** Slot 46. */
  copySubresourceRegion(
    destination: ID3D11Resource,
    destinationSubresource: number,
    x: number,
    y: number,
    z: number,
    source: ID3D11Resource,
    sourceSubresource: number,
    sourceBox: D3d11Box | null,
  ): void;
  /** Slot 47. */
  copyResource(destination: ID3D11Resource, source: ID3D11Resource): void;
  /** Slot 48. */
  updateSubresource(
    destination: ID3D11Resource,
    subresource: number,
    box: D3d11Box | null,
    data: Uint8Array,
    rowPitch: number,
    depthPitch: number,
  ): void;
  /** Slot 50. */
  clearRenderTargetView(
    view: ID3D11RenderTargetView,
    color: readonly [number, number, number, number],
  ): void;
  /** Slot 53. */
  clearDepthStencilView(
    view: ID3D11DepthStencilView,
    flags: number,
    depth: number,
    stencil: number,
  ): void;
  /** Slot 54. */
  generateMips(view: ID3D11ShaderResourceView): void;
  /** Slot 72. */
  vsGetConstantBuffers(startSlot: number, count: number): readonly (ID3D11Buffer | null)[];
  /** Slot 73. */
  psGetShaderResources(
    startSlot: number,
    count: number,
  ): readonly (ID3D11ShaderResourceView | null)[];
  /** Slot 74. */
  psGetShader(): {
    readonly shader: ID3D11PixelShader | null;
    readonly classInstances: readonly ID3D11ClassInstance[];
  };
  /** Slot 75. */
  psGetSamplers(startSlot: number, count: number): readonly (ID3D11SamplerState | null)[];
  /** Slot 76. */
  vsGetShader(): {
    readonly shader: ID3D11VertexShader | null;
    readonly classInstances: readonly ID3D11ClassInstance[];
  };
  /** Slot 77. */
  psGetConstantBuffers(startSlot: number, count: number): readonly (ID3D11Buffer | null)[];
  /** Slot 78. */
  iaGetInputLayout(): ID3D11InputLayout | null;
  /** Slot 79. */
  iaGetVertexBuffers(
    startSlot: number,
    count: number,
  ): {
    readonly buffers: readonly (ID3D11Buffer | null)[];
    readonly strides: readonly number[];
    readonly offsets: readonly number[];
  };
  /** Slot 80. */
  iaGetIndexBuffer(): {
    readonly buffer: ID3D11Buffer | null;
    readonly format: number;
    readonly offset: number;
  };
  /** Slot 83. */
  iaGetPrimitiveTopology(): number;
  /** Slot 89. */
  omGetRenderTargets(count: number): {
    readonly views: readonly (ID3D11RenderTargetView | null)[];
    readonly depthStencilView: ID3D11DepthStencilView | null;
  };
  /** Slot 91. */
  omGetBlendState(): {
    readonly state: ID3D11BlendState | null;
    readonly blendFactor: readonly [number, number, number, number];
    readonly sampleMask: number;
  };
  /** Slot 92. */
  omGetDepthStencilState(): {
    readonly state: ID3D11DepthStencilState | null;
    readonly stencilRef: number;
  };
  /** Slot 94. */
  rsGetState(): ID3D11RasterizerState | null;
  /** Slot 95. */
  rsGetViewports(): readonly D3d11Viewport[];
  /** Slot 96. */
  rsGetScissorRects(): readonly D3d11Rect[];
  /** Slot 110. */
  clearState(): void;
  /** Slot 111. */
  flush(): void;
  /** Slot 112. */
  getType(): number;
  /** Slot 113. */
  getContextFlags(): number;
}

export interface D3d11Exports {
  /** D3D11CreateDevice; successful interface outputs each carry one reference. */
  d3d11CreateDevice(
    adapter: IDXGIAdapter | null,
    driverType: number,
    software: number,
    flags: number,
    featureLevels: readonly number[] | null,
    sdkVersion: number,
  ): {
    readonly hr: number;
    readonly device: ID3D11Device | null;
    readonly featureLevel: number;
    readonly immediateContext: ID3D11DeviceContext | null;
  };
}
export const D3D11 = defineNativeContract<D3d11Exports>('d3d11.dll', '1');
