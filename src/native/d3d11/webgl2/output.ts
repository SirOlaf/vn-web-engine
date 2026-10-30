import type {
  D3d11BlendDesc,
  D3d11DepthStencilDesc,
  D3d11DepthStencilOpDesc,
  D3d11DepthStencilViewDesc,
  D3d11RasterizerDesc,
  D3d11Rect,
  D3d11RenderTargetBlendDesc,
  D3d11RenderTargetViewDesc,
  D3d11Viewport,
} from '../contract.js';
import type {D3d11DeviceOwner} from '../runtime/com.js';
import type {D3d11ResourceStorage, D3d11Texture2D} from '../runtime/resources.js';
import type {D3d11TextureView} from '../runtime/views.js';
import {D3d11GpuTextures, D3d11TextureError} from './textures.js';

type Rtv = D3d11TextureView<D3d11RenderTargetViewDesc>;
type Dsv = D3d11TextureView<D3d11DepthStencilViewDesc>;
export interface D3d11DrawOutputState {
  readonly targets: readonly (Rtv | null)[];
  readonly depthTarget: Dsv | null;
  readonly blend: D3d11BlendDesc | null;
  readonly blendFactor: readonly [number, number, number, number];
  readonly sampleMask: number;
  readonly depth: D3d11DepthStencilDesc | null;
  readonly stencilRef: number;
  readonly raster: D3d11RasterizerDesc | null;
  readonly viewports: readonly D3d11Viewport[];
  readonly scissors: readonly D3d11Rect[];
}
interface Attachment {
  readonly resource: D3d11Texture2D;
  readonly texture: WebGLTexture;
  readonly mip: number;
  readonly format: number;
}
interface OutputConfiguration {
  readonly colors: readonly (Attachment | null)[];
  readonly depth: Attachment | null;
}
const MAX_COMPLETE_CONFIGURATIONS = 64;
/** Independently cached GL output state groups. */
const RASTER = 1,
  DEPTH = 2,
  BLEND = 4,
  ALL = 7;
const store = (values: Float64Array, i: number, value: number): number => {
  if (Object.is(values[i], value)) return 0;
  values[i] = value;
  return 1;
};
const sameAttachment = (a: Attachment | null, b: Attachment | null) =>
  a?.texture === b?.texture && a?.mip === b?.mip && a?.format === b?.format;
const DEFAULT_BLEND: D3d11RenderTargetBlendDesc = {
  blendEnable: false,
  srcBlend: 2,
  destBlend: 1,
  blendOp: 1,
  srcBlendAlpha: 2,
  destBlendAlpha: 1,
  blendOpAlpha: 1,
  renderTargetWriteMask: 15,
};
const DEFAULT_FACE: D3d11DepthStencilOpDesc = {
  stencilFailOp: 1,
  stencilDepthFailOp: 1,
  stencilPassOp: 1,
  stencilFunc: 8,
};
const DEFAULT_DEPTH: D3d11DepthStencilDesc = {
  depthEnable: true,
  depthWriteMask: 1,
  depthFunc: 2,
  stencilEnable: false,
  stencilReadMask: 255,
  stencilWriteMask: 255,
  frontFace: DEFAULT_FACE,
  backFace: DEFAULT_FACE,
};
const DEFAULT_RASTER: D3d11RasterizerDesc = {
  fillMode: 3,
  cullMode: 3,
  frontCounterClockwise: false,
  depthBias: 0,
  depthBiasClamp: 0,
  slopeScaledDepthBias: 0,
  depthClipEnable: true,
  scissorEnable: false,
  multisampleEnable: false,
  antialiasedLineEnable: false,
};

/** Context-owned framebuffer and native raster/output state. Context bindings retain the views. */
export class D3d11GpuOutput {
  /** Groups whose GL state matches the cached keys below. */
  private applied = 0;
  private appliedRaster: D3d11RasterizerDesc | null = null;
  private appliedDepth: D3d11DepthStencilDesc | null = null;
  private appliedDepthTarget: Dsv | null = null;
  private appliedBlend: D3d11BlendDesc | null = null;
  private readonly rasterValues = new Float64Array(13);
  private readonly depthValues = new Float64Array(1);
  private readonly blendValues = new Float64Array(6);
  private framebuffer: WebGLFramebuffer | null = null;
  private framebufferComplete = false;
  private readonly completeConfigurations: OutputConfiguration[] = [];
  /** Attachments of the shared multi-target framebuffer. */
  private readonly attachedColors: (Attachment | null)[];
  private attachedDepth: Attachment | null = null;
  private attachedDrawBuffers = '';
  /** Attachments of the framebuffer bound for the current draw. */
  private readonly colors: (Attachment | null)[];
  private readonly nextColors: (Attachment | null)[];
  private depth: Attachment | null = null;
  private width = 0;
  private height = 0;
  private disposed = false;
  private readonly indexed;
  private readonly clamp;
  private readonly polygon;
  private readonly maxViewport: Int32Array;
  private readonly colorFactors: readonly (number | undefined)[];
  private readonly alphaFactors: readonly (number | undefined)[];
  private readonly alphaOnlyFactors: readonly (number | undefined)[];
  private readonly equations: readonly number[];
  private readonly comparisons: readonly number[];
  private readonly stencilOps: readonly number[];

