import type {EmoteTexture, EmoteX64Model} from '../../../../formats/kirikiri/emote-model.js';
import type {
  D3d11Result,
  D3d11DepthStencilDesc,
  IUnknown,
  ID3D11Device,
  ID3D11DeviceContext,
  ID3D11Texture2D,
  ID3D11RenderTargetView,
  ID3D11DepthStencilView,
  ID3D11ShaderResourceView,
  ID3D11BlendState,
  ID3D11DepthStencilState,
  ID3D11RasterizerState,
  ID3D11SamplerState,
} from '../../../d3d11/contract.js';
import type {EmoteScalarDrawItem, EmoteScalarVertexGrid} from '../interfaces.js';
import {EmoteUnsupportedError} from '../errors.js';
import {packEmoteD3d11Mesh, drawEmoteD3d11Mesh, type EmoteD3d11MeshScratch} from './d3d11-mesh.js';
import {
  EmoteD3d11Shaders,
  emoteD3d11BasicShader,
  emoteD3d11BufferedShader,
  emoteD3d11MaskShader,
  emoteD3d11AlphaShader,
  type EmoteD3d11ColorMode,
} from './d3d11-shaders.js';
import {EmoteD3d11Textures, type EmoteD3d11Texture} from './d3d11-textures.js';

/** Internal target binding. Every object is a native contract interface. */
export interface EmoteD3d11RenderTarget {
  readonly texture: ID3D11Texture2D;
  readonly view: ID3D11RenderTargetView;
  readonly depth: ID3D11DepthStencilView | null;
  readonly width: number;
  readonly height: number;
  readonly subresource: number;
}
interface OwnedTarget extends EmoteD3d11RenderTarget {
  readonly shaderView: ID3D11ShaderResourceView;
}
/** Every input of one stencil chain's mask passes: numbers, then the atlas of each draw. */
interface MaskKey {
  readonly numbers: Float64Array;
  readonly textures: readonly (EmoteD3d11Texture | null)[];
}
function sameMaskKey(a: MaskKey | undefined, b: MaskKey): boolean {
  if (!a || a.numbers.length !== b.numbers.length || a.textures.length !== b.textures.length)
    return false;
  for (let i = 0; i < b.numbers.length; i++) if (a.numbers[i] !== b.numbers[i]) return false;
  for (let i = 0; i < b.textures.length; i++) if (a.textures[i] !== b.textures[i]) return false;
  return true;
}
interface Mesh {
  readonly grid: EmoteScalarVertexGrid;
  readonly texture: EmoteD3d11Texture | null;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
type Pass = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const f = Math.fround,
  MAX = f(3.4028234663852886e38);
const WHITE = Uint32Array.of(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff);
const ZERO: readonly [number, number, number, number] = [0, 0, 0, 0];
const BLUR_STEPS = [1, 2, 3, 6, 9] as const;
const BLUR_EXPAND = [1, 2, 2, 4, 6] as const;
/** Native 0x1800915d0: op/src/dest for color, then op/src/dest for alpha. */
const BLENDS = [
  [1, 5, 6, 1, 2, 6],
  [1, 5, 2, 1, 1, 2],
  [3, 5, 2, 1, 1, 2],
  [1, 9, 6, 1, 1, 2],
  [1, 10, 2, 1, 1, 2],
  [3, 5, 2, 1, 1, 2],
  [1, 5, 6, 1, 2, 6],
  [1, 8, 7, 1, 1, 2],
  [1, 2, 1, 1, 1, 2],
  [1, 5, 6, 1, 2, 6],
  [1, 1, 6, 1, 1, 6],
  [1, 2, 1, 1, 1, 2],
  [1, 2, 1, 1, 1, 2],
] as const;
const flagBits = new DataView(new ArrayBuffer(4));
function flagFloat(word: number): number {
  flagBits.setUint32(0, word >>> 0, true);
  return flagBits.getFloat32(0, true);
}
/** Items the draw pass never submits. */
function skipped(item: EmoteScalarDrawItem): boolean {
  return item.blank || item.opa === 0 || (item.bm & 0xff0f) === 6;
}
function uintOf(value: number): number {
  const n = Math.trunc(value);
  return (Number.isFinite(n) && n >= -0x80000000 && n <= 0x7fffffff ? n : -0x80000000) >>> 0;
}
function boundsOf(grid: EmoteScalarVertexGrid): Float32Array {
  let x0 = MAX,
    y0 = MAX,
    x1 = -MAX,
    y1 = -MAX;
  const n = (grid.cols + 1) * (grid.rows + 1) * 2;
  for (let i = 0; i < n; i += 2) {
    const x = grid.points[i]!,
      y = grid.points[i + 1]!;
    if (x <= x0) x0 = x;
    if (y <= y0) y0 = y;
    if (x1 <= x) x1 = x;
    if (y1 <= y) y1 = y;
  }
  return Float32Array.of(x0, y0, x1, y1);
}

const COPY_SPARES = 4;

function releaseOwnedTarget(target: OwnedTarget): void {
  const errors: unknown[] = [];
  for (const object of [target.shaderView, target.view, target.texture])
    try {
      object.release();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, 'E-mote target retirement failed');
}

/**
 * Device-owned slot for one released set of mask targets. Mask passes clear a target
 * before drawing into or sampling it, so the next renderer of the same output size can
 * take the set instead of creating full-output targets.
 */
export class EmoteD3d11MaskPool {
  private idle: OwnedTarget[] | null = null;
  /** Inputs of the finished mask each target holds, shared by the renderers that take it.
   * Keys compare atlases by identity, so only a still-live reused atlas can match. */
  readonly keys = new WeakMap<OwnedTarget, MaskKey>();
  /** Retired destination-copy targets. A taken target has exactly the size the native
   * policy asked for, so its first copy overwrites all of it, as with a fresh one. */
  private readonly copies: OwnedTarget[] = [];

