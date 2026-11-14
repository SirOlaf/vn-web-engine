import type {
  D3d11BlendDesc,
  D3d11DepthStencilDesc,
  D3d11DepthStencilViewDesc,
  D3d11RasterizerDesc,
  D3d11Rect,
  D3d11RenderTargetViewDesc,
  D3d11SamplerDesc,
  D3d11ShaderResourceViewDesc,
  D3d11Viewport,
  ID3D11BlendState,
  ID3D11Buffer,
  ID3D11ClassInstance,
  ID3D11DepthStencilState,
  ID3D11DepthStencilView,
  ID3D11DeviceContext,
  ID3D11InputLayout,
  ID3D11PixelShader,
  ID3D11RasterizerState,
  ID3D11RenderTargetView,
  ID3D11SamplerState,
  ID3D11ShaderResourceView,
  ID3D11VertexShader,
} from '../contract.js';
import {D3d11ChildObject, D3d11Object, type D3d11DeviceOwner} from './com.js';
import {D3d11Buffer} from './resources.js';
import {D3d11State} from './states.js';
import {D3d11TextureView} from './views.js';

const IIDS = {
  vertexShader: '3b301d64-d678-4289-8897-22f8928b72f3',
  pixelShader: 'ea82e40d-51dc-4f33-93d4-db7c9125ae8c',
  layout: 'e4819ddc-4cf0-4025-bd26-5de82a3e07b7',
} as const;
type Srv = D3d11TextureView<D3d11ShaderResourceViewDesc>;
type Rtv = D3d11TextureView<D3d11RenderTargetViewDesc>;
type Dsv = D3d11TextureView<D3d11DepthStencilViewDesc>;
const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const int = (n: number): boolean => Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff;
function slots(start: number, count: number, limit: number): void {
  if (!uint(start) || !uint(count) || start > limit || count > limit - start)
    throw new Error('Invalid D3D11 binding slots');
}
function owned<T extends D3d11Object>(value: T | null): T | null {
  value?.addRef();
  return value;
}
function releaseAll(values: readonly (D3d11Object | null)[]): void {
  const errors: unknown[] = [];
  for (const value of values)
    try {
      value?.releaseBinding();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, 'D3D11 binding release failed');
}
function overlaps(
  a: D3d11TextureView<
    D3d11ShaderResourceViewDesc | D3d11RenderTargetViewDesc | D3d11DepthStencilViewDesc
  >,
  b: Rtv | Dsv,
): boolean {
  return (
    a.resource === b.resource &&
    a.firstMip < b.firstMip + b.mipCount &&
    b.firstMip < a.firstMip + a.mipCount
  );
}

