import {parseD3D9Shader} from '../../../graphics/d3d9-shader/bytecode.js';
import {
  POSITION_FIXUP_UNIFORM,
  SCREEN_FIXUP_UNIFORM,
  translateD3D9ShaderToGlsl,
} from '../../../graphics/d3d9-shader/glsl.js';
import {s3tcExtension} from '../../../graphics/s3tc.js';
import {
  D3D_OK,
  D3DCLEAR_STENCIL,
  D3DCLEAR_TARGET,
  D3DCLEAR_ZBUFFER,
  D3DERR_DEVICELOST,
  D3DERR_DEVICENOTRESET,
  D3DERR_INVALIDCALL,
  D3DERR_NOTAVAILABLE,
  D3DERR_NOTFOUND,
  D3DFMT_X8R8G8B8,
  D3DPOOL_DEFAULT,
  D3DPTEXTURECAPS_MIPMAP,
  D3DUSAGE_RENDERTARGET,
  type D3dCaps,
  type D3dDeviceWindow,
  type D3dDisplayMode,
  type D3dPresentParameters,
  type D3dRect,
  type D3dResult,
  type D3dSurfaceDesc,
  type D3dViewport,
  type IDirect3D9,
  type IDirect3DDevice9,
  type IDirect3DPixelShader9,
  type IDirect3DSurface9,
  type IDirect3DTexture9,
  type IDirect3DVertexShader9,
} from '../contract.js';
import {
  ALPHA_REF_UNIFORM,
  FF_AMBIENT,
  FF_DEPTH,
  FF_SCREEN,
  FF_STAGE_CONSTANT,
  FF_TEXTURE_FACTOR,
  FF_WORLD_VIEW_PROJECTION,
  type FixedStage,
} from './fixed-function.js';
import {textureFormat} from './formats.js';
import {copyVertices, findElement, fvfLayout, type FvfLayout} from './fvf.js';
import {GL} from './gl.js';
import {GlStateCache} from './gl-state.js';
import {
  linkProgram,
  programKey,
  programSources,
  ShaderObject,
  type LinkedProgram,
  type ProgramRequest,
} from './shaders.js';
import {
  IDENTITY,
  MAX_PS_FLOAT_CONSTANTS,
  MAX_TEXTURE_STAGES,
  MAX_VS_FLOAT_CONSTANTS,
  RS,
  SAMP,
  TOP,
  TS,
  TSS,
  addressMode,
  blendEquation,
  blendFactorPair,
  compareFunction,
  d3dColorToRgba,
  isTransformState,
  magFilter,
  minFilter,
  multiplyMatrices,
  primitiveLayout,
  renderStateDefaults,
  samplerStateDefaults,
  samplerUnit,
  stencilOperation,
  textureStageDefaults,
} from './state.js';
import {Surface, Texture, isValidPool, mipLevelCount, type TextureHost} from './textures.js';

/** Adapter capabilities, probed from a WebGL2 context before `Direct3DCreate9`. */
export interface WebGl2Adapter {
  readonly maxTextureSize: number;
  /** `WEBGL_compressed_texture_s3tc` is available. */
  readonly s3tc: boolean;
  /** Maximum anisotropy (1 without `EXT_texture_filter_anisotropic`). */
  readonly maxAnisotropy: number;
}

