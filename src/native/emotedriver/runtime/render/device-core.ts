import {
  D3D_OK,
  D3DBLEND,
  D3DBLENDOP,
  D3DCLEAR_STENCIL,
  D3DCLEAR_TARGET,
  D3DCMP,
  D3DCULL_NONE,
  D3DDEVTYPE_HAL,
  D3DFMT_A1R5G5B5,
  D3DFMT_A4R4G4B4,
  D3DFMT_A8,
  D3DFMT_A8L8,
  D3DFMT_A8R8G8B8,
  D3DFMT_DXT1,
  D3DFMT_DXT3,
  D3DFMT_DXT5,
  D3DFMT_L8,
  D3DFMT_R5G6B5,
  D3DFVF_DIFFUSE,
  D3DFVF_TEX1,
  D3DFVF_XYZ,
  D3DPOOL_DEFAULT,
  D3DPT_TRIANGLESTRIP,
  D3DRS,
  D3DRTYPE_TEXTURE,
  D3DSAMP,
  D3DSTENCILOP,
  D3DTA,
  D3DTADDRESS_CLAMP,
  D3DTEXF_LINEAR,
  D3DTEXF_POINT,
  D3DTOP,
  D3DTS_PROJECTION,
  D3DTS_VIEW,
  D3DTS_WORLD,
  D3DTSS,
  D3DUSAGE_RENDERTARGET,
  type D3dDisplayMode,
  type D3dRect,
  type D3dResult,
  type D3dViewport,
  type IDirect3D9,
  type IDirect3DDevice9,
  type IDirect3DPixelShader9,
  type IDirect3DSurface9,
  type IDirect3DTexture9,
  type IDirect3DVertexShader9,
} from '../../../d3d9/contract.js';
import {
  d3dxMatrixLookAtLH,
  d3dxMatrixMultiply,
  d3dxMatrixTranspose,
  d3dxVec3Project,
} from './d3dx.js';
import {
  EMOTE_PIXEL_SHADER_COUNT,
  EMOTE_VERTEX_SHADER_COUNT,
  type EmoteShaderBlobs,
} from './shaders.js';

/**
 * `MMotionDevice` (vtable 0x10072724, 0x3f0 bytes, ctor 0x100552e0): the runtime's view of
 * the compositor's `IDirect3DDevice9`. It owns render state save/restore, blending, scissor,
 * masks, pixelate and shader binding; every D3D9 call of the runtime goes through it.
 * Offsets in comments are fields of the native object.
 */

const f = Math.fround;
const FLT_MAX = f(3.4028234663852886e38);

/** `FVF` of the runtime's vertices: x, y, z, ARGB, u, v (24 bytes). */
export const EMOTE_FVF = D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_TEX1;
export const EMOTE_VERTEX_STRIDE = 24;

/** Render states saved at frame begin (table 0x10072510; initial values 0). */
const SAVED_RENDER_STATES: readonly number[] = [
  D3DRS.CULLMODE,
  D3DRS.ALPHAREF,
  D3DRS.ALPHATESTENABLE,
  D3DRS.ALPHAFUNC,
  D3DRS.BLENDOP,
  D3DRS.SRCBLEND,
  D3DRS.DESTBLEND,
  D3DRS.ALPHABLENDENABLE,
  D3DRS.BLENDOPALPHA,
  D3DRS.SRCBLENDALPHA,
  D3DRS.DESTBLENDALPHA,
  D3DRS.LIGHTING,
  D3DRS.STENCILENABLE,
  D3DRS.STENCILFAIL,
  D3DRS.STENCILMASK,
  D3DRS.ZENABLE,
  D3DRS.ZFUNC,
  D3DRS.STENCILFUNC,
  D3DRS.STENCILREF,
  D3DRS.STENCILPASS,
  D3DRS.STENCILZFAIL,
  D3DRS.SCISSORTESTENABLE,
  D3DRS.WRAP0,
  D3DRS.SEPARATEALPHABLENDENABLE,
];
/** Texture stage states saved (table 0x100725d8): [stage, type]. */
const SAVED_STAGE_STATES: readonly (readonly [number, number])[] = [
  [0, D3DTSS.ALPHAOP],
  [0, D3DTSS.ALPHAARG1],
  [0, D3DTSS.ALPHAARG2],
  [0, D3DTSS.COLOROP],
  [0, D3DTSS.COLORARG1],
  [0, D3DTSS.COLORARG2],
  [1, D3DTSS.COLOROP],
  [1, D3DTSS.COLORARG1],
  [1, D3DTSS.COLORARG2],
  [2, D3DTSS.COLOROP],
];
/** Sampler states saved (table 0x10072660): [sampler, type]. */
const SAVED_SAMPLER_STATES: readonly (readonly [number, number])[] = [
  [0, D3DSAMP.ADDRESSU],
  [0, D3DSAMP.ADDRESSV],
  [1, D3DSAMP.ADDRESSU],
  [1, D3DSAMP.ADDRESSV],
  [0, D3DSAMP.MAGFILTER],
  [0, D3DSAMP.MINFILTER],
  [1, D3DSAMP.MAGFILTER],
  [1, D3DSAMP.MINFILTER],
  [0, D3DSAMP.MIPFILTER],
];

/** Blend table 0x100726d8: {BLENDOP, DESTBLEND, SRCBLEND} for modes 0–5. */
export const EMOTE_BLEND_TABLE: readonly (readonly [number, number, number])[] = [
  [D3DBLENDOP.ADD, D3DBLEND.INVSRCALPHA, D3DBLEND.SRCALPHA],
  [D3DBLENDOP.ADD, D3DBLEND.ONE, D3DBLEND.SRCALPHA],
  [D3DBLENDOP.REVSUBTRACT, D3DBLEND.ONE, D3DBLEND.SRCALPHA],
  [D3DBLENDOP.ADD, D3DBLEND.INVSRCALPHA, D3DBLEND.DESTCOLOR],
  [D3DBLENDOP.ADD, D3DBLEND.ONE, D3DBLEND.INVDESTCOLOR],
  [D3DBLENDOP.REVSUBTRACT, D3DBLEND.ONE, D3DBLEND.SRCALPHA],
];

/** Pixel shader index (0x10056ae2): `variant + 3·mask + 6·colorDouble + 12·alphaOnly`. */
export function emotePixelShaderIndex(
  blendMode: number,
  mask: boolean,
  alphaOnly: boolean,
): number {
  const mode = blendMode & 0xf,
    variant = mode === 3 || mode === 4 ? 2 : mode === 5 ? 1 : 0;
  return variant + 3 * (+mask + 2 * +((blendMode & 0xf0) !== 0) + 4 * +alphaOnly);
}