  take(width: number, height: number): OwnedTarget[] | null {
    const set = this.idle;
    if (!set || set[0]!.width !== width || set[0]!.height !== height) return null;
    this.idle = null;
    return set;
  }

  keep(set: OwnedTarget[]): void {
    const old = this.idle;
    this.idle = set;
    if (old) this.release(old);
  }

  takeCopy(width: number, height: number, format: number): OwnedTarget | null {
    const i = this.copies.findIndex(
      (t) => t.width === width && t.height === height && t.texture.getDesc().format === format,
    );
    return i < 0 ? null : this.copies.splice(i, 1)[0]!;
  }

  keepCopy(target: OwnedTarget): void {
    this.copies.push(target);
    if (this.copies.length > COPY_SPARES) releaseOwnedTarget(this.copies.shift()!);
  }

  dispose(): void {
    const old = this.idle;
    this.idle = null;
    if (old) this.release(old);
    this.release(this.copies.splice(0));
  }

  private release(pair: readonly OwnedTarget[]): void {
    const errors: unknown[] = [];
    for (const target of pair)
      try {
        releaseOwnedTarget(target);
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, 'E-mote mask retirement failed');
  }
}

/**
 * The x64 scalar draw pass (0x180006430/0x1800069a0) over native D3D11 resources.
 * Exact image: 80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051.
 * The device owns shaders/textures and the supplied target. This renderer owns its
 * atlas references, mask/copy targets and fixed draw states. No browser objects or
 * callbacks cross the DLL contract. The caller supplies native modelViewProj words.
 */
export class EmoteD3d11Renderer {
  private readonly owned: IUnknown[] = [];
  private readonly blends: ID3D11BlendState[] = [];
  private readonly raster: ID3D11RasterizerState;
  private readonly depth: ID3D11DepthStencilState;
  private readonly nearest: ID3D11SamplerState;
  private readonly linear: ID3D11SamplerState;
  private readonly stencilBlend: ID3D11BlendState;
  private readonly used = new Map<EmoteTexture, EmoteD3d11Texture>();
  private readonly sources = new WeakMap<EmoteX64Model, (EmoteTexture | null)[]>();
  private readonly screenMulOffset = new Float32Array(4);
  private readonly bounds = Float32Array.of(MAX, MAX, -MAX, -MAX);
  private readonly corners = new Uint32Array(4);
  private readonly filterColor = new Float32Array(4);
  private readonly packed: EmoteD3d11MeshScratch = {bytes: new Uint8Array(0)};
  private masks: OwnedTarget[] = [];
  /** Inputs of the chain whose finished mask a target holds; drawing into it forgets them.
   * Pooled targets keep them, so the next renderer of a same-file player can reuse a mask. */
  private readonly maskKeys: WeakMap<OwnedTarget, MaskKey>;
  /** Alpha masks of this frame's stencil chains, built before the output pass. */
  private readonly built = new Map<EmoteScalarDrawItem, OwnedTarget>();
  private copy: OwnedTarget | null = null;
  private output: EmoteD3d11RenderTarget | null = null;
  private target: EmoteD3d11RenderTarget | null = null;
  private matrix: Float32Array | null = null;
  private mask: OwnedTarget | null = null;
  private smoothing = true;
  private maskMode = 1;
  private stencilActive = false;
  private pass: Pass = 0;
  private alphaTest = false;
  private alphaMul = 1;
  private alphaAdd = 0;
  private grayscaleMode = 0;
  private grayscaleLevel = 0;
  private closed = false;
  private rendering = false;