export function describeWebGl2Adapter(gl: WebGL2RenderingContext): WebGl2Adapter {
  const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');
  return {
    maxTextureSize: Number(gl.getParameter(GL.MAX_TEXTURE_SIZE)) || 4096,
    s3tc: s3tcExtension(gl) !== null,
    maxAnisotropy: anisotropic
      ? Number(gl.getParameter(GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1
      : 1,
  };
}

/** D3DVS_VERSION(3, 0) and D3DPS_VERSION(3, 0). */
export const VS_3_0 = 0xfffe0300 | 0;
export const PS_3_0 = 0xffff0300 | 0;
const D3DPTEXTURECAPS_PERSPECTIVE = 0x1;
const D3DPTEXTURECAPS_ALPHA = 0x4;

/** Unit used for texture uploads, outside the 20 units D3D stages map to. */
const UPLOAD_UNIT = 20;
const TEXTURE_UNITS = 20;
const D3DCULL_CW = 2;
/** Pixel-centre shift in pixels: 63/128 rather than 1/2 (as Wine's wined3d does). */
export const PIXEL_CENTER_SHIFT = 63 / 128;
const D3DCULL_CCW = 3;

interface TargetInfo {
  readonly framebuffer: WebGLFramebuffer | null;
  readonly width: number;
  readonly height: number;
  /** Rendering into a texture: D3D row 0 is GL row 0, so clip space is flipped. */
  readonly flipped: boolean;
  readonly depthStencil: boolean;
}

/** Intersection of two rects, or null when empty. */
function intersect(a: D3dRect, b: D3dRect): D3dRect | null {
  const left = Math.max(a.left, b.left),
    top = Math.max(a.top, b.top),
    right = Math.min(a.right, b.right),
    bottom = Math.min(a.bottom, b.bottom);
  return left < right && top < bottom ? {left, top, right, bottom} : null;
}

/** The IDirect3D9 side a device needs. */
export interface DeviceParent extends IDirect3D9 {
  readonly adapter: WebGl2Adapter;
}

/**
 * `IDirect3DDevice9` on a WebGL2 context. D3D state is stored as set and applied to GL at
 * draw and clear time through a redundant-call cache. See `src/native/d3d9/README.md`.
 */
export class WebGl2Device implements IDirect3DDevice9, TextureHost {
  readonly gl: WebGL2RenderingContext;
  s3tc = false;
  private anisotropy = 1;
  private references = 1;
  private destroyed = false;
  private readonly cache = new GlStateCache();

  // D3D state
  private renderStates = new Map<number, number>();
  private stageStates: Map<number, number>[] = [];
  private samplerStates = new Map<number, Map<number, number>>();
  private transforms = new Map<number, Float32Array>();
  private viewport: D3dViewport = {x: 0, y: 0, width: 1, height: 1, minZ: 0, maxZ: 1};
  private scissor: D3dRect = {left: 0, top: 0, right: 1, bottom: 1};
  private fvf = 0;
  private readonly textures = new Map<number, Texture>();
  private vertexShader: ShaderObject | null = null;
  private pixelShader: ShaderObject | null = null;
  private readonly vsConstants = new Float32Array(MAX_VS_FLOAT_CONSTANTS * 4);
  private readonly psConstants = new Float32Array(MAX_PS_FLOAT_CONSTANTS * 4);
  private vsConstantVersion = 0;
  private psConstantVersion = 0;
  private renderTarget: Surface;
  private readonly backBuffer: Surface;
  private presentation: D3dPresentParameters;
  private backBufferWidth = 1;
  private backBufferHeight = 1;

  // Resources
  private readonly liveTextures = new Set<Texture>();
  private readonly liveShaders = new Set<ShaderObject>();
  private readonly programs = new Map<string, LinkedProgram | null>();

  // GL objects
  private vao: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private samplerObjects: (WebGLSampler | null)[] = [];
  private depthStencil: WebGLRenderbuffer | null = null;
  private vertexScratch = new Uint8Array(0);
  private enabledAttributes = new Set<number>();

  // Context loss
  private lost = false;
  private needsReset = false;
  private readonly onLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.needsReset = true;
  };
  private readonly onRestored = () => {
    this.lost = false;
  };

  constructor(
    private readonly parent: DeviceParent,
    private readonly window: D3dDeviceWindow,
    presentation: D3dPresentParameters,
    readonly behaviorFlags: number,
  ) {
    this.gl = window.context;
    this.presentation = presentation;
    this.backBuffer = new Surface(this, () => this.backBufferDesc(), null, 0);
    this.renderTarget = this.backBuffer;
    const canvas = this.gl.canvas as {addEventListener?: HTMLCanvasElement['addEventListener']};
    canvas.addEventListener?.('webglcontextlost', this.onLost);
    canvas.addEventListener?.('webglcontextrestored', this.onRestored);
    parent.addRef();
    this.createGlObjects();
    this.applyPresentation(presentation);
    this.resetStates();
  }

  /** Whether the window's context can back `presentation`. */
  static supports(window: D3dDeviceWindow, presentation: D3dPresentParameters): boolean {
    if (!presentation.enableAutoDepthStencil) return true;
    const attributes = window.context.getContextAttributes();
    return attributes === null || (attributes.depth === true && attributes.stencil === true);
  }

  // ---- IUnknown ----

  addRef(): number {
    return ++this.references;
  }

  release(): number {
    if (this.references === 0) return 0;
    const count = --this.references;
    if (count === 0) this.destroy();
    return count;
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseBindings();
    const gl = this.gl;
    for (const program of this.programs.values()) if (program) gl.deleteProgram(program.program);
    this.programs.clear();
    for (const sampler of this.samplerObjects) if (sampler) gl.deleteSampler(sampler);
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.depthStencil) gl.deleteRenderbuffer(this.depthStencil);
    const canvas = gl.canvas as {removeEventListener?: HTMLCanvasElement['removeEventListener']};
    canvas.removeEventListener?.('webglcontextlost', this.onLost);
    canvas.removeEventListener?.('webglcontextrestored', this.onRestored);
    this.parent.release();
  }

  /** Releases the references the device holds through its state (textures, target, shaders). */
  private releaseBindings(): void {
    for (const texture of this.textures.values()) texture.release();
    this.textures.clear();
    if (this.renderTarget !== this.backBuffer) this.renderTarget.release();
    this.renderTarget = this.backBuffer;
    this.vertexShader?.release();
    this.pixelShader?.release();
    this.vertexShader = this.pixelShader = null;
  }

  // ---- GL objects ----

  private createGlObjects(): void {
    const gl = this.gl;
    this.cache.invalidate();
    this.enabledAttributes.clear();
    this.s3tc = s3tcExtension(gl) !== null;
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic')
      ? Math.max(1, this.parent.adapter.maxAnisotropy)
      : 1;
    this.vao = gl.createVertexArray();
    this.vertexBuffer = gl.createBuffer();
    this.samplerObjects = Array.from({length: TEXTURE_UNITS}, () => gl.createSampler());
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.pixelStorei(GL.UNPACK_COLORSPACE_CONVERSION_WEBGL, 0);
    this.depthStencil = null;
  }

  private applyPresentation(presentation: D3dPresentParameters): void {
    const gl = this.gl;
    if (presentation.backBufferWidth > 0 && presentation.backBufferHeight > 0)
      this.window.setBackBufferSize(presentation.backBufferWidth, presentation.backBufferHeight);
    this.backBufferWidth = Math.max(1, gl.drawingBufferWidth);
    this.backBufferHeight = Math.max(1, gl.drawingBufferHeight);
    if (this.depthStencil) gl.deleteRenderbuffer(this.depthStencil);
    this.depthStencil = null;
    if (presentation.enableAutoDepthStencil) {
      // Offscreen targets share one depth-stencil surface of back-buffer size, as the
      // automatic depth-stencil surface is shared on Direct3D 9.
      this.depthStencil = gl.createRenderbuffer();
      gl.bindRenderbuffer(GL.RENDERBUFFER, this.depthStencil);
      gl.renderbufferStorage(
        GL.RENDERBUFFER,
        GL.DEPTH24_STENCIL8,
        this.backBufferWidth,
        this.backBufferHeight,
      );
    }
  }

  private resetStates(): void {
    this.renderStates = renderStateDefaults(this.presentation.enableAutoDepthStencil);
    this.stageStates = Array.from({length: MAX_TEXTURE_STAGES}, (_, i) => textureStageDefaults(i));
    this.samplerStates.clear();
    this.transforms.clear();
    this.fvf = 0;
    this.vsConstants.fill(0);
    this.psConstants.fill(0);
    this.vsConstantVersion++;
    this.psConstantVersion++;
    this.resetViewport();
  }

  private resetViewport(): void {
    const {width, height} = this.targetSize(this.renderTarget);
    this.viewport = {x: 0, y: 0, width, height, minZ: 0, maxZ: 1};
    this.scissor = {left: 0, top: 0, right: width, bottom: height};
  }

  private backBufferDesc(): D3dSurfaceDesc {
    return {
      format: this.presentation.backBufferFormat || D3DFMT_X8R8G8B8,
      usage: D3DUSAGE_RENDERTARGET,
      pool: D3DPOOL_DEFAULT,
      width: this.backBufferWidth,
      height: this.backBufferHeight,
    };
  }

  private targetSize(surface: Surface): {width: number; height: number} {
    return surface.texture
      ? surface.texture.levelSize(surface.level)
      : {width: this.backBufferWidth, height: this.backBufferHeight};
  }

  private target(): TargetInfo {
    const surface = this.renderTarget;
    if (!surface.texture)
      return {
        framebuffer: null,
        width: this.backBufferWidth,
        height: this.backBufferHeight,
        flipped: false,
        depthStencil: this.presentation.enableAutoDepthStencil,
      };
    const {width, height} = surface.texture.levelSize(surface.level);
    const depth =
      this.depthStencil && width <= this.backBufferWidth && height <= this.backBufferHeight
        ? this.depthStencil
        : null;
    const framebuffer = surface.texture.framebuffer(surface.level, depth);
    return {framebuffer, width, height, flipped: true, depthStencil: depth !== null};
  }

  // ---- TextureHost ----

  bindForUpload(texture: WebGLTexture | null): void {
    this.bindTexture(UPLOAD_UNIT, texture);
  }

  framebufferBound(): void {
    this.cache.forget('framebuffer');
  }

  textureDestroyed(texture: Texture): void {
    this.liveTextures.delete(texture);
  }

  private bindTexture(unit: number, texture: WebGLTexture | null): void {
    this.cache.set(`texture${unit}`, [texture], () => {
      this.cache.set('activeTexture', [unit], () => this.gl.activeTexture(GL.TEXTURE0 + unit));
      this.gl.bindTexture(GL.TEXTURE_2D, texture);
    });
  }

  // ---- Device status ----

  testCooperativeLevel(): number {
    if (this.lost || this.gl.isContextLost()) {
      this.needsReset = true;
      return D3DERR_DEVICELOST;
    }
    return this.needsReset ? D3DERR_DEVICENOTRESET : D3D_OK;
  }

  private get inactive(): boolean {
    return this.lost || this.needsReset || this.gl.isContextLost();
  }

  reset(presentation: D3dPresentParameters): number {
    if (this.lost || this.gl.isContextLost()) return D3DERR_DEVICELOST;
    if (!WebGl2Device.supports(this.window, presentation)) return D3DERR_NOTAVAILABLE;
    this.releaseBindings();
    for (const texture of this.liveTextures)
      if (texture.pool === D3DPOOL_DEFAULT) return D3DERR_INVALIDCALL;
    if (this.needsReset) {
      // The context was lost: every GL object is gone. Managed textures re-upload from
      // their system-memory copies; programs relink on next use.
      this.programs.clear();
      this.createGlObjects();
      for (const texture of this.liveTextures) {
        texture.forgetGl();
        texture.allocate();
      }
    }
    this.presentation = presentation;
    this.applyPresentation(presentation);
    this.resetStates();
    this.needsReset = false;
    return D3D_OK;
  }

  getDirect3D(): D3dResult<IDirect3D9> {
    this.parent.addRef();
    return {hr: D3D_OK, value: this.parent};
  }

  getDeviceCaps(): D3dResult<D3dCaps> {
    const size = this.parent.adapter.maxTextureSize;
    return {
      hr: D3D_OK,
      value: {
        maxTextureWidth: size,
        maxTextureHeight: size,
        textureCaps: D3DPTEXTURECAPS_PERSPECTIVE | D3DPTEXTURECAPS_ALPHA | D3DPTEXTURECAPS_MIPMAP,
        vertexShaderVersion: VS_3_0,
        pixelShaderVersion: PS_3_0,
      },
    };
  }

  getDisplayMode(swapChain: number): D3dResult<D3dDisplayMode> {
    if (swapChain !== 0) return {hr: D3DERR_INVALIDCALL, value: null};
    return {hr: D3D_OK, value: this.window.displayMode()};
  }

  // ---- Resources ----

  createTexture(
    width: number,
    height: number,
    levels: number,
    usage: number,
    format: number,
    pool: number,
  ): D3dResult<IDirect3DTexture9> {
    const description = textureFormat(format);
    const max = this.parent.adapter.maxTextureSize;
    if (
      !description ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > max ||
      height > max ||
      levels < 0 ||
      !isValidPool(pool, usage)
    )
      return {hr: D3DERR_INVALIDCALL, value: null};
    if (usage & D3DUSAGE_RENDERTARGET && !description.renderTarget)
      return {hr: D3DERR_INVALIDCALL, value: null};
    const texture = new Texture(
      this,
      width,
      height,
      mipLevelCount(width, height, levels),
      usage,
      description,
      pool,
    );
    this.liveTextures.add(texture);
    return {hr: D3D_OK, value: texture};
  }

  private ownTexture(texture: IDirect3DTexture9 | null): texture is Texture {
    return texture instanceof Texture && this.liveTextures.has(texture);
  }

  setRenderTarget(index: number, surface: IDirect3DSurface9 | null): number {
    if (index !== 0 || !(surface instanceof Surface)) return D3DERR_INVALIDCALL;
    if (surface !== this.backBuffer) {
      const texture = surface.texture;
      if (!texture || !this.ownTexture(texture) || !texture.renderTarget) return D3DERR_INVALIDCALL;
    }
    if (surface !== this.backBuffer) surface.addRef();
    if (this.renderTarget !== this.backBuffer) this.renderTarget.release();
    this.renderTarget = surface;
    // Direct3D 9 resets the viewport and scissor rectangle to the new target.
    this.resetViewport();
    return D3D_OK;
  }

  getRenderTarget(index: number): D3dResult<IDirect3DSurface9> {
    if (index < 0 || index > 3) return {hr: D3DERR_INVALIDCALL, value: null};
    if (index !== 0) return {hr: D3DERR_NOTFOUND, value: null};
    this.renderTarget.addRef();
    return {hr: D3D_OK, value: this.renderTarget};
  }

  // ---- Clear ----

  clear(
    rects: readonly D3dRect[] | null,
    flags: number,
    color: number,
    z: number,
    stencil: number,
  ): number {
    if (flags & ~(D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER | D3DCLEAR_STENCIL) || flags === 0)
      return D3DERR_INVALIDCALL;
    if (rects !== null && rects.length === 0) return D3D_OK;
    if (this.inactive) return D3D_OK;
    const target = this.target();
    if (flags & (D3DCLEAR_ZBUFFER | D3DCLEAR_STENCIL) && !target.depthStencil)
      return D3DERR_INVALIDCALL;
    const gl = this.gl;
    this.bindFramebuffer(target.framebuffer);
    const v = this.viewport;
    let area: D3dRect | null = {
      left: v.x,
      top: v.y,
      right: v.x + v.width,
      bottom: v.y + v.height,
    };
    if (this.renderStates.get(RS.SCISSORTESTENABLE)) area = intersect(area, this.scissor);
    if (!area) return D3D_OK;
    let bits = 0;
    // Clear writes every channel and the full depth/stencil, whatever the write masks are.
    if (flags & D3DCLEAR_TARGET) {
      bits |= GL.COLOR_BUFFER_BIT;
      const [r, g, b, a] = d3dColorToRgba(color);
      this.cache.set('colorMask', [true, true, true, true], () =>
        gl.colorMask(true, true, true, true),
      );
      this.cache.set('clearColor', [r, g, b, a], () => gl.clearColor(r, g, b, a));
    }
    if (flags & D3DCLEAR_ZBUFFER) {
      bits |= GL.DEPTH_BUFFER_BIT;
      const depth = Math.min(1, Math.max(0, z));
      this.cache.set('depthMask', [true], () => gl.depthMask(true));
      this.cache.set('clearDepth', [depth], () => gl.clearDepth(depth));
    }
    if (flags & D3DCLEAR_STENCIL) {
      bits |= GL.STENCIL_BUFFER_BIT;
      this.cache.set('stencilMask', [0xff, 0xff], () => gl.stencilMask(0xff));
      this.cache.set('clearStencil', [stencil & 0xff], () => gl.clearStencil(stencil & 0xff));
    }
    this.enable(GL.SCISSOR_TEST, true);
    for (const rect of rects ?? [area]) {
      const clipped = intersect(rect, area);
      if (!clipped) continue;
      this.setScissor(target, clipped);
      gl.clear(bits);
    }
    return D3D_OK;
  }

  // ---- Transforms, viewport, scissor ----

  setTransform(state: number, matrix: Float32Array): number {
    if (!isTransformState(state) || matrix.length < 16) return D3DERR_INVALIDCALL;
    this.transforms.set(state, Float32Array.from(matrix.subarray(0, 16)));
    return D3D_OK;
  }

  getTransform(state: number): D3dResult<Float32Array> {
    if (!isTransformState(state)) return {hr: D3DERR_INVALIDCALL, value: null};
    const matrix = this.transforms.get(state);
    return {hr: D3D_OK, value: matrix ? matrix.slice() : Float32Array.from(IDENTITY)};
  }

  setViewport(viewport: D3dViewport): number {
    const {width, height} = this.targetSize(this.renderTarget);
    if (
      viewport.x < 0 ||
      viewport.y < 0 ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      viewport.x + viewport.width > width ||
      viewport.y + viewport.height > height
    )
      return D3DERR_INVALIDCALL;
    this.viewport = {...viewport};
    return D3D_OK;
  }

  getViewport(): D3dResult<D3dViewport> {
    return {hr: D3D_OK, value: {...this.viewport}};
  }

  setScissorRect(rect: D3dRect): number {
    this.scissor = {...rect};
    return D3D_OK;
  }

  getScissorRect(): D3dResult<D3dRect> {
    return {hr: D3D_OK, value: {...this.scissor}};
  }

  // ---- States ----

  setRenderState(state: number, value: number): number {
    if (!this.renderStates.has(state)) return D3DERR_INVALIDCALL;
    this.renderStates.set(state, value | 0);
    return D3D_OK;
  }

  getRenderState(state: number): D3dResult<number> {
    const value = this.renderStates.get(state);
    return value === undefined ? {hr: D3DERR_INVALIDCALL, value: null} : {hr: D3D_OK, value};
  }

  getTexture(stage: number): D3dResult<IDirect3DTexture9> {
    if (samplerUnit(stage) < 0) return {hr: D3DERR_INVALIDCALL, value: null};
    const texture = this.textures.get(stage) ?? null;
    texture?.addRef();
    return {hr: D3D_OK, value: texture};
  }

  setTexture(stage: number, texture: IDirect3DTexture9 | null): number {
    if (samplerUnit(stage) < 0) return D3DERR_INVALIDCALL;
    if (texture !== null && !this.ownTexture(texture)) return D3DERR_INVALIDCALL;
    const previous = this.textures.get(stage);
    if (previous === texture) return D3D_OK;
    texture?.addRef();
    if (texture) this.textures.set(stage, texture);
    else this.textures.delete(stage);
    previous?.release();
    return D3D_OK;
  }

  getTextureStageState(stage: number, type: number): D3dResult<number> {
    const value = this.stageStates[stage]?.get(type);
    return value === undefined ? {hr: D3DERR_INVALIDCALL, value: null} : {hr: D3D_OK, value};
  }

  setTextureStageState(stage: number, type: number, value: number): number {
    const states = this.stageStates[stage];
    if (!states?.has(type)) return D3DERR_INVALIDCALL;
    states.set(type, value | 0);
    return D3D_OK;
  }

  private samplers(sampler: number): Map<number, number> | null {
    if (samplerUnit(sampler) < 0) return null;
    let states = this.samplerStates.get(sampler);
    if (!states) this.samplerStates.set(sampler, (states = samplerStateDefaults()));
    return states;
  }

  getSamplerState(sampler: number, type: number): D3dResult<number> {
    const value = this.samplers(sampler)?.get(type);
    return value === undefined ? {hr: D3DERR_INVALIDCALL, value: null} : {hr: D3D_OK, value};
  }

  setSamplerState(sampler: number, type: number, value: number): number {
    const states = this.samplers(sampler);
    if (!states?.has(type)) return D3DERR_INVALIDCALL;
    states.set(type, value | 0);
    return D3D_OK;
  }

  setFVF(fvf: number): number {
    this.fvf = fvf >>> 0;
    return D3D_OK;
  }

  getFVF(): D3dResult<number> {
    return {hr: D3D_OK, value: this.fvf};
  }

  // ---- Shaders ----

  private createShader(bytecode: Uint8Array, stage: 'vertex' | 'pixel'): D3dResult<ShaderObject> {
    try {
      const shader = parseD3D9Shader(bytecode);
      if (shader.version.stage !== stage) return {hr: D3DERR_INVALIDCALL, value: null};
      // Translation is checked here so an unsupported shader fails at creation, where
      // clients test for failure, rather than at every draw.
      translateD3D9ShaderToGlsl(shader);
      const object = new ShaderObject(shader, (s) => this.shaderDestroyed(s));
      this.liveShaders.add(object);
      return {hr: D3D_OK, value: object};
    } catch {
      return {hr: D3DERR_INVALIDCALL, value: null};
    }
  }

  private shaderDestroyed(shader: ShaderObject): void {
    this.liveShaders.delete(shader);
    for (const [key, program] of this.programs) {
      if (!program) continue;
      if (program.vertexShaderId === shader.id || program.pixelShaderId === shader.id) {
        this.gl.deleteProgram(program.program);
        this.programs.delete(key);
      }
    }
  }

  private setShader(
    shader: IDirect3DVertexShader9 | IDirect3DPixelShader9 | null,
    stage: 'vertex' | 'pixel',
  ): number {
    if (shader !== null) {
      if (!(shader instanceof ShaderObject) || !this.liveShaders.has(shader))
        return D3DERR_INVALIDCALL;
      if (shader.stage !== stage) return D3DERR_INVALIDCALL;
    }
    const previous = stage === 'vertex' ? this.vertexShader : this.pixelShader;
    if (previous === shader) return D3D_OK;
    shader?.addRef();
    if (stage === 'vertex') this.vertexShader = shader;
    else this.pixelShader = shader;
    previous?.release();
    return D3D_OK;
  }

  createVertexShader(bytecode: Uint8Array): D3dResult<IDirect3DVertexShader9> {
    return this.createShader(bytecode, 'vertex');
  }

  setVertexShader(shader: IDirect3DVertexShader9 | null): number {
    return this.setShader(shader, 'vertex');
  }

  getVertexShader(): D3dResult<IDirect3DVertexShader9> {
    this.vertexShader?.addRef();
    return {hr: D3D_OK, value: this.vertexShader};
  }

  setVertexShaderConstantF(register: number, data: Float32Array, count: number): number {
    if (register < 0 || count < 0 || register + count > MAX_VS_FLOAT_CONSTANTS)
      return D3DERR_INVALIDCALL;
    if (data.length < count * 4) return D3DERR_INVALIDCALL;
    this.vsConstants.set(data.subarray(0, count * 4), register * 4);
    this.vsConstantVersion++;
    return D3D_OK;
  }

  getVertexShaderConstantF(register: number, count: number): D3dResult<Float32Array> {
    if (register < 0 || count < 0 || register + count > MAX_VS_FLOAT_CONSTANTS)
      return {hr: D3DERR_INVALIDCALL, value: null};
    return {hr: D3D_OK, value: this.vsConstants.slice(register * 4, (register + count) * 4)};
  }

  createPixelShader(bytecode: Uint8Array): D3dResult<IDirect3DPixelShader9> {
    return this.createShader(bytecode, 'pixel');
  }

  setPixelShader(shader: IDirect3DPixelShader9 | null): number {
    return this.setShader(shader, 'pixel');
  }

  getPixelShader(): D3dResult<IDirect3DPixelShader9> {
    this.pixelShader?.addRef();
    return {hr: D3D_OK, value: this.pixelShader};
  }

  setPixelShaderConstantF(register: number, data: Float32Array, count: number): number {
    if (register < 0 || count < 0 || register + count > MAX_PS_FLOAT_CONSTANTS)
      return D3DERR_INVALIDCALL;
    if (data.length < count * 4) return D3DERR_INVALIDCALL;
    this.psConstants.set(data.subarray(0, count * 4), register * 4);
    this.psConstantVersion++;
    return D3D_OK;
  }

  // ---- Drawing ----

  drawPrimitiveUP(
    primitiveType: number,
    primitiveCount: number,
    vertices: Uint8Array,
    stride: number,
  ): number {
    const primitive = primitiveLayout(primitiveType, primitiveCount);
    if (!primitive || primitiveCount < 0 || stride <= 0) return D3DERR_INVALIDCALL;
    const layout = fvfLayout(this.fvf);
    if (!layout) return D3DERR_INVALIDCALL;
    if (primitiveCount === 0) return D3D_OK;
    const vertexCount = primitive.vertices;
    if (vertices.length < stride * (vertexCount - 1) + layout.stride) return D3DERR_INVALIDCALL;
    if (this.inactive) return D3D_OK;
    const program = this.program(layout);
    if (!program) return D3DERR_INVALIDCALL;
    const gl = this.gl;
    const target = this.target();
    this.bindFramebuffer(target.framebuffer);
    this.applyRasterState(target);
    this.cache.set('program', [program.program], () => gl.useProgram(program.program));
    this.uploadUniforms(program, target, layout);
    this.bindTextures();
    this.setupVertices(program, layout, vertices, stride, vertexCount);
    gl.drawArrays(primitive.mode, 0, vertexCount);
    return D3D_OK;
  }

  private program(layout: FvfLayout): LinkedProgram | null {
    const rs = (state: number) => this.renderStates.get(state)!;
    const vs = this.vertexShader,
      ps = this.pixelShader;
    let fixedVertex: ProgramRequest['fixedVertex'] = null;
    if (!vs) {
      const position = layout.elements[0]!;
      const diffuse = layout.elements.some((e) => e.usage === 10 && e.usageIndex === 0);
      const specular = layout.elements.some((e) => e.usage === 10 && e.usageIndex === 1);
      const lighting = rs(RS.LIGHTING) !== 0 && !layout.pretransformed;
      const source = (state: number) => {
        if (!lighting || !rs(RS.COLORVERTEX)) return 0;
        const value = rs(state);
        return (value === 1 && !diffuse) || (value === 2 && !specular) ? 0 : value;
      };
      fixedVertex = {
        pretransformed: layout.pretransformed,
        positionComponents: position.components,
        diffuse,
        specular,
        textureSets: layout.textureSets,
        texCoordIndex: this.stageStates.map((s) => s.get(TSS.TEXCOORDINDEX)! & 0xffff),
        lighting,
        diffuseSource: source(RS.DIFFUSEMATERIALSOURCE),
        ambientSource: source(RS.AMBIENTMATERIALSOURCE),
        emissiveSource: source(RS.EMISSIVEMATERIALSOURCE),
      };
    }
    let fixedFragment: ProgramRequest['fixedFragment'] = null;
    if (!ps) {
      const stages: FixedStage[] = [];
      for (let i = 0; i < MAX_TEXTURE_STAGES; i++) {
        const s = this.stageStates[i]!;
        const colorOp = s.get(TSS.COLOROP)!;
        if (colorOp === TOP.DISABLE) break;
        stages.push({
          colorOp,
          colorArgs: [s.get(TSS.COLORARG0)!, s.get(TSS.COLORARG1)!, s.get(TSS.COLORARG2)!],
          alphaOp: s.get(TSS.ALPHAOP)!,
          alphaArgs: [s.get(TSS.ALPHAARG0)!, s.get(TSS.ALPHAARG1)!, s.get(TSS.ALPHAARG2)!],
          resultArg: s.get(TSS.RESULTARG)!,
          texture: this.textures.has(i),
        });
      }
      fixedFragment = {stages, specular: rs(RS.SPECULARENABLE) !== 0};
    }
    const request: ProgramRequest = {
      vertexShader: vs,
      pixelShader: ps,
      fixedVertex,
      fixedFragment,
      alphaFunc: rs(RS.ALPHATESTENABLE) ? rs(RS.ALPHAFUNC) : 8,
    };
    const key = programKey(request);
    const cached = this.programs.get(key);
    if (cached !== undefined) return cached;
    let linked: LinkedProgram | null = null;
    try {
      linked = linkProgram(this.gl, key, programSources(request), {
        vertex: vs?.id ?? 0,
        pixel: ps?.id ?? 0,
      });
      this.cache.forget('program');
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
    this.programs.set(key, linked);
    return linked;
  }

  private bindFramebuffer(framebuffer: WebGLFramebuffer | null): void {
    this.cache.set('framebuffer', [framebuffer], () =>
      this.gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer),
    );
  }

  private enable(capability: number, on: boolean): void {
    this.cache.set(`enable${capability}`, [on], () =>
      on ? this.gl.enable(capability) : this.gl.disable(capability),
    );
  }

  /** GL scissor box for a D3D rect (top-left origin) on `target`. */
  private setScissor(target: TargetInfo, rect: D3dRect): void {
    const width = rect.right - rect.left,
      height = rect.bottom - rect.top,
      y = target.flipped ? rect.top : target.height - rect.bottom;
    this.cache.set('scissor', [rect.left, y, width, height], () =>
      this.gl.scissor(rect.left, y, width, height),
    );
  }

  private applyRasterState(target: TargetInfo): void {
    const gl = this.gl,
      rs = (state: number) => this.renderStates.get(state)!,
      cache = this.cache;
    const v = this.viewport;
    const viewportY = target.flipped ? v.y : target.height - v.y - v.height;
    cache.set('viewport', [v.x, viewportY, v.width, v.height], () =>
      gl.viewport(v.x, viewportY, v.width, v.height),
    );
    cache.set('depthRange', [v.minZ, v.maxZ], () => gl.depthRange(v.minZ, v.maxZ));

    // Scissor: the rect is clipped to the target.
    const scissorOn = rs(RS.SCISSORTESTENABLE) !== 0;
    this.enable(GL.SCISSOR_TEST, scissorOn);
    if (scissorOn) {
      const rect = intersect(this.scissor, {
        left: 0,
        top: 0,
        right: target.width,
        bottom: target.height,
      }) ?? {left: 0, top: 0, right: 0, bottom: 0};
      this.setScissor(target, rect);
    }

    // Culling: D3D culls by screen-space winding with clockwise front faces. Rendering into
    // a texture flips y, which reverses the winding GL sees.
    const cull = rs(RS.CULLMODE);
    this.enable(GL.CULL_FACE, cull === D3DCULL_CW || cull === D3DCULL_CCW);
    const front = target.flipped ? GL.CCW : GL.CW;
    cache.set('frontFace', [front], () => gl.frontFace(front));
    if (cull === D3DCULL_CW || cull === D3DCULL_CCW) {
      const face = cull === D3DCULL_CW ? GL.FRONT : GL.BACK;
      cache.set('cullFace', [face], () => gl.cullFace(face));
    }

    // Blending.
    const blend = rs(RS.ALPHABLENDENABLE) !== 0;
    this.enable(GL.BLEND, blend);
    if (blend) {
      const [src, dst] = blendFactorPair(rs(RS.SRCBLEND), rs(RS.DESTBLEND));
      const separate = rs(RS.SEPARATEALPHABLENDENABLE) !== 0;
      const [srcA, dstA] = separate
        ? blendFactorPair(rs(RS.SRCBLENDALPHA), rs(RS.DESTBLENDALPHA))
        : [src, dst];
      const op = blendEquation(rs(RS.BLENDOP));
      const opA = separate ? blendEquation(rs(RS.BLENDOPALPHA)) : op;
      cache.set('blendFunc', [src, dst, srcA, dstA], () =>
        gl.blendFuncSeparate(src, dst, srcA, dstA),
      );
      cache.set('blendEquation', [op, opA], () => gl.blendEquationSeparate(op, opA));
      const [r, g, b, a] = d3dColorToRgba(rs(RS.BLENDFACTOR));
      cache.set('blendColor', [r, g, b, a], () => gl.blendColor(r, g, b, a));
    }
    this.enable(GL.DITHER, rs(RS.DITHERENABLE) !== 0);

    // Colour writes.
    const mask = rs(RS.COLORWRITEENABLE);
    const colorMask = [(mask & 1) !== 0, (mask & 2) !== 0, (mask & 4) !== 0, (mask & 8) !== 0];
    cache.set('colorMask', colorMask, () =>
      gl.colorMask(colorMask[0]!, colorMask[1]!, colorMask[2]!, colorMask[3]!),
    );

    // Depth.
    const depth = rs(RS.ZENABLE) !== 0;
    this.enable(GL.DEPTH_TEST, depth);
    const zfunc = compareFunction(rs(RS.ZFUNC));
    cache.set('depthFunc', [zfunc], () => gl.depthFunc(zfunc));
    const zwrite = rs(RS.ZWRITEENABLE) !== 0;
    cache.set('depthMask', [zwrite], () => gl.depthMask(zwrite));

    // Stencil. Front faces (D3D clockwise) use the main state, back faces the CCW state
    // when two-sided stencil is on.
    const stencil = rs(RS.STENCILENABLE) !== 0;
    this.enable(GL.STENCIL_TEST, stencil);
    if (stencil) {
      const ref = rs(RS.STENCILREF) & 0xff,
        readMask = rs(RS.STENCILMASK) & 0xff,
        writeMask = rs(RS.STENCILWRITEMASK) & 0xff,
        twoSided = rs(RS.TWOSIDEDSTENCILMODE) !== 0;
      const face = (prefix: 'front' | 'back', glFace: number, ccw: boolean) => {
        const func = compareFunction(rs(ccw ? RS.CCW_STENCILFUNC : RS.STENCILFUNC));
        const fail = stencilOperation(rs(ccw ? RS.CCW_STENCILFAIL : RS.STENCILFAIL));
        const zfail = stencilOperation(rs(ccw ? RS.CCW_STENCILZFAIL : RS.STENCILZFAIL));
        const pass = stencilOperation(rs(ccw ? RS.CCW_STENCILPASS : RS.STENCILPASS));
        cache.set(`stencilFunc${prefix}`, [func, ref, readMask], () =>
          gl.stencilFuncSeparate(glFace, func, ref, readMask),
        );
        cache.set(`stencilOp${prefix}`, [fail, zfail, pass], () =>
          gl.stencilOpSeparate(glFace, fail, zfail, pass),
        );
      };
      face('front', GL.FRONT, false);
      face('back', GL.BACK, twoSided);
      cache.set('stencilMask', [writeMask, writeMask], () => gl.stencilMask(writeMask));
    }
  }

  private uploadUniforms(program: LinkedProgram, target: TargetInfo, layout: FvfLayout): void {
    const gl = this.gl,
      u = program.uniforms,
      v = this.viewport;
    const fixup = u.get(POSITION_FIXUP_UNIFORM);
    // D3D9 pixel centres sit at integer coordinates: shift right and down by (almost) half a
    // pixel (see the shader translator README). PIXEL_CENTER_SHIFT keeps edges that fall
    // exactly on pixel centres off GL's centres, so coverage follows D3D's top-left fill rule
    // whatever GL's tie rule is (a y-flipped tie rule would otherwise move such edges).
    const sx = (2 * PIXEL_CENTER_SHIFT) / v.width,
      sy = (2 * PIXEL_CENTER_SHIFT) / v.height;
    if (fixup)
      if (target.flipped) gl.uniform4f(fixup, 1, -1, sx, sy);
      else gl.uniform4f(fixup, 1, 1, sx, -sy);
    const screen = u.get(SCREEN_FIXUP_UNIFORM);
    if (screen)
      if (target.flipped) gl.uniform4f(screen, 1, 1, -0.5, -0.5);
      else gl.uniform4f(screen, 1, -1, -0.5, target.height - 0.5);
    const vsc = u.get('vs_c');
    if (vsc && program.vertexConstantVersion !== this.vsConstantVersion) {
      gl.uniform4fv(vsc, this.vsConstants, 0, program.vertexFloatCount * 4);
      program.vertexConstantVersion = this.vsConstantVersion;
    }
    const psc = u.get('ps_c');
    if (psc && program.pixelConstantVersion !== this.psConstantVersion) {
      gl.uniform4fv(psc, this.psConstants, 0, program.pixelFloatCount * 4);
      program.pixelConstantVersion = this.psConstantVersion;
    }
    const wvp = u.get(FF_WORLD_VIEW_PROJECTION);
    if (wvp) {
      const matrix = (state: number) => this.transforms.get(state) ?? IDENTITY;
      const combined = multiplyMatrices(
        multiplyMatrices(matrix(TS.WORLD), matrix(TS.VIEW)),
        matrix(TS.PROJECTION),
      );
      // Row-major D3D storage read column-major is the transpose, so `M * v` in GLSL is v·M.
      gl.uniformMatrix4fv(wvp, false, combined);
    }
    const ffScreen = u.get(FF_SCREEN);
    if (ffScreen && layout.pretransformed)
      gl.uniform4f(ffScreen, v.x, v.y, 2 / v.width, 2 / v.height);
    const ffDepth = u.get(FF_DEPTH);
    if (ffDepth) gl.uniform2f(ffDepth, v.minZ, v.maxZ === v.minZ ? 0 : 1 / (v.maxZ - v.minZ));
    const ambient = u.get(FF_AMBIENT);
    if (ambient) gl.uniform4f(ambient, ...d3dColorToRgba(this.renderStates.get(RS.AMBIENT)!));
    const tfactor = u.get(FF_TEXTURE_FACTOR);
    if (tfactor) gl.uniform4f(tfactor, ...d3dColorToRgba(this.renderStates.get(RS.TEXTUREFACTOR)!));
    const constants = u.get(FF_STAGE_CONSTANT);
    if (constants)
      gl.uniform4fv(
        constants,
        this.stageStates.flatMap((s) => d3dColorToRgba(s.get(TSS.CONSTANT)!)),
      );
    const alphaRef = u.get(ALPHA_REF_UNIFORM);
    if (alphaRef) gl.uniform1f(alphaRef, this.renderStates.get(RS.ALPHAREF)! & 0xff);
  }

  /** Binds every stage's texture and applies its sampler states to the unit's sampler. */
  private bindTextures(): void {
    const gl = this.gl;
    for (let unit = 0; unit < TEXTURE_UNITS; unit++) {
      const stage = unit < 16 ? unit : 257 + unit - 16;
      const texture = this.textures.get(stage);
      this.bindTexture(unit, texture?.glTexture ?? null);
      if (!texture) continue;
      const sampler = this.samplerObjects[unit]!;
      this.cache.set(`sampler${unit}`, [sampler], () => gl.bindSampler(unit, sampler));
      const s = this.samplers(stage)!;
      const mip = texture.levelCount > 1 ? s.get(SAMP.MIPFILTER)! : 0;
      const parameters: [number, number][] = [
        [GL.TEXTURE_WRAP_S, addressMode(s.get(SAMP.ADDRESSU)!)],
        [GL.TEXTURE_WRAP_T, addressMode(s.get(SAMP.ADDRESSV)!)],
        [GL.TEXTURE_MAG_FILTER, magFilter(s.get(SAMP.MAGFILTER)!)],
        [GL.TEXTURE_MIN_FILTER, minFilter(s.get(SAMP.MINFILTER)!, mip)],
      ];
      for (const [name, value] of parameters)
        this.cache.set(`sampler${unit}:${name}`, [value], () =>
          gl.samplerParameteri(sampler, name, value),
        );
      const minLod = Math.max(0, s.get(SAMP.MAXMIPLEVEL)!);
      this.cache.set(`sampler${unit}:minLod`, [minLod], () =>
        gl.samplerParameterf(sampler, GL.TEXTURE_MIN_LOD, minLod),
      );
      if (this.anisotropy > 1) {
        const anisotropy =
          s.get(SAMP.MINFILTER) === 3
            ? Math.min(this.anisotropy, Math.max(1, s.get(SAMP.MAXANISOTROPY)!))
            : 1;
        this.cache.set(`sampler${unit}:aniso`, [anisotropy], () =>
          gl.samplerParameterf(sampler, GL.TEXTURE_MAX_ANISOTROPY_EXT, anisotropy),
        );
      }
    }
  }

  private setupVertices(
    program: LinkedProgram,
    layout: FvfLayout,
    vertices: Uint8Array,
    stride: number,
    vertexCount: number,
  ): void {
    const gl = this.gl;
    this.cache.set('vao', [this.vao], () => gl.bindVertexArray(this.vao));
    const bytes = stride * (vertexCount - 1) + layout.stride;
    if (this.vertexScratch.length < stride * vertexCount)
      this.vertexScratch = new Uint8Array(Math.max(stride * vertexCount, 4096));
    copyVertices(vertices, stride, vertexCount, layout.colorOffsets, this.vertexScratch);
    this.cache.set('arrayBuffer', [this.vertexBuffer], () =>
      gl.bindBuffer(GL.ARRAY_BUFFER, this.vertexBuffer),
    );
    gl.bufferData(GL.ARRAY_BUFFER, this.vertexScratch.subarray(0, bytes), GL.STREAM_DRAW);
    const used = new Set<number>();
    for (const attribute of program.attributes) {
      const element = findElement(layout, attribute.usage, attribute.usageIndex);
      const location = attribute.location;
      if (!element) {
        if (this.enabledAttributes.delete(location)) gl.disableVertexAttribArray(location);
        gl.vertexAttrib4f(location, 0, 0, 0, 1);
        continue;
      }
      used.add(location);
      if (!this.enabledAttributes.has(location)) {
        gl.enableVertexAttribArray(location);
        this.enabledAttributes.add(location);
      }
      const type = element.type === 'float' ? GL.FLOAT : GL.UNSIGNED_BYTE;
      const normalized = element.type === 'color';
      this.cache.set(
        `attribute${location}`,
        [element.components, type, normalized, stride, element.offset],
        () =>
          gl.vertexAttribPointer(
            location,
            element.components,
            type,
            normalized,
            stride,
            element.offset,
          ),
      );
    }
    for (const location of [...this.enabledAttributes])
      if (!used.has(location)) {
        gl.disableVertexAttribArray(location);
        this.enabledAttributes.delete(location);
      }
  }
}