/** Texture record (0x20 bytes, renderer table +0x78). */
export interface EmoteTextureRecord {
  /** +0x08 / +0x0c: created texture size (UV divisor). */
  readonly width: number;
  readonly height: number;
  readonly format: number;
  /** +0x10 → +0x10. */
  readonly texture: IDirect3DTexture9;
  /** +0x1c: uploaded as `D3DFMT_A8`. */
  readonly alphaOnly: boolean;
}

/** Format support flags +0x2a9..+0x2b1 (`CheckDeviceFormat`). */
export interface EmoteFormatSupport {
  a8: boolean;
  l8: boolean;
  a8l8: boolean;
  a1r5g5b5: boolean;
  a4r4g4b4: boolean;
  r5g6b5: boolean;
  dxt1: boolean;
  dxt3: boolean;
  dxt5: boolean;
}

/** `IDirect3D9` slot 8, pending in the d3d9 contract. */
type IDirect3D9WithAdapterMode = IDirect3D9 & {
  getAdapterDisplayMode?(adapter: number): D3dResult<D3dDisplayMode>;
};

/** Uniform rounding of 0x10027fa0: half away from zero. */
function roundHalfAway(x: number): number {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

const u32ToFloat = (value: number): number => f(value >>> 0);

/** Fixed-point corner interpolation along a line of `count` cells (0x1002ab90). */
function lerpLine(colors: Uint32Array, start: number, count: number, stride: number): void {
  if (count <= 2) return;
  const a = colors[start]!,
    b = colors[start + (count - 1) * stride]!;
  if (a === b) {
    for (let k = 1; k < count - 1; k++) colors[start + k * stride] = a;
    return;
  }
  const steps = count - 1,
    aLow = a & 0xff00ff,
    bLow = b & 0xff00ff,
    aHigh = (a >>> 8) & 0xff00ff,
    bHigh = (b >>> 8) & 0xff00ff;
  for (let k = 1; k < steps; k++) {
    const t = ((k * 256) / steps) >>> 0,
      s = 256 - t,
      low = ((Math.imul(t, bLow) + Math.imul(s, aLow)) >>> 0) >>> 8,
      high = (Math.imul(t, bHigh) + Math.imul(s, aHigh)) >>> 0;
    colors[start + k * stride] = (((low ^ high) & 0xff00ff) ^ high) >>> 0;
  }
}

/**
 * Per-vertex colours of a (columns + 1) × (rows + 1) grid from four corners
 * [top-left, top-right, bottom-left, bottom-right] (0x1002dc40).
 */
export function emoteGridColors(corners: Uint32Array, columns: number, rows: number): Uint32Array {
  const across = columns + 1,
    down = rows + 1,
    out = new Uint32Array(across * down);
  const c0 = corners[0]!;
  if (corners[1] === c0 && corners[2] === c0 && corners[3] === c0) {
    out.fill(c0);
    return out;
  }
  out[0] = c0;
  out[across - 1] = corners[1]!;
  out[rows * across] = corners[2]!;
  out[across * down - 1] = corners[3]!;
  lerpLine(out, 0, down, across);
  lerpLine(out, across - 1, down, across);
  for (let row = 0; row < down; row++) lerpLine(out, row * across, across, 1);
  return out;
}

export class EmoteDeviceCore {
  /** +0x08 D3DCAPS9 fields; +0x60/+0x64 lowered by `SetMaxTextureSize`. */
  maxTextureWidth = 0;
  maxTextureHeight = 0;
  textureCaps = 0;
  vertexShaderVersion = 0;
  pixelShaderVersion = 0;
  /** +0x138 / +0x178 / +0x1b8. */
  world = new Float32Array(16);
  view = new Float32Array(16);
  projection = new Float32Array(16);
  /** +0x1f8. */
  viewport: D3dViewport = {x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1};
  /** +0x210: viewport scaled to the alpha-mask targets. */
  private maskViewport: D3dViewport = {x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1};
  /** +0x228 shader level allowed (device slot 7), +0x22c supported. */
  shaderLevelAllowed = 0;
  shaderLevelSupported = 0;
  /** +0x230 / +0x234 alpha-mask targets and their sizes (+0x238..+0x244). */
  private readonly maskTargets: (IDirect3DTexture9 | null)[] = [null, null];
  private readonly maskTargetSizes: [number, number][] = [
    [0, 0],
    [0, 0],
  ];
  /** +0x248 first mask pending, +0x249 building masks, +0x24a mask bound. */
  private maskFirst = false;
  maskBuilding = false;
  maskBound = false;
  /** +0x24c `cScOffset` (VS c4), +0x25c `cScMul` (PS c0). */
  private readonly scOffset = new Float32Array(4);
  private readonly scMul = new Float32Array(4);
  /** +0x26c. */
  private savedTarget: IDirect3DSurface9 | null = null;
  /** +0x270 (default 1), +0x274. */
  maskMode = 1;
  maskRegionClipping = false;
  /** +0x278 current blend mode, +0x27c bound texture alpha-only. */
  blendState = 0;
  alphaOnly = false;
  /** +0x280 clip rect saved at alpha-mask begin, +0x290 the same in mask-target space. */
  private savedClip: [number, number, number, number] = [0, 0, 0, 0];
  private maskScissor: [number, number, number, number] = [0, 0, 0, 0];
  /** +0x2a0 / +0x2a4 / +0x2a8. */
  protectTranslucentTextureColor = false;
  alphaOp = 0;
  mipMapEnabled = true;
  readonly formats: EmoteFormatSupport = {
    a8: false,
    l8: false,
    a8l8: false,
    a1r5g5b5: false,
    a4r4g4b4: false,
    r5g6b5: false,
    dxt1: false,
    dxt3: false,
    dxt5: false,
  };
  /** +0x2b4 / +0x2b8 render-target size at frame begin. */
  private targetWidth = 0;
  private targetHeight = 0;
  /** +0x2bc.. shader caches, +0x2cc / +0x2d0 bound shaders. */
  private readonly vertexSm2: (IDirect3DVertexShader9 | null)[] = new Array<null>(
    EMOTE_VERTEX_SHADER_COUNT,
  ).fill(null);
  private readonly pixelSm2: (IDirect3DPixelShader9 | null)[] = new Array<null>(
    EMOTE_PIXEL_SHADER_COUNT,
  ).fill(null);
  private readonly vertexSm3: (IDirect3DVertexShader9 | null)[] = new Array<null>(
    EMOTE_VERTEX_SHADER_COUNT,
  ).fill(null);
  private readonly pixelSm3: (IDirect3DPixelShader9 | null)[] = new Array<null>(
    EMOTE_PIXEL_SHADER_COUNT,
  ).fill(null);
  private currentVertexShader: IDirect3DVertexShader9 | null = null;
  private currentPixelShader: IDirect3DPixelShader9 | null = null;
  /** +0x2d4..+0x36c saved state. */
  private savedRenderStates: [number, number][] = [];
  private savedStageStates: [number, number, number][] = [];
  private savedSamplerStates: [number, number, number][] = [];
  private savedFvf = 0;
  private savedScissor: D3dRect = {left: 0, top: 0, right: 0, bottom: 0};
  private savedVertexConstants = new Float32Array(20);
  private savedVertexShader: IDirect3DVertexShader9 | null = null;
  private savedPixelShader: IDirect3DPixelShader9 | null = null;
  /** +0x370..+0x378 alpha test saved by the stencil mask. */
  private savedAlphaTest = [0, 0, 0];
  /** +0x37c. */
  currentTexture: EmoteTextureRecord | null = null;
  /** +0x3a0..+0x3ac current clip rect (x0, y0, x1, y1). */
  clipRect: [number, number, number, number] = [0, 0, 0, 0];
  /** +0x3b0. */
  lost = false;
  /** +0x3b4: the client's pixelate source texture, cleared after each Render. */
  pixelateSource: IDirect3DTexture9 | null = null;
  /** +0x3b8 (default 100), +0x3bc target, +0x3c0 size, +0x3c8 texture size. */
  pixelateDivision = 100;
  private pixelateTarget: IDirect3DTexture9 | null = null;
  private pixelateSize: [number, number] = [0, 0];
  private pixelateTextureSize: [number, number] = [0, 0];
  /** +0x3d0 VS c4 and +0x3e0 PS c0 for pixelate. */
  private readonly pixelateVertexConstant = new Float32Array(4);
  private readonly pixelatePixelConstant = new Float32Array(4);

  /** ctor 0x100552e0 and init 0x100555a0. `blobs` null forces shader level 0. */
  constructor(
    readonly device: IDirect3DDevice9,
    private readonly blobs: EmoteShaderBlobs | null,
  ) {
    const caps = device.getDeviceCaps().value;
    if (caps !== null) {
      this.maxTextureWidth = caps.maxTextureWidth;
      this.maxTextureHeight = caps.maxTextureHeight;
      this.textureCaps = caps.textureCaps;
      this.vertexShaderVersion = caps.vertexShaderVersion >>> 0;
      this.pixelShaderVersion = caps.pixelShaderVersion >>> 0;
    }
    const d3d = device.getDirect3D();
    if (d3d.hr === D3D_OK && d3d.value !== null) {
      // Natively `IDirect3D9::GetAdapterDisplayMode(0, &mode)` (slot 8), which the d3d9
      // contract does not carry yet; the device's own display mode is the same adapter mode.
      const adapter = d3d.value as IDirect3D9WithAdapterMode;
      const display =
        adapter.getAdapterDisplayMode !== undefined
          ? adapter.getAdapterDisplayMode(0)
          : device.getDisplayMode(0);
      if (display.hr === D3D_OK && display.value !== null) {
        const check = (format: number): boolean =>
          d3d.value!.checkDeviceFormat(
            0,
            D3DDEVTYPE_HAL,
            display.value!.format,
            0,
            D3DRTYPE_TEXTURE,
            format,
          ) === D3D_OK;
        this.formats.a8 = check(D3DFMT_A8);
        this.formats.l8 = check(D3DFMT_L8);
        this.formats.a8l8 = check(D3DFMT_A8L8);
        this.formats.a1r5g5b5 = check(D3DFMT_A1R5G5B5);
        this.formats.a4r4g4b4 = check(D3DFMT_A4R4G4B4);
        this.formats.r5g6b5 = check(D3DFMT_R5G6B5);
        this.formats.dxt1 = check(D3DFMT_DXT1);
        this.formats.dxt3 = check(D3DFMT_DXT3);
        this.formats.dxt5 = check(D3DFMT_DXT5);
      }
      d3d.value.release();
    }
    this.shaderLevelSupported = 0;
    this.shaderLevelAllowed = 0;
    if (this.vertexShaderVersion >= 0xfffe0200) {
      if (this.pixelShaderVersion >= 0xffff0200) this.shaderLevelSupported = 1;
      if (this.pixelShaderVersion >= 0xffff0300) this.shaderLevelSupported = 2;
    }
    // Without the embedded shader blobs the runtime has no programs to create; it then runs
    // exactly as on a device without shader support (level 0).
    if (blobs === null) this.shaderLevelSupported = 0;
    if (this.shaderLevelSupported !== 0) {
      this.shaderLevelAllowed = this.shaderLevelSupported;
      // 256×256 R5G6B5 render-target probe; failure forces level 0.
      const probe = device.createTexture(
        0x100,
        0x100,
        1,
        D3DUSAGE_RENDERTARGET,
        D3DFMT_R5G6B5,
        D3DPOOL_DEFAULT,
      );
      if (probe.hr !== D3D_OK) {
        this.shaderLevelSupported = 0;
        this.shaderLevelAllowed = 0;
        return;
      }
      probe.value?.release();
    }
  }

  /** min(+0x228, +0x22c). */
  shaderLevel(): number {
    return Math.min(this.shaderLevelAllowed >>> 0, this.shaderLevelSupported >>> 0);
  }

  /** 0x100561c0. */
  setVertexShader(index: number): void {
    const level = this.shaderLevel();
    if (level !== 1 && level !== 2) return;
    const cache = level === 1 ? this.vertexSm2 : this.vertexSm3;
    if (cache[index] === null) {
      const blob = (level === 1 ? this.blobs!.vertexSm2 : this.blobs!.vertexSm3)[index]!;
      cache[index] = this.device.createVertexShader(blob).value;
    }
    const shader = cache[index]!;
    if (this.currentVertexShader === shader) return;
    this.currentVertexShader = shader;
    this.device.setVertexShader(shader);
    if (level === 1) {
      if (index === 1) this.device.setVertexShaderConstantF(4, this.scOffset, 1);
      else if (index === 2) this.device.setVertexShaderConstantF(4, this.pixelateVertexConstant, 1);
    }
  }

  /** 0x100562d0. `masked` is the caller's mask flag (selects `cScMul` at SM3). */
  setPixelShader(index: number, masked: boolean): void {
    const level = this.shaderLevel();
    if (level !== 1 && level !== 2) return;
    const cache = level === 1 ? this.pixelSm2 : this.pixelSm3;
    if (cache[index] === null) {
      const blob = (level === 1 ? this.blobs!.pixelSm2 : this.blobs!.pixelSm3)[index]!;
      cache[index] = this.device.createPixelShader(blob).value;
    }
    const shader = cache[index]!;
    if (this.currentPixelShader === shader) return;
    this.currentPixelShader = shader;
    this.device.setPixelShader(shader);
    if (level === 2) {
      if (masked) this.device.setPixelShaderConstantF(0, this.scMul, 1);
      if (index === 26) this.device.setPixelShaderConstantF(0, this.pixelatePixelConstant, 1);
    }
  }

  /** 0x10056940: blend mode (`& 0xf` table index, `& 0xf0` colour double). */
  setBlend(mode: number): void {
    const d = this.device;
    this.blendState = mode >>> 0;
    const index = mode & 0xf,
      colorDouble = mode & 0xf0;
    if (this.shaderLevel() !== 0) {
      this.setPixelShader(
        emotePixelShaderIndex(mode, this.maskBound, this.alphaOnly),
        this.maskBound,
      );
    } else {
      if (!this.alphaOnly) {
        d.setTextureStageState(0, D3DTSS.COLORARG1, D3DTA.DIFFUSE);
        d.setTextureStageState(0, D3DTSS.COLORARG2, D3DTA.TEXTURE);
        if (colorDouble === 0) d.setTextureStageState(0, D3DTSS.COLOROP, D3DTOP.MODULATE);
        else if (colorDouble === 0x10) d.setTextureStageState(0, D3DTSS.COLOROP, D3DTOP.MODULATE2X);
      } else if (colorDouble === 0) {
        d.setTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1);
        d.setTextureStageState(0, D3DTSS.COLORARG1, D3DTA.DIFFUSE);
      } else if (colorDouble === 0x10) {
        d.setTextureStageState(0, D3DTSS.COLOROP, D3DTOP.ADD);
        d.setTextureStageState(0, D3DTSS.COLORARG1, D3DTA.DIFFUSE);
        d.setTextureStageState(0, D3DTSS.COLORARG2, D3DTA.DIFFUSE);
      }
      if (index === 3 || index === 4) {
        d.setTextureStageState(1, D3DTSS.COLOROP, D3DTOP.MODULATE);
        d.setTextureStageState(1, D3DTSS.COLORARG1, D3DTA.CURRENT | D3DTA.ALPHAREPLICATE);
        d.setTextureStageState(1, D3DTSS.COLORARG2, D3DTA.CURRENT);
        d.setTextureStageState(2, D3DTSS.COLOROP, D3DTOP.DISABLE);
      } else if (index === 5) {
        d.setTextureStageState(1, D3DTSS.COLOROP, D3DTOP.SELECTARG1);
        d.setTextureStageState(1, D3DTSS.COLORARG1, D3DTA.CURRENT | D3DTA.COMPLEMENT);
        d.setTextureStageState(2, D3DTSS.COLOROP, D3DTOP.DISABLE);
      } else d.setTextureStageState(1, D3DTSS.COLOROP, D3DTOP.DISABLE);
    }
    // Indices 6–15 read past the six-entry table natively; only mode 0–5 items reach here
    // (mode 6 items take the pixelate pass).
    const entry = EMOTE_BLEND_TABLE[index] ?? EMOTE_BLEND_TABLE[0]!;
    d.setRenderState(D3DRS.BLENDOP, entry[0]);
    d.setRenderState(D3DRS.DESTBLEND, entry[1]);
    d.setRenderState(D3DRS.SRCBLEND, entry[2]);
    if (index === 0) {
      if (this.alphaOp === 0) {
        d.setRenderState(D3DRS.BLENDOPALPHA, D3DBLENDOP.ADD);
        d.setRenderState(D3DRS.DESTBLENDALPHA, D3DBLEND.INVSRCALPHA);
      } else if (this.alphaOp === 1) {
        d.setRenderState(D3DRS.BLENDOPALPHA, D3DBLENDOP.ADD);
        d.setRenderState(D3DRS.DESTBLENDALPHA, D3DBLEND.ONE);
      } else return;
      d.setRenderState(D3DRS.SRCBLENDALPHA, D3DBLEND.ONE);
    } else {
      d.setRenderState(D3DRS.BLENDOPALPHA, D3DBLENDOP.ADD);
      d.setRenderState(D3DRS.DESTBLENDALPHA, D3DBLEND.ONE);
      d.setRenderState(D3DRS.SRCBLENDALPHA, D3DBLEND.ZERO);
    }
  }

  /** 0x10056600: clip rect (x0, y0, x1, y1) → scissor, off when it equals the viewport. */
  setClipRect(x0: number, y0: number, x1: number, y1: number): void {
    const r: [number, number, number, number] = [f(x0), f(y0), f(x1), f(y1)];
    this.clipRect = r;
    const width = u32ToFloat(this.viewport.width),
      height = u32ToFloat(this.viewport.height);
    if (r[0] === 0 && r[1] === 0 && width === r[2] && height === r[3]) {
      this.device.setRenderState(D3DRS.SCISSORTESTENABLE, 0);
      return;
    }
    const rect = {
      left: roundHalfAway(r[0]),
      top: roundHalfAway(r[1]),
      right: roundHalfAway(r[2]),
      bottom: roundHalfAway(r[3]),
    };
    this.device.setRenderState(D3DRS.SCISSORTESTENABLE, 1);
    this.device.setScissorRect(rect);
  }

  /** 0x100567f0: screen bounds of a model-space rect through WORLD·VIEW·PROJECTION. */
  projectRect(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    const corners: [number, number][] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const out: [number, number, number, number] = [0, 0, 0, 0];
    corners.forEach(([x, y], i) => {
      const [px, py] = d3dxVec3Project(
        [x, y, 0],
        this.viewport,
        this.projection,
        this.view,
        this.world,
      );
      if (i === 0) {
        out[0] = out[2] = px;
        out[1] = out[3] = py;
      } else {
        if (!(out[0] <= px)) out[0] = px;
        if (!(out[1] <= py)) out[1] = py;
        if (!(px <= out[2])) out[2] = px;
        if (!(py <= out[3])) out[3] = py;
      }
    });
    return out;
  }

  /** 0x10055a40. */
  private saveState(): void {
    const d = this.device;
    const view = d.getTransform(D3DTS_VIEW).value;
    if (view !== null) this.view = Float32Array.from(view);
    const projection = d.getTransform(D3DTS_PROJECTION).value;
    if (projection !== null) this.projection = Float32Array.from(projection);
    const world = d.getTransform(D3DTS_WORLD).value;
    if (world !== null) this.world = Float32Array.from(world);
    const viewport = d.getViewport().value;
    if (viewport !== null) this.viewport = viewport;
    const fvf = d.getFVF().value;
    if (fvf !== null) this.savedFvf = fvf;
    const scissor = d.getScissorRect().value;
    if (scissor !== null) this.savedScissor = scissor;
    this.savedRenderStates = SAVED_RENDER_STATES.map((state) => [
      state,
      d.getRenderState(state).value ?? 0,
    ]);
    this.savedStageStates = SAVED_STAGE_STATES.map(([stage, type]) => [
      stage,
      type,
      d.getTextureStageState(stage, type).value ?? 0,
    ]);
    this.savedSamplerStates = SAVED_SAMPLER_STATES.map(([sampler, type]) => [
      sampler,
      type,
      d.getSamplerState(sampler, type).value ?? 0,
    ]);
    if (this.shaderLevel() !== 0) {
      const constants = d.getVertexShaderConstantF(0, 5).value;
      if (constants !== null) this.savedVertexConstants = Float32Array.from(constants);
      this.savedVertexShader = d.getVertexShader().value;
      this.savedPixelShader = d.getPixelShader().value;
    }
  }

  /**
   * 0x10056090. The shaders returned by `GetVertexShader`/`GetPixelShader` at save are set
   * back without a `Release`, as natively.
   */
  restoreState(): void {
    const d = this.device;
    d.setFVF(this.savedFvf);
    d.setScissorRect(this.savedScissor);
    for (const [state, value] of this.savedRenderStates) d.setRenderState(state, value);
    for (const [stage, type, value] of this.savedStageStates)
      d.setTextureStageState(stage, type, value);
    for (const [sampler, type, value] of this.savedSamplerStates)
      d.setSamplerState(sampler, type, value);
    if (this.shaderLevel() !== 0) {
      d.setVertexShaderConstantF(0, this.savedVertexConstants, 5);
      d.setVertexShader(this.savedVertexShader);
      d.setPixelShader(this.savedPixelShader);
    }
  }

  /** transpose(WORLD · VIEW · PROJECTION). */
  private shaderMatrix(): Float32Array {
    return d3dxMatrixTranspose(
      d3dxMatrixMultiply(d3dxMatrixMultiply(this.world, this.view), this.projection),
    );
  }

  /** 0x10056c20: state save and the runtime's fixed state for a frame. */
  beginFrame(smoothing: boolean): void {
    const d = this.device;
    this.saveState();
    const target = d.getRenderTarget(0).value;
    if (target !== null) {
      const desc = target.getDesc();
      target.release();
      this.targetWidth = desc.width;
      this.targetHeight = desc.height;
    }
    this.clipRect = [0, 0, u32ToFloat(this.viewport.width), u32ToFloat(this.viewport.height)];
    d.setFVF(EMOTE_FVF);
    d.setRenderState(D3DRS.CULLMODE, D3DCULL_NONE);
    d.setRenderState(D3DRS.ZENABLE, 0);
    d.setRenderState(D3DRS.ALPHAREF, 0);
    d.setRenderState(D3DRS.ALPHATESTENABLE, 1);
    d.setRenderState(D3DRS.ALPHAFUNC, D3DCMP.GREATER);
    d.setRenderState(D3DRS.SEPARATEALPHABLENDENABLE, 1);
    d.setRenderState(D3DRS.ALPHABLENDENABLE, 1);
    d.setRenderState(D3DRS.BLENDOP, D3DBLENDOP.ADD);
    d.setRenderState(D3DRS.SRCBLEND, D3DBLEND.SRCALPHA);
    d.setRenderState(D3DRS.DESTBLEND, D3DBLEND.INVSRCALPHA);
    if (this.alphaOp === 0 || this.alphaOp === 1) {
      d.setRenderState(D3DRS.BLENDOPALPHA, D3DBLENDOP.ADD);
      d.setRenderState(
        D3DRS.DESTBLENDALPHA,
        this.alphaOp === 0 ? D3DBLEND.INVSRCALPHA : D3DBLEND.ONE,
      );
      d.setRenderState(D3DRS.SRCBLENDALPHA, D3DBLEND.ONE);
    }
    d.setTextureStageState(0, D3DTSS.ALPHAOP, D3DTOP.MODULATE);
    d.setTextureStageState(0, D3DTSS.ALPHAARG1, D3DTA.TEXTURE);
    d.setTextureStageState(0, D3DTSS.ALPHAARG2, D3DTA.DIFFUSE);
    d.setSamplerState(0, D3DSAMP.ADDRESSU, D3DTADDRESS_CLAMP);
    d.setSamplerState(0, D3DSAMP.ADDRESSV, D3DTADDRESS_CLAMP);
    d.setSamplerState(1, D3DSAMP.ADDRESSU, D3DTADDRESS_CLAMP);
    d.setSamplerState(1, D3DSAMP.ADDRESSV, D3DTADDRESS_CLAMP);
    d.setSamplerState(0, D3DSAMP.MIPFILTER, D3DTEXF_LINEAR);
    const filter = smoothing ? D3DTEXF_LINEAR : D3DTEXF_POINT;
    d.setSamplerState(0, D3DSAMP.MAGFILTER, filter);
    d.setSamplerState(0, D3DSAMP.MINFILTER, filter);
    d.setSamplerState(1, D3DSAMP.MAGFILTER, D3DTEXF_LINEAR);
    d.setSamplerState(1, D3DSAMP.MINFILTER, D3DTEXF_LINEAR);
    d.setRenderState(D3DRS.WRAP0, 0);
    d.setRenderState(D3DRS.LIGHTING, 0);
    if (this.shaderLevel() !== 0) {
      const matrix = this.shaderMatrix();
      this.currentVertexShader = null;
      this.currentPixelShader = null;
      d.setVertexShaderConstantF(0, matrix, 4);
      this.setVertexShader(0);
    }
  }

  /** 0x100563f0: alpha-mask target `index`, power-of-two sizes where the caps require it. */
  private ensureMaskTarget(index: number, width: number, height: number): boolean {
    const caps = this.textureCaps & 0x102;
    if (caps !== 0 && caps !== 0x102) {
      width = floorPow2(width);
      height = floorPow2(height);
    }
    const current = this.maskTargets[index]!;
    const size = this.maskTargetSizes[index]!;
    if (current !== null) {
      if (size[0] === width && size[1] === height) return true;
      current.release();
      this.maskTargets[index] = null;
    }
    size[0] = width;
    size[1] = height;
    const created = this.device.createTexture(
      width,
      height,
      1,
      D3DUSAGE_RENDERTARGET,
      D3DFMT_R5G6B5,
      D3DPOOL_DEFAULT,
    );
    this.maskTargets[index] = created.value;
    return created.hr === D3D_OK;
  }

  /** 0x100564f0. */
  private prepareMaskTargets(width: number, height: number): boolean {
    if (this.shaderLevel() === 0) return false;
    if (this.ensureMaskTarget(0, width, height) && this.ensureMaskTarget(1, width, height)) {
      const w = u32ToFloat(this.maskTargetSizes[0]![0]),
        h = u32ToFloat(this.maskTargetSizes[0]![1]);
      this.scOffset[0] = f(0.5 / w + 0.5);
      this.scOffset[1] = f(0.5 / h + 0.5);
      this.scMul[0] = f(1 / w);
      this.scMul[1] = f(1 / h);
      return true;
    }
    for (let i = 0; i < 2; i++) {
      this.maskTargets[i]?.release();
      this.maskTargets[i] = null;
    }
    return false;
  }

  /**
   * 0x10056ff0. `excludeBase` is 1 when the chain has exclude masks: the stencil starts at
   * that value and include references count up from it.
   */
  beginMask(excludeBase: number): void {
    const d = this.device;
    for (;;) {
      if (this.maskMode === 0) {
        d.clear(null, D3DCLEAR_STENCIL, 0, 1, excludeBase);
        d.setRenderState(D3DRS.STENCILENABLE, 1);
        d.setRenderState(D3DRS.STENCILFAIL, D3DSTENCILOP.KEEP);
        d.setRenderState(D3DRS.STENCILMASK, 0xff);
        d.setRenderState(D3DRS.ZENABLE, 1);
        d.setRenderState(D3DRS.ZFUNC, D3DCMP.NEVER);
        this.savedAlphaTest = [
          d.getRenderState(D3DRS.ALPHATESTENABLE).value ?? this.savedAlphaTest[0]!,
          d.getRenderState(D3DRS.ALPHAFUNC).value ?? this.savedAlphaTest[1]!,
          d.getRenderState(D3DRS.ALPHAREF).value ?? this.savedAlphaTest[2]!,
        ];
        d.setRenderState(D3DRS.ALPHATESTENABLE, 1);
        d.setRenderState(D3DRS.ALPHAFUNC, D3DCMP.GREATER);
        d.setRenderState(D3DRS.ALPHAREF, 0x40);
        return;
      }
      if (this.maskMode !== 1) return;
      if (this.prepareMaskTargets(this.viewport.width, this.viewport.height)) break;
      // The alpha path is unavailable: the device falls back to stencil masks for good.
      this.maskMode = 0;
    }
    this.maskFirst = true;
    this.maskBuilding = true;
    this.savedTarget = d.getRenderTarget(0).value;
    this.savedClip = [...this.clipRect];
    const rtW = this.maskTargetSizes[0]![0],
      rtH = this.maskTargetSizes[0]![1],
      vp = this.viewport,
      fw = u32ToFloat(rtW),
      fh = u32ToFloat(rtH),
      vw = u32ToFloat(vp.width),
      vh = u32ToFloat(vp.height),
      c = this.clipRect;
    this.maskScissor = [
      f((fw * c[0]) / vw),
      f((fh * c[1]) / vh),
      f((fw * c[2]) / vw),
      f((c[3] * fh) / vh),
    ];
    const div = (a: number, b: number): number => Math.floor((Math.imul(a, b) >>> 0) / vp.width);
    const divH = (a: number, b: number): number => Math.floor((Math.imul(a, b) >>> 0) / vp.height);
    this.maskViewport = {
      x: div(vp.x, rtW),
      y: divH(vp.y, rtH),
      width: div(rtW, vp.width),
      height: divH(rtH, vp.height),
      minZ: vp.minZ,
      maxZ: vp.maxZ,
    };
  }

  private bindMaskTarget(texture: IDirect3DTexture9): void {
    const surface = texture.getSurfaceLevel(0).value;
    this.device.setRenderTarget(0, surface);
    surface?.release();
    const s = this.maskScissor;
    this.setClipRect(s[0], s[1], s[2], s[3]);
    this.device.setViewport(this.maskViewport);
  }

  /** 0x100572e0: before drawing include mask `reference`. */
  includeMask(reference: number): void {
    const d = this.device;
    if (this.maskMode === 0) {
      d.setRenderState(D3DRS.STENCILFUNC, D3DCMP.EQUAL);
      d.setRenderState(D3DRS.STENCILREF, reference);
      d.setRenderState(D3DRS.STENCILPASS, D3DSTENCILOP.INCR);
      d.setRenderState(D3DRS.STENCILZFAIL, D3DSTENCILOP.INCR);
      return;
    }
    if (this.maskMode !== 1) return;
    d.setTexture(1, null);
    if (this.maskFirst) {
      this.maskFirst = false;
      this.bindMaskTarget(this.maskTargets[0]!);
      this.setVertexShader(0);
      this.setPixelShader(24, false);
      d.setRenderState(D3DRS.BLENDOP, D3DBLENDOP.ADD);
      d.setRenderState(D3DRS.SRCBLEND, D3DBLEND.ONE);
      d.setRenderState(D3DRS.DESTBLEND, D3DBLEND.INVSRCCOLOR);
      d.clear(null, D3DCLEAR_TARGET, 0, 1, 0);
      return;
    }
    const previous = this.maskTargets[0]!;
    this.maskTargets[0] = this.maskTargets[1]!;
    this.maskTargets[1] = previous;
    this.bindMaskTarget(this.maskTargets[0]!);
    this.setVertexShader(1);
    this.setPixelShader(25, true);
    d.clear(null, D3DCLEAR_TARGET, 0, 1, 0);
    d.setTexture(1, this.maskTargets[1]);
  }

  /** 0x10057540: before the exclude masks. */
  excludeMasks(reference: number): void {
    const d = this.device;
    if (this.maskMode === 0) {
      d.setRenderState(D3DRS.STENCILFUNC, D3DCMP.EQUAL);
      d.setRenderState(D3DRS.STENCILREF, reference);
      d.setRenderState(D3DRS.STENCILPASS, D3DSTENCILOP.DECR);
      d.setRenderState(D3DRS.STENCILZFAIL, D3DSTENCILOP.DECR);
      return;
    }
    if (this.maskMode !== 1) return;
    d.setTexture(1, null);
    if (this.maskFirst) {
      this.maskFirst = false;
      this.bindMaskTarget(this.maskTargets[0]!);
      d.clear(null, D3DCLEAR_TARGET, 0xffffffff | 0, 1, 0);
    }
    this.setVertexShader(0);
    this.setPixelShader(24, false);
    d.setRenderState(D3DRS.BLENDOP, D3DBLENDOP.ADD);
    d.setRenderState(D3DRS.SRCBLEND, D3DBLEND.ZERO);
    d.setRenderState(D3DRS.DESTBLEND, D3DBLEND.INVSRCCOLOR);
  }

  /** 0x100576c0: masks done; the masked items follow. */
  endMask(reference: number): void {
    const d = this.device;
    if (this.maskMode === 0) {
      d.setRenderState(D3DRS.STENCILPASS, D3DSTENCILOP.KEEP);
      d.setRenderState(D3DRS.STENCILZFAIL, D3DSTENCILOP.KEEP);
      d.setRenderState(D3DRS.STENCILFUNC, D3DCMP.EQUAL);
      d.setRenderState(D3DRS.STENCILREF, reference);
      d.setRenderState(D3DRS.ZENABLE, 0);
      d.setRenderState(D3DRS.ALPHATESTENABLE, this.savedAlphaTest[0]!);
      d.setRenderState(D3DRS.ALPHAFUNC, this.savedAlphaTest[1]!);
      d.setRenderState(D3DRS.ALPHAREF, this.savedAlphaTest[2]!);
      return;
    }
    if (this.maskMode !== 1) return;
    d.setRenderTarget(0, this.savedTarget);
    this.savedTarget?.release();
    const s = this.savedClip;
    this.setClipRect(s[0], s[1], s[2], s[3]);
    d.setViewport(this.viewport);
    this.setVertexShader(1);
    d.setTexture(1, this.maskTargets[0]!);
    this.maskBuilding = false;
    this.maskBound = true;
    this.setBlend(this.blendState);
  }

  /** 0x10057820: the next item has no mask. */
  unbindMask(): void {
    if (this.maskMode === 0) {
      this.device.setRenderState(D3DRS.STENCILENABLE, 0);
      return;
    }
    if (this.maskMode !== 1) return;
    this.device.setTexture(1, null);
    this.setVertexShader(0);
    this.maskBound = false;
    this.setBlend(this.blendState);
  }

  /** Binds a texture record on stage 0 (inline in 0x10003f70, 0x10058810). */
  bindTexture(record: EmoteTextureRecord): void {
    const wasAlphaOnly = this.alphaOnly;
    this.currentTexture = record;
    this.device.setTexture(0, record.texture);
    this.alphaOnly = record.alphaOnly;
    if (wasAlphaOnly !== this.alphaOnly && !this.maskBuilding) this.setBlend(this.blendState);
  }

  /**
   * 0x10058120: draws a vertex grid with the bound texture; the
   * `protectTranslucentTextureColor` pass first when blend mode 0 draws a translucent item.
   * `colors` are the corners [top-left, top-right, bottom-left, bottom-right], ARGB.
   */
  drawGrid(
    positions: Float32Array,
    u: number,
    v: number,
    w: number,
    h: number,
    columns: number,
    rows: number,
    flags: number,
    colors: Uint32Array,
  ): void {
    const d = this.device;
    if (
      this.protectTranslucentTextureColor &&
      (this.blendState & 0xf) === 0 &&
      ((flags & 1) !== 0 ||
        (colors[3]! & colors[2]! & colors[1]! & colors[0]! & 0xff000000) >>> 0 !== 0xff000000)
    ) {
      d.setRenderState(D3DRS.SRCBLEND, D3DBLEND.INVDESTALPHA);
      d.setRenderState(D3DRS.DESTBLEND, D3DBLEND.DESTALPHA);
      d.setRenderState(D3DRS.SRCBLENDALPHA, D3DBLEND.ZERO);
      d.setRenderState(D3DRS.DESTBLENDALPHA, D3DBLEND.ONE);
      this.drawRows(positions, u, v, w, h, columns, rows, colors);
      d.setRenderState(D3DRS.SRCBLEND, D3DBLEND.SRCALPHA);
      d.setRenderState(D3DRS.DESTBLEND, D3DBLEND.INVSRCALPHA);
      d.setRenderState(D3DRS.SRCBLENDALPHA, D3DBLEND.ONE);
      d.setRenderState(D3DRS.DESTBLENDALPHA, D3DBLEND.INVSRCALPHA);
    }
    this.drawRows(positions, u, v, w, h, columns, rows, colors);
  }

  /** 0x10058270: one `DrawPrimitiveUP(TRIANGLESTRIP, 2·columns)` per grid row. */
  private drawRows(
    positions: Float32Array,
    u: number,
    v: number,
    w: number,
    h: number,
    columns: number,
    rows: number,
    corners: Uint32Array,
  ): void {
    const record = this.currentTexture;
    if (record === null) return;
    const across = columns + 1,
      colors = emoteGridColors(corners, columns, rows),
      du = f(w / u32ToFloat(columns)),
      dv = f(h / u32ToFloat(rows)),
      invW = f(1 / record.width),
      invH = f(1 / record.height),
      us = new Float32Array(across),
      vs = new Float32Array(rows + 1);
    for (let i = 0; i < across; i++) us[i] = f((u32ToFloat(i) * du + u) * invW);
    for (let j = 0; j <= rows; j++) vs[j] = f((u32ToFloat(j) * dv + v) * invH);
    for (let row = 0; row < rows; row++) {
      const bytes = new Uint8Array(across * 2 * EMOTE_VERTEX_STRIDE),
        view = new DataView(bytes.buffer);
      let at = 0;
      const put = (index: number, tv: number, tu: number): void => {
        view.setFloat32(at, positions[index * 2]!, true);
        view.setFloat32(at + 4, positions[index * 2 + 1]!, true);
        view.setFloat32(at + 8, 0, true);
        view.setUint32(at + 12, colors[index]!, true);
        view.setFloat32(at + 16, tu, true);
        view.setFloat32(at + 20, tv, true);
        at += EMOTE_VERTEX_STRIDE;
      };
      for (let i = 0; i < across; i++) {
        put(row * across + i, vs[row]!, us[i]!);
        put((row + 1) * across + i, vs[row + 1]!, us[i]!);
      }
      this.device.drawPrimitiveUP(D3DPT_TRIANGLESTRIP, across * 2 - 2, bytes, EMOTE_VERTEX_STRIDE);
    }
  }

  /** 0x10057f50: pixelate target of `pixelateDivision` × proportional height. */
  private preparePixelateTarget(): boolean {
    if (this.shaderLevel() === 0) return false;
    const division = this.pixelateDivision | 0,
      height = Math.floor((Math.imul(this.viewport.height, division) >>> 0) / this.viewport.width);
    if (this.pixelateTarget !== null) {
      if (division === this.pixelateSize[0] && height === this.pixelateSize[1]) {
        this.updatePixelateConstants();
        return true;
      }
      this.pixelateTarget.release();
      this.pixelateTarget = null;
    }
    this.pixelateSize = [division, height];
    const caps = this.textureCaps & 0x102;
    this.pixelateTextureSize =
      caps === 0 || caps === 0x102 ? [division, height] : [ceilPow2(division), ceilPow2(height)];
    this.pixelateTarget = this.device.createTexture(
      this.pixelateTextureSize[0],
      this.pixelateTextureSize[1],
      1,
      D3DUSAGE_RENDERTARGET,
      D3DFMT_A8R8G8B8,
      D3DPOOL_DEFAULT,
    ).value;
    this.updatePixelateConstants();
    return this.pixelateTarget !== null;
  }

  private updatePixelateConstants(): void {
    const [w, h] = this.pixelateSize,
      [tw, th] = this.pixelateTextureSize;
    this.pixelateVertexConstant[0] = f(0.5 / f(w | 0) + 0.5);
    this.pixelateVertexConstant[1] = f(0.5 / f(h | 0) + 0.5);
    const sx = f(f(w | 0) / f(tw | 0)),
      sy = f(f(h | 0) / f(th | 0));
    this.pixelateVertexConstant[2] = sx;
    this.pixelateVertexConstant[3] = sy;
    this.pixelatePixelConstant[0] = f(sx / u32ToFloat(this.viewport.width));
    this.pixelatePixelConstant[1] = f(sy / u32ToFloat(this.viewport.height));
  }

  /** 0x10057880: copies the pixelate source into the reduced target with point sampling. */
  pixelateCopy(): void {
    if (this.pixelateSource === null || !this.preparePixelateTarget()) return;
    const d = this.device;
    this.setBlend(0);
    this.savedTarget = d.getRenderTarget(0).value;
    const surface = this.pixelateTarget!.getSurfaceLevel(0).value;
    d.setRenderTarget(0, surface);
    surface?.release();
    const [w, h] = this.pixelateSize;
    d.setViewport({x: 0, y: 0, width: w, height: h, minZ: 0, maxZ: 1});
    d.clear(null, D3DCLEAR_TARGET, 0, 1, 0);
    const aspect = f(f(w | 0) / (h | 0));
    const projection = Float32Array.of(f(1 / aspect), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0);
    const view = d3dxMatrixLookAtLH([-0.5, 0.5, f((-h | 0) * 0.5)], [-0.5, 0.5, 0], [0, -1, 0]);
    view[0] = -view[0]!;
    const identity = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    const matrix = d3dxMatrixTranspose(
      d3dxMatrixMultiply(d3dxMatrixMultiply(identity, view), projection),
    );
    d.setVertexShaderConstantF(0, matrix, 4);
    const savedFilter = d.getSamplerState(0, D3DSAMP.MAGFILTER).value ?? 0;
    d.setSamplerState(0, D3DSAMP.MAGFILTER, D3DTEXF_POINT);
    d.setSamplerState(0, D3DSAMP.MINFILTER, D3DTEXF_POINT);
    const x0 = f(-(w | 0) * 0.5),
      y0 = f(-(h | 0) * 0.5),
      x1 = f((w | 0) * 0.5),
      y1 = f(0.5 * (h | 0)),
      vp = this.viewport,
      sw = u32ToFloat(this.targetWidth),
      sh = u32ToFloat(this.targetHeight),
      u0 = f(u32ToFloat(vp.x) / sw),
      v0 = f(u32ToFloat(vp.y) / sh),
      u1 = f(u32ToFloat(vp.x + vp.width) / sw),
      v1 = f(u32ToFloat(vp.y + vp.height) / sh);
    const bytes = new Uint8Array(4 * EMOTE_VERTEX_STRIDE),
      dv = new DataView(bytes.buffer);
    [
      [x0, y0, u0, v0],
      [x1, y0, u1, v0],
      [x0, y1, u0, v1],
      [x1, y1, u1, v1],
    ].forEach(([x, y, tu, tv], i) => {
      const at = i * EMOTE_VERTEX_STRIDE;
      dv.setFloat32(at, x!, true);
      dv.setFloat32(at + 4, y!, true);
      dv.setFloat32(at + 8, 0, true);
      dv.setUint32(at + 12, 0xffffffff, true);
      dv.setFloat32(at + 16, tu!, true);
      dv.setFloat32(at + 20, tv!, true);
    });
    d.setTexture(0, this.pixelateSource);
    d.drawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, bytes, EMOTE_VERTEX_STRIDE);
    d.setTexture(0, null);
    d.setRenderTarget(0, this.savedTarget);
    this.savedTarget?.release();
    const c = this.clipRect;
    this.setClipRect(c[0], c[1], c[2], c[3]);
    d.setViewport(this.viewport);
    d.setVertexShaderConstantF(0, this.shaderMatrix(), 4);
    d.setSamplerState(0, D3DSAMP.MAGFILTER, savedFilter);
    d.setSamplerState(0, D3DSAMP.MINFILTER, savedFilter);
  }

  /** 0x10057ed0: binds the pixelate target for blend-mode-6 items. */
  bindPixelate(mode: number): void {
    if (this.pixelateSource === null || this.pixelateTarget === null || mode !== 6) return;
    const d = this.device;
    d.setTexture(1, this.pixelateTarget);
    d.setSamplerState(1, D3DSAMP.MAGFILTER, D3DTEXF_POINT);
    d.setSamplerState(1, D3DSAMP.MINFILTER, D3DTEXF_POINT);
    this.setVertexShader(2);
    this.setPixelShader(26, false);
  }

  /** True when pixelate items left stage 1 bound (end of 0x10003f70). */
  get pixelateBound(): boolean {
    return this.pixelateSource !== null && this.pixelateTarget !== null;
  }

  /** 0x100559e0. */
  onDeviceLost(): void {
    this.lost = true;
    for (let i = 0; i < 2; i++) {
      this.maskTargets[i]?.release();
      this.maskTargets[i] = null;
    }
    this.pixelateTarget?.release();
    this.pixelateTarget = null;
  }

  /** 0x10055890 (dtor 0x10055470). */
  destroy(): void {
    this.pixelateTarget?.release();
    this.pixelateTarget = null;
    for (let i = 0; i < 2; i++) {
      this.maskTargets[i]?.release();
      this.maskTargets[i] = null;
    }
    for (const cache of [this.vertexSm2, this.pixelSm2, this.vertexSm3, this.pixelSm3])
      for (let i = 0; i < cache.length; i++) {
        cache[i]?.release();
        cache[i] = null;
      }
  }
}

/** Largest power of two ≤ `v` (0x100563f0 rounds the next power down unless exact). */
function floorPow2(v: number): number {
  const next = ceilPow2(v);
  return next === v >>> 0 ? next : next >>> 1;
}

/** Smallest power of two ≥ `v`, with the native 32-bit bit-smearing. */
function ceilPow2(v: number): number {
  let x = (v - 1) >>> 0;
  x = (x | (x >>> 1)) >>> 0;
  x = (x | (x >>> 2)) >>> 0;
  x = (x | (x >>> 4)) >>> 0;
  x = (x | (x >>> 8)) >>> 0;
  x = (x | (x >>> 16)) >>> 0;
  return (x + 1) >>> 0;
}

export {FLT_MAX as EMOTE_FLT_MAX};