  constructor(
    private readonly device: ID3D11Device,
    private readonly context: ID3D11DeviceContext,
    private readonly shaders: EmoteD3d11Shaders,
    private readonly textures: EmoteD3d11Textures,
    private readonly maskPool: EmoteD3d11MaskPool | null = null,
  ) {
    this.maskKeys = maskPool?.keys ?? new WeakMap();
    try {
      for (const [
        i,
        [blendOp, srcBlend, destBlend, blendOpAlpha, srcBlendAlpha, destBlendAlpha],
      ] of BLENDS.entries())
        this.blends.push(
          this.take(
            device.createBlendState({
              alphaToCoverageEnable: false,
              independentBlendEnable: false,
              renderTarget: Array.from({length: 8}, (_, target) =>
                target === 0
                  ? {
                      blendEnable: i !== 8,
                      blendOp,
                      srcBlend,
                      destBlend,
                      blendOpAlpha,
                      srcBlendAlpha,
                      destBlendAlpha,
                      renderTargetWriteMask: 15,
                    }
                  : {
                      blendEnable: false,
                      blendOp: 0,
                      srcBlend: 0,
                      destBlend: 0,
                      blendOpAlpha: 0,
                      srcBlendAlpha: 0,
                      destBlendAlpha: 0,
                      renderTargetWriteMask: 0,
                    },
              ),
            }),
          ),
        );
      const blend = this.blends[8]!.getDesc();
      this.stencilBlend = this.take(
        device.createBlendState({
          ...blend,
          renderTarget: blend.renderTarget.map((target) => ({...target, renderTargetWriteMask: 0})),
        }),
      );
      const face = {stencilFailOp: 1, stencilDepthFailOp: 1, stencilPassOp: 1, stencilFunc: 8};
      this.depth = this.take(
        device.createDepthStencilState({
          depthEnable: false,
          depthWriteMask: 0,
          depthFunc: 8,
          stencilEnable: false,
          stencilReadMask: 0,
          stencilWriteMask: 0,
          frontFace: face,
          backFace: face,
        }),
      );
      this.raster = this.take(
        device.createRasterizerState({
          fillMode: 3,
          cullMode: 1,
          frontCounterClockwise: false,
          depthBias: 0,
          depthBiasClamp: 0,
          slopeScaledDepthBias: 0,
          depthClipEnable: false,
          scissorEnable: true,
          multisampleEnable: false,
          antialiasedLineEnable: false,
        }),
      );
      const sampler = (filter: number) =>
        this.take(
          device.createSamplerState({
            filter,
            addressU: 3,
            addressV: 3,
            addressW: 1,
            mipLodBias: 0,
            maxAnisotropy: 2,
            comparisonFunc: 1,
            borderColor: ZERO,
            minLod: -MAX,
            maxLod: MAX,
          }),
        );
      this.nearest = sampler(0);
      this.linear = sampler(21);
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'E-mote renderer construction and cleanup failed',
        );
      }
      throw error;
    }
  }

  /** Native resource load (0x180030900) creates every file source before Core construction. */
  loadModelSources(model: EmoteX64Model): void {
    if (this.closed) throw new Error('Using a released E-mote renderer');
    for (const {texture} of model.sources.values())
      if (texture && !this.used.has(texture))
        this.used.set(texture, this.textures.acquire(texture, model.spec));
  }

  /** Native render draws into the caller's target; clearing belongs to the compositor. */
  render(
    items: readonly EmoteScalarDrawItem[],
    output: EmoteD3d11RenderTarget,
    modelViewProj: Float32Array,
    smoothing: boolean,
    maskMode = 1,
  ): void {
    if (this.closed) throw new Error('Using a released E-mote renderer');
    if (this.rendering) throw new Error('Reentrant E-mote rendering');
    if (modelViewProj.length !== 16) throw new Error('Invalid E-mote modelViewProj');
    this.rendering = true;
    this.output = output;
    this.matrix = modelViewProj;
    this.smoothing = smoothing;
    this.maskMode = maskMode | 0;
    this.pass = 0;
    this.mask = null;
    try {
      // An empty frame draws nothing and leaves idle atlases for the next draw.
      if (items.length) this.textures.retireIdle();
      const order = items.map((item, index) => ({item, index})),
        seen = new Set<EmoteScalarDrawItem>();
      for (const {item} of order) this.prepare(item, seen);
      order.sort(
        (a, b) =>
          a.item.z - b.item.z ||
          flagFloat(a.item.clipFlags) - flagFloat(b.item.clipFlags) ||
          a.index - b.index,
      );
      if (this.maskMode === 1) this.buildMasks(order);
      this.bind(output);
      let group: EmoteScalarDrawItem | null = null;
      for (const {item} of order) {
        if (skipped(item)) continue;
        if (item.stencilParent !== group) {
          group = item.stencilParent;
          const built = group && this.built.get(group);
          if (built) {
            this.mask = built;
            this.pass = 6;
          } else if (group) this.buildMask(group);
          else {
            if (this.stencilActive) this.setStencil(0, null);
            this.mask = null;
            this.pass = 0;
          }
        }
        this.drawItem(item);
      }
    } finally {
      try {
        if (this.stencilActive) this.setStencil(0, null);
      } finally {
        // Texture references retained by native context bindings are independent of ours.
        this.built.clear();
        this.pass = 0;
        this.mask = null;
        this.stencilActive = false;
        this.target = this.output = null;
        this.matrix = null;
        this.rendering = false;
      }
    }
  }

  dispose(): void {
    if (this.closed) return;
    if (this.rendering) throw new Error('Releasing the active E-mote renderer');
    this.closed = true;
    const errors: unknown[] = [];
    for (const source of this.used.keys())
      try {
        this.textures.release(source);
      } catch (error) {
        errors.push(error);
      }
    this.used.clear();
    if (this.masks.length && this.maskPool)
      try {
        this.maskPool.keep(this.masks);
      } catch (error) {
        errors.push(error);
      }
    else
      for (const target of this.masks)
        try {
          this.releaseTarget(target);
        } catch (error) {
          errors.push(error);
        }
    if (this.copy)
      try {
        this.retireCopy(this.copy);
      } catch (error) {
        errors.push(error);
      }
    this.masks = [];
    this.copy = null;
    for (const object of this.owned.splice(0).reverse())
      try {
        object.release();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, 'E-mote renderer retirement failed');
  }

  private take<T extends IUnknown>(result: D3d11Result<T>): T {
    if (result.hr !== 0 || !result.value)
      throw new Error(`E-mote draw state creation failed: ${result.hr}`);
    this.owned.push(result.value);
    return result.value;
  }

  private textureOf(item: EmoteScalarDrawItem): EmoteD3d11Texture | null {
    const file = item.file;
    if (!file) return null;
    let sources = this.sources.get(file);
    if (!sources)
      this.sources.set(file, (sources = [...file.sources.values()].map((s) => s.texture)));
    const source = sources[item.texIndex];
    if (!source) return null;
    let value = this.used.get(source);
    if (!value) this.used.set(source, (value = this.textures.acquire(source, file.spec)));
    return value;
  }

  private prepare(item: EmoteScalarDrawItem, seen: Set<EmoteScalarDrawItem>): void {
    if (seen.has(item)) return;
    seen.add(item);
    this.textureOf(item);
    for (const child of item.composite) this.prepare(child, seen);
    if (item.stencilParent) this.prepare(item.stencilParent, seen);
  }

  private mesh(item: EmoteScalarDrawItem): Mesh {
    if (!item.grid) throw new Error('E-mote draw item without a vertex grid');
    return {
      grid: item.grid,
      texture: this.textureOf(item),
      left: item.left,
      top: item.top,
      width: item.width,
      height: item.height,
    };
  }

  private bind(
    target: EmoteD3d11RenderTarget,
    clear?: readonly [number, number, number, number],
  ): void {
    const ctx = this.context;
    ctx.psSetShaderResources(0, [null, null, null]);
    ctx.omSetRenderTargets([target.view], target.depth);
    // Native0x1800619e0 binds the views without replacing the caller's viewport.
    // Mask targets have the output dimensions and inherit that same viewport.
    ctx.rsSetState(this.raster);
    ctx.rsSetScissorRects([{left: 0, top: 0, right: target.width, bottom: target.height}]);
    ctx.omSetDepthStencilState(this.depth, 0);
    if (clear) ctx.clearRenderTargetView(target.view, clear);
    this.target = target;
  }

  private makeTarget(width: number, height: number, format: number): OwnedTarget {
    const created = this.device.createTexture2D(
      {
        width,
        height,
        format,
        mipLevels: 1,
        arraySize: 1,
        sampleDesc: {count: 1, quality: 0},
        usage: 0,
        bindFlags: 0x28,
        cpuAccessFlags: 0,
        miscFlags: 0,
      },
      null,
    );
    if (created.hr !== 0 || !created.value)
      throw new Error(`E-mote target creation failed: ${created.hr}`);
    const texture = created.value;
    let view: ID3D11RenderTargetView | null = null;
    try {
      const rtv = this.device.createRenderTargetView(texture, null);
      if (rtv.hr !== 0 || !rtv.value) throw new Error(`E-mote target view failed: ${rtv.hr}`);
      view = rtv.value;
      const srv = this.device.createShaderResourceView(texture, null);
      if (srv.hr !== 0 || !srv.value)
        throw new Error(`E-mote target shader view failed: ${srv.hr}`);
      return {texture, view, shaderView: srv.value, width, height, subresource: 0, depth: null};
    } catch (error) {
      view?.release();
      texture.release();
      throw error;
    }
  }

  private releaseTarget(target: OwnedTarget): void {
    releaseOwnedTarget(target);
  }

  private retireCopy(target: OwnedTarget): void {
    if (this.maskPool) this.maskPool.keepCopy(target);
    else releaseOwnedTarget(target);
  }

  /** At least `count` output-sized A8 targets; the first two are the sequential pair. */
  private maskTargets(count: number): OwnedTarget[] {
    const {width, height} = this.output!;
    if (this.masks.length && (this.masks[0]!.width !== width || this.masks[0]!.height !== height)) {
      const old = this.masks;
      this.masks = [];
      for (const target of old) this.releaseTarget(target);
    }
    if (!this.masks.length) this.masks = this.maskPool?.take(width, height) ?? [];
    while (this.masks.length < count) this.masks.push(this.makeTarget(width, height, 65));
    return this.masks;
  }

  /**
   * A chain's alpha mask depends only on its own items, never on the output, so each
   * distinct chain of the frame is built once before the output is bound. The output is
   * then drawn in one pass instead of being rebound after every chain. A chain without
   * intersection or subtraction items samples whatever the pair last held; such frames
   * keep the sequential passes.
   */
  private buildMasks(order: readonly {item: EmoteScalarDrawItem}[]): void {
    const chains: EmoteScalarDrawItem[] = [],
      seen = new Set<EmoteScalarDrawItem>();
    let group: EmoteScalarDrawItem | null = null;
    for (const {item} of order) {
      if (skipped(item) || item.stencilParent === group) continue;
      group = item.stencilParent;
      if (!group || seen.has(group)) continue;
      let drawn = false;
      for (let node: EmoteScalarDrawItem | null = group; node; node = node.stencilParent)
        if ((node.stencilType & 3) === 1 || (node.stencilType & 3) === 2) drawn = true;
      if (!drawn) return;
      seen.add(group);
      chains.push(group);
    }
    if (!chains.length) return;
    const targets = this.maskTargets(chains.length + 1),
      keys = chains.map((chain) => this.maskKey(chain)),
      held = new Set<OwnedTarget>();
    // A target still holding a chain's finished mask from identical inputs is reused as is.
    for (let i = 0; i < chains.length; i++) {
      const hit = targets.find((t) => !held.has(t) && sameMaskKey(this.maskKeys.get(t), keys[i]!));
      if (!hit) continue;
      held.add(hit);
      this.built.set(chains[i]!, hit);
    }
    const free = targets.filter((t) => !held.has(t));
    for (let i = 0; i < chains.length; i++) {
      const chain = chains[i]!;
      if (this.built.has(chain)) continue;
      const pair = [free.pop()!, free.pop()!];
      this.drawMask(chain, pair);
      this.maskKeys.set(pair[0]!, keys[i]!);
      this.built.set(chain, pair[0]!);
      free.push(pair[1]!);
    }
    this.pass = 0;
    this.mask = null;
  }
  /** What `drawMask` reads: frame constants, then each submitted draw in pass order. */
  private maskKey(parent: EmoteScalarDrawItem): MaskKey {
    const numbers: number[] = [this.smoothing ? 1 : 0, this.output!.width, this.output!.height],
      textures: (EmoteD3d11Texture | null)[] = [];
    for (let i = 0; i < 16; i++) numbers.push(this.matrix![i]!);
    const mesh = (item: EmoteScalarDrawItem): void => {
      const {grid, texture, left, top, width, height} = this.mesh(item),
        n = (grid.cols + 1) * (grid.rows + 1) * 2;
      textures.push(texture);
      numbers.push(-1, left, top, width, height, grid.cols, grid.rows);
      for (let i = 0; i < n; i++) numbers.push(grid.points[i]!);
    };
    for (const role of [1, 2])
      for (let item: EmoteScalarDrawItem | null = parent; item; item = item.stencilParent) {
        if ((item.stencilType & 3) !== role) continue;
        numbers.push(
          -2,
          role,
          item.stencilType,
          item.alphaTest ? 1 : 0,
          item.alphaScale,
          item.alphaOffset,
        );
        if (item.stencilType & 4) {
          for (const child of item.composite) if (!child.blank) mesh(child);
        } else if (!item.blank) mesh(item);
      }
    return {numbers: Float64Array.from(numbers), textures};
  }

  private buildMask(parent: EmoteScalarDrawItem): void {
    if (this.maskMode === 0) {
      this.buildStencilMask(parent);
      return;
    }
    if (this.maskMode !== 1) throw new EmoteUnsupportedError(`mask mode ${this.maskMode}`);
    this.drawMask(parent, this.maskTargets(2));
    this.bind(this.output!);
    this.mask = this.masks[0]!;
    this.pass = 6;
  }

  /** Intersections, then subtractions; the result is left in `masks[0]`. */
  private drawMask(parent: EmoteScalarDrawItem, masks: OwnedTarget[]): void {
    this.maskKeys.delete(masks[0]!);
    this.maskKeys.delete(masks[1]!);
    this.pass = 1;
    this.mask = null;
    for (const role of [1, 2])
      for (let item: EmoteScalarDrawItem | null = parent; item; item = item.stencilParent) {
        if ((item.stencilType & 3) !== role) continue;
        this.alphaTest = item.alphaTest;
        this.alphaMul = item.alphaScale;
        if (role === 1) {
          this.alphaAdd = item.alphaOffset;
          if (this.pass === 1) this.pass = 3;
          else {
            this.pass = 4;
            [masks[0], masks[1]] = [masks[1]!, masks[0]!];
            this.mask = masks[1];
          }
          this.bind(masks[0]!, ZERO);
        } else {
          this.alphaAdd = f(f(1 - item.alphaScale) - item.alphaOffset);
          this.mask = null;
          if (this.pass === 1) this.bind(masks[0]!, [1, 1, 1, 1]);
          this.pass = 5;
        }
        if (item.stencilType & 4) {
          for (const child of item.composite)
            if (!child.blank) this.draw(this.mesh(child), WHITE, 4, 0, 0);
        } else if (!item.blank) this.draw(this.mesh(item), WHITE, 4, 0, 0);
      }
  }

  /** Native060a20/060920: preserve depth fields, replace only the stencil description. */
  private setStencil(reference: number, operation: number | null): void {
    const ctx = this.context,
      prior = ctx.omGetDepthStencilState();
    let desc: D3d11DepthStencilDesc;
    try {
      const face = {stencilFailOp: 1, stencilDepthFailOp: 1, stencilPassOp: 1, stencilFunc: 8};
      desc = prior.state?.getDesc() ?? {
        depthEnable: true,
        depthWriteMask: 1,
        depthFunc: 2,
        stencilEnable: false,
        stencilReadMask: 255,
        stencilWriteMask: 255,
        frontFace: face,
        backFace: face,
      };
    } finally {
      prior.state?.release();
    }
    if (operation === null) desc = {...desc, stencilEnable: false};
    else {
      // EQUAL with wrapping INCR/DECR for masks, KEEP for the color pass.
      const face = {
        stencilFailOp: 1,
        stencilDepthFailOp: operation,
        stencilPassOp: operation,
        stencilFunc: 3,
      };
      desc = {
        ...desc,
        stencilEnable: true,
        stencilReadMask: 255,
        stencilWriteMask: 255,
        frontFace: face,
        backFace: face,
      };
    }
    const state = this.contextState(this.device.createDepthStencilState(desc));
    try {
      ctx.omSetDepthStencilState(state, operation === null ? prior.stencilRef : reference >>> 0);
      this.stencilActive = operation !== null;
    } finally {
      state.release();
    }
  }

  /** A temporary COM reference transferred to the context, not retained by this renderer. */
  private contextState<T extends IUnknown>(result: D3d11Result<T>): T {
    if (result.hr !== 0 || !result.value) {
      result.value?.release();
      throw new Error(`E-mote stencil state creation failed: ${result.hr}`);
    }
    return result.value;
  }

  /** Native060b40/69a0: clear, intersections, subtractions, then the equality color pass. */
  private buildStencilMask(parent: EmoteScalarDrawItem): void {
    let reference = 0;
    for (let node: EmoteScalarDrawItem | null = parent; node; node = node.stencilParent)
      if ((node.stencilType & 3) === 2) {
        reference = 1;
        break;
      }
    const depth = this.output!.depth;
    if (depth && depth.getDesc().format === 45)
      this.context.clearDepthStencilView(depth, 2, 0, reference);
    this.mask = null;
    this.pass = 2;
    for (const role of [1, 2])
      for (let node: EmoteScalarDrawItem | null = parent; node; node = node.stencilParent) {
        if ((node.stencilType & 3) !== role) continue;
        this.setStencil(reference, role === 1 ? 7 : 8);
        if (role === 1) reference++;
        if (node.stencilType & 4) {
          for (const child of node.composite)
            if (!child.blank) this.draw(this.mesh(child), WHITE, 4, 0, 0);
        } else if (!node.blank) this.draw(this.mesh(node), WHITE, 4, 0, 0);
      }
    this.setStencil(reference, 1);
    this.pass = 6;
  }

  private drawItem(item: EmoteScalarDrawItem): void {
    this.grayscaleMode = item.grayscaleMode;
    this.grayscaleLevel = item.grayscaleLevel;
    const bm = item.bm >>> 0,
      op = bm & 0xff0f;
    if ((bm & 0xf00) === 0x100 && op !== 0x10d) this.bounds.set(boundsOf(item.grid!));
    const c = item.colors,
      colors = this.corners;
    for (const [out, source] of [0, 1, 3, 2].entries()) {
      const color = c[source]!;
      colors[out] = ((color << 24) | (color >>> 8)) >>> 0;
    }
    const mesh = this.mesh(item);
    if (op !== 0x10d) {
      this.draw(mesh, colors, item.attr, bm, item.bmParam);
      return;
    }
    let radius = Math.trunc(
      f(f(Math.max(this.target!.width, this.target!.height) * item.bmParam) + 0.5),
    );
    while (radius >= 1) {
      let i = 4;
      while (radius < BLUR_STEPS[i]!) i--;
      radius -= BLUR_STEPS[i]!;
      for (const parameter of [i, i + 5]) {
        this.bounds.set(boundsOf(mesh.grid));
        this.draw(mesh, colors, item.attr, bm, parameter);
      }
    }
  }

  private draw(mesh: Mesh, colors: Uint32Array, attr: number, bm: number, parameter: number): void {
    if (this.pass === 1) throw new Error('E-mote draw before mask passes');
    const k = mesh.texture?.kind ?? 0,
      a: EmoteD3d11ColorMode = attr & 4 ? 0 : bm & 0x10 ? 8 : 4,
      masked = this.mask !== null;
    let index: number;
    if (this.pass === 2) {
      index = emoteD3d11AlphaShader(k);
    } else if (this.pass === 3 || this.pass === 4 || this.pass === 5) {
      index = emoteD3d11MaskShader(k, this.alphaTest, (this.pass - 3) as 0 | 1 | 2);
    } else if ((bm & 0xf00) === 0x100) {
      this.destinationCopy(bm, parameter);
      const op = bm & 0xff0f;
      let formula = 1;
      if (op >= 0x101 && op <= 0x10c) formula = op - 0x101 + 2;
      else if (op === 0x10d) formula = 14 + (uintOf(parameter) % 5);
      index = emoteD3d11BufferedShader(k, a, masked ? 1 : 0, formula);
    } else {
      const op = bm & 0xff0f,
        filter = [0, 3, 6, 9, 12][this.grayscaleMode] ?? 0;
      index = emoteD3d11BasicShader(
        k,
        a,
        masked ? 1 : 0,
        filter,
        op === 3 || op === 4 ? 2 : op === 5 ? 1 : 0,
      );
    }
    const pixel = this.shaders.pixel(index),
      target = this.target!;
    pixel.setFloats('screenMul', [f(1 / target.width), f(1 / target.height)]);
    if (this.pass === 2) {
      pixel.setFloats('alphaRef', [f(64 / 255)]);
      pixel.setFloats('filterColor', [1, 1, 1, 1]);
    } else if (this.pass === 3 || this.pass === 4 || this.pass === 5)
      pixel.setFloats('alphaMulAdd', [this.alphaMul, this.alphaAdd, 0, 0]);
    else if ((bm & 0xf00) === 0x100) {
      pixel.setFloats('screenMulOffset', this.screenMulOffset);
      pixel.setFloats('blendParam', this.blendParam(bm & 0xff0f, parameter));
    } else {
      const level = this.grayscaleLevel >>> 0,
        filter = this.filterColor;
      filter[0] = (level >>> 24) / 255;
      filter[1] = ((level >>> 16) & 255) / 255;
      filter[2] = ((level >>> 8) & 255) / 255;
      filter[3] = (level & 255) / 255;
      pixel.setFloats('filterColor', filter);
    }
    const blendIndex =
      this.pass === 2
        ? 8
        : this.pass === 3 || this.pass === 4
          ? 9
          : this.pass === 5
            ? 10
            : (bm & 0xf00) === 0x100
              ? 11
              : bm & 0xff0f;
    const blend = this.pass === 2 ? this.stencilBlend : this.blends[blendIndex];
    if (!blend) throw new EmoteUnsupportedError(`blend mode 0x${bm.toString(16)}`);
    const ctx = this.context,
      vertex = this.shaders.vertex(1);
    ctx.psSetShaderResources(0, [
      mesh.texture?.view ?? null,
      this.mask?.shaderView ?? null,
      (bm & 0xf00) === 0x100 ? (this.copy?.shaderView ?? null) : null,
    ]);
    ctx.psSetSamplers(0, [this.smoothing ? this.linear : this.nearest, this.nearest, this.nearest]);
    ctx.omSetBlendState(blend, ZERO, 0xffffffff);
    vertex.setFloats('modelViewProj', this.matrix!);
    vertex.bind(ctx);
    pixel.bind(ctx);
    drawEmoteD3d11Mesh(
      this.device,
      ctx,
      packEmoteD3d11Mesh(
        mesh.grid,
        colors,
        mesh.left,
        mesh.top,
        mesh.width,
        mesh.height,
        mesh.texture?.width ?? 1,
        mesh.texture?.height ?? 1,
        this.packed,
      ),
    );
  }

  private project(x: number, y: number): [number, number] {
    const matrix = this.matrix!,
      target = this.output!;
    // VS1 emits dp3 against each constant register's x/y/w words. These are
    // native upload words, rather than WebGL's column-major array indexing.
    const cx = f(f(f(f(x * matrix[0]!) + f(y * matrix[1]!)) + f(0 * matrix[2]!)) + matrix[3]!),
      cy = f(f(f(f(x * matrix[4]!) + f(y * matrix[5]!)) + f(0 * matrix[6]!)) + matrix[7]!),
      cw = f(f(f(f(x * matrix[12]!) + f(y * matrix[13]!)) + f(0 * matrix[14]!)) + matrix[15]!);
    return [
      f(f(f(cx / cw) * f(target.width / 2)) + f(target.width / 2)),
      f(f(f(cy / cw) * f(-target.height / 2)) + f(target.height / 2)),
    ];
  }

  private mosaicSize(parameter: number): number {
    if (!(parameter >= 0)) return -parameter;
    return Math.ceil(
      f(f(Math.max(this.target!.width, this.target!.height)) / (parameter <= 1 ? 1 : parameter)),
    );
  }

  private destinationCopy(bm: number, parameter: number): void {
    const target = this.target!,
      w = target.width,
      h = target.height,
      op = bm & 0xff0f,
      b = this.bounds;
    let x0 = 0,
      y0 = 0,
      x1 = w,
      y1 = h;
    if (!(b[2]! < b[0]! || b[3]! < b[1]!)) {
      // 0x180060040 projects all four corners before reducing. Two diagonal
      // points do not enclose rotated or perspective-transformed rectangles.
      let first = true;
      for (const [x, y] of [
        [b[0]!, b[1]!],
        [b[2]!, b[1]!],
        [b[2]!, b[3]!],
        [b[0]!, b[3]!],
      ]) {
        const [px, py] = this.project(x!, y!);
        if (first) {
          x0 = x1 = px;
          y0 = y1 = py;
          first = false;
        } else {
          if (px < x0) x0 = px;
          if (py < y0) y0 = py;
          if (x1 <= px) x1 = px;
          if (y1 <= py) y1 = py;
        }
      }
    }
    if (op === 0x10c) {
      const s = this.mosaicSize(parameter);
      x0 = f(Math.floor(f(x0 / s)) * s);
      y0 = f(Math.floor(f(y0 / s)) * s);
      x1 = f(Math.ceil(f(x1 / s)) * s);
      y1 = f(Math.ceil(f(y1 / s)) * s);
    } else if (op === 0x10d) {
      const i = uintOf(parameter),
        r = BLUR_EXPAND[i % 5]!;
      if (i < 5) {
        x0 = f(x0 - r);
        x1 = f(x1 + r);
      } else {
        y0 = f(y0 - r);
        y1 = f(y1 + r);
      }
    }
    y1 = Math.min(Math.ceil(y1), h);
    x1 = Math.min(Math.ceil(x1), w);
    y0 = Math.max(Math.floor(y0), 0);
    x0 = Math.max(Math.floor(x0), 0);
    const width = x1 - x0,
      height = y1 - y0;
    if (width <= 0 || height <= 0) return;
    const cw = this.copy?.width ?? 0,
      ch = this.copy?.height ?? 0;
    if (width < cw * 0.5 || height < ch * 0.5 || width > cw || height > ch) {
      const base = target.texture.getDesc().format,
        // Native copies use a typed color view of the two supported typeless bases.
        format = base === 27 ? 28 : base === 90 ? 87 : base;
      const replacement =
        this.maskPool?.takeCopy(width, height, format) ?? this.makeTarget(width, height, format);
      const old = this.copy;
      this.copy = replacement;
      if (old) this.retireCopy(old);
    }
    const copy = this.copy!,
      ctx = this.context;
    ctx.psSetShaderResources(0, [null, null, null]);
    ctx.copySubresourceRegion(copy.texture, 0, 0, 0, 0, target.texture, target.subresource, {
      left: x0,
      top: y0,
      right: x1,
      bottom: y1,
      front: 0,
      back: 1,
    });
    this.screenMulOffset.set([
      f(1 / copy.width),
      f(1 / copy.height),
      f(-x0 / copy.width),
      f(-y0 / copy.height),
    ]);
    b.set([MAX, MAX, -MAX, -MAX]);
  }

  private blendParam(op: number, parameter: number): readonly number[] {
    const width = this.copy?.width ?? 1,
      height = this.copy?.height ?? 1;
    if (op === 0x10c) {
      const s = f(this.mosaicSize(parameter)),
        c = f(f(s * 0.5) + 0.5);
      return [f(width / s), f(height / s), f(c / width), f(c / height)];
    }
    if (op === 0x10d)
      return uintOf(parameter) < 5 ? [f(1 / width), 0, 0, 0] : [0, f(1 / height), 0, 0];
    return ZERO;
  }
}