/** Immediate-context binding storage. The concrete backend supplies drawing and transfers. */
export class D3d11ContextState
  extends D3d11ChildObject
  implements
    Omit<
      ID3D11DeviceContext,
      | 'draw'
      | 'drawIndexed'
      | 'map'
      | 'unmap'
      | 'copySubresourceRegion'
      | 'copyResource'
      | 'updateSubresource'
      | 'clearRenderTargetView'
      | 'clearDepthStencilView'
      | 'generateMips'
      | 'flush'
    >
{
  protected readonly vsBuffers: (D3d11Buffer | null)[] = Array(14).fill(null);
  protected readonly psBuffers: (D3d11Buffer | null)[] = Array(14).fill(null);
  protected readonly psResources: (Srv | null)[] = Array(128).fill(null);
  protected readonly psSamplers: (D3d11State<D3d11SamplerDesc> | null)[] = Array(16).fill(null);
  protected vertexShader: D3d11ChildObject | null = null;
  protected pixelShader: D3d11ChildObject | null = null;
  protected inputLayout: D3d11ChildObject | null = null;
  protected readonly vertexBuffers: (D3d11Buffer | null)[] = Array(32).fill(null);
  protected readonly vertexStrides: number[] = Array(32).fill(0);
  protected readonly vertexOffsets: number[] = Array(32).fill(0);
  protected indexBuffer: D3d11Buffer | null = null;
  protected indexFormat = 0;
  protected indexOffset = 0;
  protected topology = 0;
  protected readonly renderTargets: (Rtv | null)[] = Array(8).fill(null);
  protected depthTarget: Dsv | null = null;
  protected blendState: D3d11State<D3d11BlendDesc> | null = null;
  protected blendFactor: readonly [number, number, number, number] = [1, 1, 1, 1];
  protected sampleMask = 0xffffffff;
  protected depthState: D3d11State<D3d11DepthStencilDesc> | null = null;
  protected stencilRef = 0;
  protected rasterState: D3d11State<D3d11RasterizerDesc> | null = null;
  protected viewports: readonly D3d11Viewport[] = [];
  protected scissorRects: readonly D3d11Rect[] = [];

  constructor(owner: D3d11DeviceOwner) {
    super(owner, ['c0bfa96c-e089-44fb-8eaf-26f8796190da'], () => {}, true);
  }
  protected checkLive(): void {
    if (!this.live) throw new Error('Using a released D3D11 context');
  }

  private object<T extends D3d11Object>(
    value: unknown,
    ctor: abstract new (...args: never[]) => T,
  ): T | null {
    if (value === null) return null;
    if (!(value instanceof ctor) || !value.live || value.lifetime !== this.lifetime)
      throw new Error('Binding a foreign or released D3D11 object');
    return value;
  }
  private buffer(value: ID3D11Buffer | null, bindFlag: number): D3d11Buffer | null {
    const buffer = this.object(value, D3d11Buffer);
    if (buffer && !(buffer.bindFlags & bindFlag))
      throw new Error('Invalid D3D11 buffer binding');
    return buffer;
  }
  private view<T extends Srv | Rtv | Dsv>(
    value: unknown,
    kind: 'shader-resource' | 'render-target' | 'depth-stencil',
  ): T | null {
    const view = this.object(value, D3d11TextureView);
    if (view && view.kind !== kind) throw new Error('Invalid D3D11 view binding');
    return view as T | null;
  }
  private state<T>(
    value: unknown,
    kind: 'blend' | 'depth-stencil' | 'rasterizer' | 'sampler',
  ): D3d11State<T> | null {
    const state = this.object(value, D3d11State);
    if (state && state.kind !== kind) throw new Error('Invalid D3D11 state binding');
    return state as D3d11State<T> | null;
  }
  private child(value: unknown, iid: string): D3d11ChildObject | null {
    const child = this.object(value, D3d11ChildObject);
    if (child && !child.supportsInterface(iid))
      throw new Error('Invalid D3D11 shader or layout binding');
    return child;
  }
  private replaceRange<T extends D3d11Object>(
    target: (T | null)[],
    start: number,
    values: readonly (T | null)[],
  ): void {
    // Rebinding the same (already validated) objects would retain and release each once.
    let same = true;
    for (let i = 0; i < values.length && same; i++) same = target[start + i] === values[i];
    if (same) return;
    for (const value of values) value?.retainBinding();
    const old = target.slice(start, start + values.length);
    for (let i = 0; i < values.length; i++) target[start + i] = values[i]!;
    releaseAll(old);
  }
  private constants(
    target: (D3d11Buffer | null)[],
    start: number,
    values: readonly (ID3D11Buffer | null)[],
  ): void {
    this.checkLive();
    slots(start, values.length, 14);
    this.replaceRange(
      target,
      start,
      values.map((value) => this.buffer(value, 4)),
    );
  }
  vsSetConstantBuffers(start: number, values: readonly (ID3D11Buffer | null)[]): void {
    this.constants(this.vsBuffers, start, values);
  }
  psSetConstantBuffers(start: number, values: readonly (ID3D11Buffer | null)[]): void {
    this.constants(this.psBuffers, start, values);
  }
  vsGetConstantBuffers(start: number, count: number): readonly (ID3D11Buffer | null)[] {
    this.checkLive();
    slots(start, count, 14);
    return this.vsBuffers.slice(start, start + count).map(owned);
  }
  psGetConstantBuffers(start: number, count: number): readonly (ID3D11Buffer | null)[] {
    this.checkLive();
    slots(start, count, 14);
    return this.psBuffers.slice(start, start + count).map(owned);
  }

  psSetShaderResources(start: number, values: readonly (ID3D11ShaderResourceView | null)[]): void {
    this.checkLive();
    slots(start, values.length, 128);
    const views = values.map((value) => this.view<Srv>(value, 'shader-resource'));
    this.replaceRange(
      this.psResources,
      start,
      views.map((view) => (view && this.outputConflict(view) ? null : view)),
    );
  }
  psGetShaderResources(start: number, count: number): readonly (ID3D11ShaderResourceView | null)[] {
    this.checkLive();
    slots(start, count, 128);
    return this.psResources.slice(start, start + count).map(owned);
  }
  psSetSamplers(start: number, values: readonly (ID3D11SamplerState | null)[]): void {
    this.checkLive();
    slots(start, values.length, 16);
    this.replaceRange(
      this.psSamplers,
      start,
      values.map((value) => this.state<D3d11SamplerDesc>(value, 'sampler')),
    );
  }
  psGetSamplers(start: number, count: number): readonly (ID3D11SamplerState | null)[] {
    this.checkLive();
    slots(start, count, 16);
    return this.psSamplers.slice(start, start + count).map(owned);
  }

  vsSetShader(value: ID3D11VertexShader | null, instances: readonly ID3D11ClassInstance[]): void {
    this.checkLive();
    if (instances.length) throw new Error('SM4 shaders do not accept class instances');
    const next = this.child(value, IIDS.vertexShader),
      old = this.vertexShader;
    if (next === old) return;
    next?.retainBinding();
    this.vertexShader = next;
    old?.releaseBinding();
  }
  psSetShader(value: ID3D11PixelShader | null, instances: readonly ID3D11ClassInstance[]): void {
    this.checkLive();
    if (instances.length) throw new Error('SM4 shaders do not accept class instances');
    const next = this.child(value, IIDS.pixelShader),
      old = this.pixelShader;
    if (next === old) return;
    next?.retainBinding();
    this.pixelShader = next;
    old?.releaseBinding();
  }
  vsGetShader(): {
    shader: ID3D11VertexShader | null;
    classInstances: readonly ID3D11ClassInstance[];
  } {
    this.checkLive();
    return {shader: owned(this.vertexShader), classInstances: []};
  }
  psGetShader(): {
    shader: ID3D11PixelShader | null;
    classInstances: readonly ID3D11ClassInstance[];
  } {
    this.checkLive();
    return {shader: owned(this.pixelShader), classInstances: []};
  }
  iaSetInputLayout(value: ID3D11InputLayout | null): void {
    this.checkLive();
    const next = this.child(value, IIDS.layout),
      old = this.inputLayout;
    if (next === old) return;
    next?.retainBinding();
    this.inputLayout = next;
    old?.releaseBinding();
  }
  iaGetInputLayout(): ID3D11InputLayout | null {
    this.checkLive();
    return owned(this.inputLayout);
  }

  iaSetVertexBuffers(
    start: number,
    values: readonly (ID3D11Buffer | null)[],
    strides: readonly number[],
    offsets: readonly number[],
  ): void {
    this.checkLive();
    slots(start, values.length, 32);
    if (strides.length !== values.length || offsets.length !== values.length)
      throw new Error('Invalid D3D11 vertex-buffer layout');
    for (let i = 0; i < values.length; i++)
      if (!uint(strides[i]!) || strides[i]! > 2048 || !uint(offsets[i]!))
        throw new Error('Invalid D3D11 vertex-buffer layout');
    const buffers: (D3d11Buffer | null)[] = [];
    for (let i = 0; i < values.length; i++) buffers.push(this.buffer(values[i]!, 1));
    for (let i = 0; i < values.length; i++) {
      this.vertexStrides[start + i] = strides[i]!;
      this.vertexOffsets[start + i] = offsets[i]!;
    }
    this.replaceRange(this.vertexBuffers, start, buffers);
  }
  iaGetVertexBuffers(
    start: number,
    count: number,
  ): {
    buffers: readonly (ID3D11Buffer | null)[];
    strides: readonly number[];
    offsets: readonly number[];
  } {
    this.checkLive();
    slots(start, count, 32);
    return {
      buffers: this.vertexBuffers.slice(start, start + count).map(owned),
      strides: this.vertexStrides.slice(start, start + count),
      offsets: this.vertexOffsets.slice(start, start + count),
    };
  }
  iaSetIndexBuffer(value: ID3D11Buffer | null, format: number, offset: number): void {
    this.checkLive();
    if (
      ![0, 42, 57].includes(format) ||
      !uint(offset) ||
      (value !== null && (format === 0 || offset % (format === 42 ? 4 : 2) !== 0))
    )
      throw new Error('Invalid D3D11 index-buffer layout');
    const next = this.buffer(value, 2),
      old = this.indexBuffer;
    next?.retainBinding();
    this.indexBuffer = next;
    this.indexFormat = format;
    this.indexOffset = offset;
    old?.releaseBinding();
  }
  iaGetIndexBuffer(): {buffer: ID3D11Buffer | null; format: number; offset: number} {
    this.checkLive();
    return {buffer: owned(this.indexBuffer), format: this.indexFormat, offset: this.indexOffset};
  }
  iaSetPrimitiveTopology(value: number): void {
    this.checkLive();
    if (
      ![0, 1, 2, 3, 4, 5, 10, 11, 12, 13].includes(value) &&
      !(uint(value) && value >= 33 && value <= 64)
    )
      throw new Error('Invalid D3D11 primitive topology');
    this.topology = value;
  }
  iaGetPrimitiveTopology(): number {
    this.checkLive();
    return this.topology;
  }

  omSetRenderTargets(
    values: readonly (ID3D11RenderTargetView | null)[],
    depth: ID3D11DepthStencilView | null,
  ): void {
    this.checkLive();
    slots(0, values.length, 8);
    const targets = values.map((v) => this.view<Rtv>(v, 'render-target')),
      nextDepth = this.view<Dsv>(depth, 'depth-stencil');
    const active = [...targets, nextDepth].filter((v): v is Rtv | Dsv => v !== null);
    const dimensions = (v: Rtv | Dsv) => {
      const d = v.resource.getDesc();
      return [Math.max(1, d.width >> v.firstMip), Math.max(1, d.height >> v.firstMip)];
    };
    if (active.length) {
      const [width, height] = dimensions(active[0]!);
      if (
        active.some((v, i) => {
          const [w, h] = dimensions(v);
          return w !== width || h !== height || active.slice(0, i).some((old) => overlaps(v, old));
        })
      )
        throw new Error('Incompatible D3D11 output views');
    }
    for (const v of active) v.retainBinding();
    const old: (D3d11Object | null)[] = [...this.renderTargets, this.depthTarget];
    this.renderTargets.fill(null);
    targets.forEach((v, i) => {
      this.renderTargets[i] = v;
    });
    this.depthTarget = nextDepth;
    for (let i = 0; i < this.psResources.length; i++) {
      const view = this.psResources[i];
      if (view && this.outputConflict(view)) {
        this.psResources[i] = null;
        old.push(view);
      }
    }
    releaseAll(old);
  }
  private outputConflict(view: Srv): boolean {
    return (
      this.renderTargets.some((target) => target !== null && overlaps(view, target)) ||
      (this.depthTarget !== null &&
        (this.depthTarget.getDesc().flags & 3) !== 3 &&
        overlaps(view, this.depthTarget))
    );
  }
  omGetRenderTargets(count: number): {
    views: readonly (ID3D11RenderTargetView | null)[];
    depthStencilView: ID3D11DepthStencilView | null;
  } {
    this.checkLive();
    slots(0, count, 8);
    return {
      views: this.renderTargets.slice(0, count).map(owned),
      depthStencilView: owned(this.depthTarget),
    };
  }

  omSetBlendState(
    value: ID3D11BlendState | null,
    factor: readonly [number, number, number, number] | null,
    mask: number,
  ): void {
    this.checkLive();
    const next = this.state<D3d11BlendDesc>(value, 'blend');
    if (
      !uint(mask) ||
      (factor !== null &&
        (factor.length !== 4 || !factor.every((n) => Number.isFinite(Math.fround(n)))))
    )
      throw new Error('Invalid D3D11 blend factors');
    const old = this.blendState;
    next?.retainBinding();
    this.blendState = next;
    this.blendFactor = factor
      ? [
          Math.fround(factor[0]),
          Math.fround(factor[1]),
          Math.fround(factor[2]),
          Math.fround(factor[3]),
        ]
      : [1, 1, 1, 1];
    this.sampleMask = mask;
    old?.releaseBinding();
  }
  omGetBlendState(): {
    state: ID3D11BlendState | null;
    blendFactor: readonly [number, number, number, number];
    sampleMask: number;
  } {
    this.checkLive();
    return {
      state: owned(this.blendState),
      blendFactor: [...this.blendFactor],
      sampleMask: this.sampleMask,
    };
  }
  omSetDepthStencilState(value: ID3D11DepthStencilState | null, ref: number): void {
    this.checkLive();
    if (!uint(ref)) throw new Error('Invalid D3D11 stencil reference');
    const next = this.state<D3d11DepthStencilDesc>(value, 'depth-stencil'),
      old = this.depthState;
    next?.retainBinding();
    this.depthState = next;
    this.stencilRef = ref;
    old?.releaseBinding();
  }
  omGetDepthStencilState(): {state: ID3D11DepthStencilState | null; stencilRef: number} {
    this.checkLive();
    return {state: owned(this.depthState), stencilRef: this.stencilRef};
  }
  rsSetState(value: ID3D11RasterizerState | null): void {
    this.checkLive();
    const next = this.state<D3d11RasterizerDesc>(value, 'rasterizer'),
      old = this.rasterState;
    next?.retainBinding();
    this.rasterState = next;
    old?.releaseBinding();
  }
  rsGetState(): ID3D11RasterizerState | null {
    this.checkLive();
    return owned(this.rasterState);
  }
  rsSetViewports(values: readonly D3d11Viewport[]): void {
    this.checkLive();
    slots(0, values.length, 16);
    const next = values.map((v) => ({
      topLeftX: Math.fround(v.topLeftX),
      topLeftY: Math.fround(v.topLeftY),
      width: Math.fround(v.width),
      height: Math.fround(v.height),
      minDepth: Math.fround(v.minDepth),
      maxDepth: Math.fround(v.maxDepth),
    }));
    if (
      next.some(
        (v) =>
          !Object.values(v).every(Number.isFinite) ||
          v.width < 0 ||
          v.height < 0 ||
          v.topLeftX < -32768 ||
          v.topLeftY < -32768 ||
          v.topLeftX + v.width > 32767 ||
          v.topLeftY + v.height > 32767 ||
          v.minDepth < 0 ||
          v.maxDepth > 1 ||
          v.minDepth > v.maxDepth,
      )
    )
      throw new Error('Invalid D3D11 viewports');
    this.viewports = next;
  }
  rsGetViewports(): readonly D3d11Viewport[] {
    this.checkLive();
    return this.viewports.map((v) => ({...v}));
  }
  rsSetScissorRects(values: readonly D3d11Rect[]): void {
    this.checkLive();
    slots(0, values.length, 16);
    if (
      values.some(
        (v) =>
          ![v.left, v.top, v.right, v.bottom].every(int) || v.right < v.left || v.bottom < v.top,
      )
    )
      throw new Error('Invalid D3D11 scissor rectangles');
    this.scissorRects = values.map((v) => ({...v}));
  }
  rsGetScissorRects(): readonly D3d11Rect[] {
    this.checkLive();
    return this.scissorRects.map((v) => ({...v}));
  }

  /** Internal lifetime teardown also calls this after the last external reference closes. */
  disposeBindings(): void {
    const old = [
      ...this.vsBuffers,
      ...this.psBuffers,
      ...this.psResources,
      ...this.psSamplers,
      this.vertexShader,
      this.pixelShader,
      this.inputLayout,
      ...this.vertexBuffers,
      this.indexBuffer,
      ...this.renderTargets,
      this.depthTarget,
      this.blendState,
      this.depthState,
      this.rasterState,
    ];
    this.vsBuffers.fill(null);
    this.psBuffers.fill(null);
    this.psResources.fill(null);
    this.psSamplers.fill(null);
    this.vertexShader = null;
    this.pixelShader = null;
    this.inputLayout = null;
    this.vertexBuffers.fill(null);
    this.vertexStrides.fill(0);
    this.vertexOffsets.fill(0);
    this.indexBuffer = null;
    this.indexFormat = 0;
    this.indexOffset = 0;
    this.topology = 0;
    this.renderTargets.fill(null);
    this.depthTarget = null;
    this.blendState = null;
    this.blendFactor = [1, 1, 1, 1];
    this.sampleMask = 0xffffffff;
    this.depthState = null;
    this.stencilRef = 0;
    this.rasterState = null;
    this.viewports = [];
    this.scissorRects = [];
    releaseAll(old);
  }
  clearState(): void {
    this.checkLive();
    this.disposeBindings();
  }
  getType(): number {
    return 0;
  }
  getContextFlags(): number {
    return 0;
  }
}