  /** Current attachment height for native top-left SV_Position coordinates. */
  get targetHeight(): number {
    return this.height;
  }

  /** Per-target source range for the linked pixel output, before blending. */
  get normalizedTargetMask(): number {
    let mask = 0;
    for (let i = 0; i < this.colors.length; i++) {
      switch (this.colors[i]?.format) {
        case 28:
        case 49:
        case 61:
        case 65:
        case 87:
          mask |= 1 << i;
      }
    }
    return mask;
  }

  constructor(
    private readonly owner: D3d11DeviceOwner,
    private readonly gl: WebGL2RenderingContext,
    private readonly textures: D3d11GpuTextures,
    private readonly cacheFixedState = false,
  ) {
    this.colors = Array(
      Math.min(8, gl.getParameter(gl.MAX_DRAW_BUFFERS), gl.getParameter(gl.MAX_COLOR_ATTACHMENTS)),
    ).fill(null);
    this.attachedColors = this.colors.slice();
    this.nextColors = this.colors.slice();
    this.indexed = gl.getExtension('OES_draw_buffers_indexed');
    this.clamp = gl.getExtension('EXT_depth_clamp');
    this.polygon = gl.getExtension('WEBGL_polygon_mode');
    this.maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    this.colorFactors = [
      undefined,
      gl.ZERO,
      gl.ONE,
      gl.SRC_COLOR,
      gl.ONE_MINUS_SRC_COLOR,
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.DST_ALPHA,
      gl.ONE_MINUS_DST_ALPHA,
      gl.DST_COLOR,
      gl.ONE_MINUS_DST_COLOR,
      gl.SRC_ALPHA_SATURATE,
      undefined,
      undefined,
      gl.CONSTANT_COLOR,
      gl.ONE_MINUS_CONSTANT_COLOR,
    ];
    const alpha = this.colorFactors.slice();
    alpha[11] = gl.ONE;
    alpha[14] = gl.CONSTANT_ALPHA;
    alpha[15] = gl.ONE_MINUS_CONSTANT_ALPHA;
    this.alphaFactors = alpha;
    // Native alpha factors in the red slot: COLOR factors of the alpha equation
    // read alpha, destination alpha is the stored red channel.
    const only = alpha.slice();
    only[3] = gl.SRC_ALPHA;
    only[4] = gl.ONE_MINUS_SRC_ALPHA;
    only[7] = only[9] = gl.DST_COLOR;
    only[8] = only[10] = gl.ONE_MINUS_DST_COLOR;
    this.alphaOnlyFactors = only;
    this.equations = [gl.FUNC_ADD, gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT, gl.MIN, gl.MAX];
    this.comparisons = [
      gl.NEVER,
      gl.LESS,
      gl.EQUAL,
      gl.LEQUAL,
      gl.GREATER,
      gl.NOTEQUAL,
      gl.GEQUAL,
      gl.ALWAYS,
    ];
    this.stencilOps = [
      gl.KEEP,
      gl.ZERO,
      gl.REPLACE,
      gl.INCR,
      gl.DECR,
      gl.INVERT,
      gl.INCR_WRAP,
      gl.DECR_WRAP,
    ];
  }

  /** Reapply after resource preparation, which may have changed private GL state. */
  use(state: D3d11DrawOutputState): boolean {
    this.checkLive();
    const raster = state.raster ?? DEFAULT_RASTER,
      viewport = state.viewports[0];
    if (raster.depthBias || raster.depthBiasClamp || raster.slopeScaledDepthBias)
      this.unsupported('depth bias');
    if (!raster.depthClipEnable && !this.clamp) this.unsupported('depth clipping disabled');
    if (raster.fillMode === 2 && !this.polygon) this.unsupported('wireframe fill');
    if (state.blend?.alphaToCoverageEnable) this.unsupported('alpha to coverage');
    let bound = 0;
    for (let i = 0; i < state.targets.length; i++) {
      if (state.targets[i] === null) continue;
      if (i >= this.colors.length) this.unsupported('render target count');
      bound++;
    }
    for (let i = 0; i < state.targets.length; i++) {
      if (!state.targets[i]) continue;
      const blend = this.blend(state, i);
      if (
        blend.blendEnable &&
        (blend.srcBlend >= 16 ||
          blend.destBlend >= 16 ||
          blend.srcBlendAlpha >= 16 ||
          blend.destBlendAlpha >= 16 ||
          blend.destBlend === 11)
      )
        this.unsupported('dual source or destination alpha-saturate blending');
    }
    if (!this.indexed && bound > 1) this.unsupported('independent render target state');
    if (
      viewport &&
      (!Number.isInteger(viewport.topLeftX) ||
        !Number.isInteger(viewport.topLeftY) ||
        !Number.isInteger(viewport.width) ||
        !Number.isInteger(viewport.height) ||
        viewport.width > this.maxViewport[0]! ||
        viewport.height > this.maxViewport[1]!)
    )
      this.unsupported('fractional or oversized viewport');
    // No geometry shader or SV_ViewportArrayIndex exists in the declared shader subset.
    if (!viewport || viewport.width === 0 || viewport.height === 0 || !(state.sampleMask & 1))
      return false;
    if (!this.attach(state)) return false;
    this.applied &= ~this.textures.takeOutputGroups();
    const groups = this.cacheFixedState ? this.staleGroups(state) : ALL;
    // A failed write (unsupported factor) leaves no group marked as applied.
    this.applied = 0;
    if (groups & RASTER) this.rasterState(state, raster, viewport);
    if (groups & DEPTH) this.depthStencil(state);
    if (groups & BLEND) this.blendStates(state);
    if (this.cacheFixedState) this.applied = ALL;
    // The draw context checks GL errors after submitting the complete draw,
    // including these state writes. Avoid a second synchronous query per draw.
    return true;
  }

  private rasterState(
    state: D3d11DrawOutputState,
    raster: D3d11RasterizerDesc,
    viewport: D3d11Viewport,
  ): void {
    const gl = this.gl;
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.disable(gl.DITHER);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.disable(gl.SAMPLE_COVERAGE);
    if (this.polygon)
      this.polygon.polygonModeWEBGL(
        gl.FRONT_AND_BACK,
        raster.fillMode === 2 ? this.polygon.LINE_WEBGL : this.polygon.FILL_WEBGL,
      );
    if (this.clamp) {
      if (raster.depthClipEnable) gl.disable(this.clamp.DEPTH_CLAMP_EXT);
      else gl.enable(this.clamp.DEPTH_CLAMP_EXT);
    }
    gl.frontFace(raster.frontCounterClockwise ? gl.CCW : gl.CW);
    if (raster.cullMode === 1) gl.disable(gl.CULL_FACE);
    else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(raster.cullMode === 2 ? gl.FRONT : gl.BACK);
    }
    gl.viewport(
      viewport.topLeftX,
      this.height - viewport.topLeftY - viewport.height,
      viewport.width,
      viewport.height,
    );
    gl.depthRange(viewport.minDepth, viewport.maxDepth);
    if (raster.scissorEnable) {
      const rect = state.scissors[0];
      gl.enable(gl.SCISSOR_TEST);
      if (rect) {
        const left = Math.max(0, Math.min(this.width, rect.left)),
          top = Math.max(0, Math.min(this.height, rect.top)),
          right = Math.max(left, Math.min(this.width, rect.right)),
          bottom = Math.max(top, Math.min(this.height, rect.bottom));
        gl.scissor(left, this.height - bottom, right - left, bottom - top);
      } else gl.scissor(0, 0, 0, 0);
    } else gl.disable(gl.SCISSOR_TEST);
  }

  private blendStates(state: D3d11DrawOutputState): void {
    const gl = this.gl;
    gl.blendColor(...state.blendFactor);
    gl.disable(gl.BLEND);
    for (let i = 0; i < this.colors.length; i++) {
      const target = state.targets[i],
        blend = this.blend(state, i),
        mask = blend.renderTargetWriteMask;
      const alphaOnly = this.colors[i]?.format === 65;
      const red = alphaOnly ? !!(mask & 8) : !!(mask & 1),
        green = !alphaOnly && !!(mask & 2),
        blue = !alphaOnly && !!(mask & 4),
        alpha = !alphaOnly && !!(mask & 8);
      const colorOp = alphaOnly ? blend.blendOpAlpha : blend.blendOp,
        colorFactors = alphaOnly ? this.alphaOnlyFactors : this.colorFactors,
        alphaFactors = alphaOnly ? this.alphaOnlyFactors : this.alphaFactors,
        srcColor = alphaOnly ? blend.srcBlendAlpha : blend.srcBlend,
        destColor = alphaOnly ? blend.destBlendAlpha : blend.destBlend;
      if (this.indexed) {
        this.indexed.colorMaskiOES(i, red, green, blue, alpha);
        if (!target || !blend.blendEnable) this.indexed.disableiOES(gl.BLEND, i);
        else {
          this.indexed.enableiOES(gl.BLEND, i);
          this.indexed.blendEquationSeparateiOES(
            i,
            this.equation(colorOp),
            this.equation(blend.blendOpAlpha),
          );
          this.indexed.blendFuncSeparateiOES(
            i,
            this.factor(srcColor, colorFactors),
            this.factor(destColor, colorFactors),
            this.factor(blend.srcBlendAlpha, alphaFactors),
            this.factor(blend.destBlendAlpha, alphaFactors),
          );
        }
      } else if (target) {
        gl.colorMask(red, green, blue, alpha);
        if (blend.blendEnable) {
          gl.enable(gl.BLEND);
          gl.blendEquationSeparate(this.equation(colorOp), this.equation(blend.blendOpAlpha));
          gl.blendFuncSeparate(
            this.factor(srcColor, colorFactors),
            this.factor(destColor, colorFactors),
            this.factor(blend.srcBlendAlpha, alphaFactors),
            this.factor(blend.destBlendAlpha, alphaFactors),
          );
        }
      }
    }
  }

  /** Drop borrowed immutable state descriptions before external GL use. */
  invalidateState(): void {
    this.applied = 0;
    this.appliedRaster = this.appliedDepth = this.appliedBlend = null;
    this.appliedDepthTarget = null;
  }

  /** Enabled only for a Native-owned command batch with immutable descriptions. Records the
   * keys of the state about to be applied and returns the groups that differ from GL. */
  private staleGroups(state: D3d11DrawOutputState): number {
    const viewport = state.viewports[0]!,
      rect = state.scissors[0],
      r = this.rasterValues,
      b = this.blendValues;
    let stale = ALL & ~this.applied,
      changed = this.appliedRaster !== state.raster ? 1 : 0;
    this.appliedRaster = state.raster;
    changed |= store(r, 0, this.width);
    changed |= store(r, 1, this.height);
    changed |= store(r, 2, viewport.topLeftX);
    changed |= store(r, 3, viewport.topLeftY);
    changed |= store(r, 4, viewport.width);
    changed |= store(r, 5, viewport.height);
    changed |= store(r, 6, viewport.minDepth);
    changed |= store(r, 7, viewport.maxDepth);
    changed |= store(r, 8, rect ? 1 : 0);
    changed |= store(r, 9, rect?.left ?? 0);
    changed |= store(r, 10, rect?.top ?? 0);
    changed |= store(r, 11, rect?.right ?? 0);
    changed |= store(r, 12, rect?.bottom ?? 0);
    if (changed) stale |= RASTER;
    changed =
      this.appliedDepth !== state.depth || this.appliedDepthTarget !== state.depthTarget ? 1 : 0;
    this.appliedDepth = state.depth;
    this.appliedDepthTarget = state.depthTarget;
    changed |= store(this.depthValues, 0, state.stencilRef & 255);
    if (changed) stale |= DEPTH;
    let targets = 0,
      alpha = 0;
    for (let i = 0; i < this.colors.length; i++) {
      if (this.colors[i]) targets |= 1 << i;
      if (this.colors[i]?.format === 65) alpha |= 1 << i;
    }
    changed = this.appliedBlend !== state.blend ? 1 : 0;
    this.appliedBlend = state.blend;
    changed |= store(b, 0, targets);
    changed |= store(b, 1, alpha);
    for (let i = 0; i < 4; i++) changed |= store(b, 2 + i, state.blendFactor[i]!);
    if (changed) stale |= BLEND;
    return stale;
  }

  /** Called only after an actual draw, while the same native bindings are still retained. */
  written(state: D3d11DrawOutputState): void {
    this.checkLive();
    for (let i = 0; i < state.targets.length; i++) {
      const target = state.targets[i],
        mask = this.blend(state, i).renderTargetWriteMask;
      if (target && (target.resource.getDesc().format === 65 ? mask & 8 : mask))
        this.textures.markWritten(target.resource, target.firstMip);
    }
    const depth = state.depth ?? DEFAULT_DEPTH,
      view = state.depthTarget;
    if (
      view &&
      ((depth.depthEnable && depth.depthWriteMask && !(view.getDesc().flags & 1)) ||
        (depth.stencilEnable &&
          depth.stencilWriteMask &&
          view.resource.getDesc().format === 45 &&
          !(view.getDesc().flags & 2)))
    )
      this.textures.markWritten(view.resource, view.firstMip);
  }

  /** Owner callback: delete attachments at native resource retirement, even between draws. */
  destroy(resource: D3d11ResourceStorage): void {
    if (this.depth?.resource === resource || this.colors.some((a) => a?.resource === resource))
      this.invalidateState();
    for (let i = 0; i < this.colors.length; i++)
      if (this.colors[i]?.resource === resource) this.colors[i] = null;
    if (this.depth?.resource === resource) this.depth = null;
    for (let i = this.completeConfigurations.length - 1; i >= 0; i--) {
      const config = this.completeConfigurations[i]!;
      if (
        config.depth?.resource === resource ||
        config.colors.some((a) => a?.resource === resource)
      )
        this.completeConfigurations.splice(i, 1);
    }
    if (!this.framebuffer) return;
    const gl = this.gl;
    for (let i = 0; i < this.attachedColors.length; i++)
      if (this.attachedColors[i]?.resource === resource) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0 + i,
          gl.TEXTURE_2D,
          null,
          0,
        );
        this.attachedColors[i] = null;
        this.framebufferComplete = false;
      }
    if (this.attachedDepth?.resource === resource) {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.TEXTURE_2D,
        null,
        0,
      );
      this.attachedDepth = null;
      this.framebufferComplete = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateState();
    this.gl.deleteFramebuffer(this.framebuffer);
    this.framebuffer = null;
    this.framebufferComplete = false;
    this.completeConfigurations.length = 0;
    this.attachedColors.fill(null);
    this.attachedDepth = null;
    this.colors.fill(null);
    this.depth = null;
  }

  private attach(state: D3d11DrawOutputState): boolean {
    const targets = state.targets,
      d = state.depthTarget;
    let first: Rtv | Dsv | null = d;
    for (let i = targets.length - 1; i >= 0; i--) if (targets[i]) first = targets[i]!;
    if (!first) return false;
    const size = first.resource.levels[first.firstMip]!;
    for (let i = 0; i <= targets.length; i++) {
      const v = i < targets.length ? targets[i] : d;
      if (!v) continue;
      const level = v.resource.levels[v.firstMip];
      if (
        !v.live ||
        v.lifetime !== this.owner.lifetime ||
        !level ||
        level.width !== size.width ||
        level.height !== size.height
      )
        throw new D3d11TextureError('Invalid D3D11 draw output views');
    }
    // Image preparation can bind its own framebuffers. Finish it before binding ours.
    // Unchanged attachments keep their immutable records; descriptions never change.
    const colors = this.nextColors;
    let lone = !d;
    for (let i = 0; i < colors.length; i++) {
      const v = targets[i];
      colors[i] = v ? this.attachment(v, this.colors[i]!) : null;
      if (i && v) lone = false;
    }
    const depth = d ? this.attachment(d, this.depth) : null;
    const gl = this.gl;
    for (let i = 0; i < colors.length; i++) this.colors[i] = colors[i]!;
    this.depth = depth;
    this.width = size.width;
    this.height = size.height;
    // A lone first target draws through the resource's own complete framebuffer,
    // which its clears and copies also use, so attachments never change per draw.
    if (lone && colors[0]) {
      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        this.textures.framebuffer(colors[0].resource, colors[0].mip),
      );
      return true;
    }
    if (!this.framebuffer) {
      this.framebuffer = gl.createFramebuffer();
      if (!this.framebuffer)
        throw new D3d11TextureError('D3D11 output framebuffer allocation failed', 0x8007000e | 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.readBuffer(gl.NONE);
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    for (let i = 0; i < colors.length; i++) {
      const next = colors[i]!;
      if (!sameAttachment(next, this.attachedColors[i]!)) {
        this.framebufferComplete = false;
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0 + i,
          gl.TEXTURE_2D,
          next?.texture ?? null,
          next?.mip ?? 0,
        );
        this.attachedColors[i] = next;
      }
    }
    if (!sameAttachment(depth, this.attachedDepth)) {
      this.framebufferComplete = false;
      gl.framebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.TEXTURE_2D,
        null,
        0,
      );
      if (depth)
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER,
          depth.resource.getDesc().format === 45
            ? gl.DEPTH_STENCIL_ATTACHMENT
            : gl.DEPTH_ATTACHMENT,
          gl.TEXTURE_2D,
          depth.texture,
          depth.mip,
        );
      this.attachedDepth = depth;
    }
    // Draw buffers are framebuffer state; only this class binds this framebuffer.
    const buffers = colors.map((v, i) => (v ? gl.COLOR_ATTACHMENT0 + i : gl.NONE));
    if (buffers.join() !== this.attachedDrawBuffers) {
      gl.drawBuffers(buffers);
      this.attachedDrawBuffers = buffers.join();
    }
    // Immutable storage makes completeness a property of the complete attachment
    // configuration. Native mask/copy passes repeatedly revisit those same sets.
    if (!this.framebufferComplete) {
      const known = this.completeConfigurations.findIndex(
        (config) =>
          sameAttachment(config.depth, depth) &&
          config.colors.every((a, i) => sameAttachment(a, colors[i]!)),
      );
      if (known >= 0) {
        const config = this.completeConfigurations.splice(known, 1)[0]!;
        this.completeConfigurations.push(config);
      } else {
        if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new D3d11TextureError('Incomplete D3D11 draw output framebuffer');
        this.completeConfigurations.push({colors: colors.slice(), depth});
        if (this.completeConfigurations.length > MAX_COMPLETE_CONFIGURATIONS)
          this.completeConfigurations.shift();
      }
      this.framebufferComplete = true;
    }
    return true;
  }

  private attachment(view: Rtv | Dsv, previous: Attachment | null): Attachment {
    const texture = this.textures.image(view.resource);
    return previous?.resource === view.resource &&
      previous.texture === texture &&
      previous.mip === view.firstMip
      ? previous
      : {
          resource: view.resource,
          texture,
          mip: view.firstMip,
          format: view.resource.getDesc().format,
        };
  }

  private depthStencil(state: D3d11DrawOutputState): void {
    const gl = this.gl,
      depth = state.depth ?? DEFAULT_DEPTH,
      view = state.depthTarget,
      flags = view?.getDesc().flags ?? 0;
    if (view && depth.depthEnable) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(this.compare(depth.depthFunc));
    } else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(!!view && depth.depthEnable && !!depth.depthWriteMask && !(flags & 1));
    if (view?.resource.getDesc().format === 45 && depth.stencilEnable) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMask(flags & 2 ? 0 : depth.stencilWriteMask);
      for (const [side, face] of [
        [gl.FRONT, depth.frontFace],
        [gl.BACK, depth.backFace],
      ] as const) {
        gl.stencilFuncSeparate(
          side,
          this.compare(face.stencilFunc),
          state.stencilRef & 255,
          depth.stencilReadMask,
        );
        gl.stencilOpSeparate(
          side,
          this.stencil(face.stencilFailOp),
          this.stencil(face.stencilDepthFailOp),
          this.stencil(face.stencilPassOp),
        );
      }
    } else {
      gl.disable(gl.STENCIL_TEST);
      gl.stencilMask(0);
    }
  }
  private blend(state: D3d11DrawOutputState, i: number): D3d11RenderTargetBlendDesc {
    return state.blend?.renderTarget[state.blend.independentBlendEnable ? i : 0] ?? DEFAULT_BLEND;
  }
  private factor(value: number, table: readonly (number | undefined)[]): number {
    const factor = table[value];
    if (factor === undefined) this.unsupported('blend factor');
    return factor;
  }
  private equation(value: number): number {
    return this.equations[value - 1]!;
  }
  private compare(value: number): number {
    return this.comparisons[value - 1]!;
  }
  private stencil(value: number): number {
    return this.stencilOps[value - 1]!;
  }
  private checkLive(): void {
    if (this.disposed || this.owner.lifetime.closed)
      throw new D3d11TextureError('Using retired D3D11 output storage');
    if (this.gl.isContextLost())
      throw new D3d11TextureError('D3D11 device removed', 0x887a0005 | 0);
  }
  private unsupported(feature: string): never {
    throw new D3d11TextureError('Unsupported D3D11 ' + feature, 0x80004001 | 0);
  }
}
