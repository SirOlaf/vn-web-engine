import {GL} from './gl.js';

/**
 * Direct3D 9 state stores (render, texture-stage and sampler states, transforms) with the
 * runtime's documented defaults, and the pure mappings from D3D9 enumerations to WebGL2.
 */

/** `D3DRENDERSTATETYPE` (complete Direct3D 9 set). */
export const RS = {
  ZENABLE: 7,
  FILLMODE: 8,
  SHADEMODE: 9,
  ZWRITEENABLE: 14,
  ALPHATESTENABLE: 15,
  LASTPIXEL: 16,
  SRCBLEND: 19,
  DESTBLEND: 20,
  CULLMODE: 22,
  ZFUNC: 23,
  ALPHAREF: 24,
  ALPHAFUNC: 25,
  DITHERENABLE: 26,
  ALPHABLENDENABLE: 27,
  FOGENABLE: 28,
  SPECULARENABLE: 29,
  FOGCOLOR: 34,
  FOGTABLEMODE: 35,
  FOGSTART: 36,
  FOGEND: 37,
  FOGDENSITY: 38,
  RANGEFOGENABLE: 48,
  STENCILENABLE: 52,
  STENCILFAIL: 53,
  STENCILZFAIL: 54,
  STENCILPASS: 55,
  STENCILFUNC: 56,
  STENCILREF: 57,
  STENCILMASK: 58,
  STENCILWRITEMASK: 59,
  TEXTUREFACTOR: 60,
  WRAP0: 128,
  CLIPPING: 136,
  LIGHTING: 137,
  AMBIENT: 139,
  FOGVERTEXMODE: 140,
  COLORVERTEX: 141,
  LOCALVIEWER: 142,
  NORMALIZENORMALS: 143,
  DIFFUSEMATERIALSOURCE: 145,
  SPECULARMATERIALSOURCE: 146,
  AMBIENTMATERIALSOURCE: 147,
  EMISSIVEMATERIALSOURCE: 148,
  VERTEXBLEND: 151,
  CLIPPLANEENABLE: 152,
  POINTSIZE: 154,
  POINTSIZE_MIN: 155,
  POINTSPRITEENABLE: 156,
  POINTSCALEENABLE: 157,
  POINTSCALE_A: 158,
  POINTSCALE_B: 159,
  POINTSCALE_C: 160,
  MULTISAMPLEANTIALIAS: 161,
  MULTISAMPLEMASK: 162,
  PATCHEDGESTYLE: 163,
  DEBUGMONITORTOKEN: 165,
  POINTSIZE_MAX: 166,
  INDEXEDVERTEXBLENDENABLE: 167,
  COLORWRITEENABLE: 168,
  TWEENFACTOR: 170,
  BLENDOP: 171,
  POSITIONDEGREE: 172,
  NORMALDEGREE: 173,
  SCISSORTESTENABLE: 174,
  SLOPESCALEDEPTHBIAS: 175,
  ANTIALIASEDLINEENABLE: 176,
  MINTESSELLATIONLEVEL: 178,
  MAXTESSELLATIONLEVEL: 179,
  ADAPTIVETESS_X: 180,
  ADAPTIVETESS_Y: 181,
  ADAPTIVETESS_Z: 182,
  ADAPTIVETESS_W: 183,
  ENABLEADAPTIVETESSELLATION: 184,
  TWOSIDEDSTENCILMODE: 185,
  CCW_STENCILFAIL: 186,
  CCW_STENCILZFAIL: 187,
  CCW_STENCILPASS: 188,
  CCW_STENCILFUNC: 189,
  COLORWRITEENABLE1: 190,
  COLORWRITEENABLE2: 191,
  COLORWRITEENABLE3: 192,
  BLENDFACTOR: 193,
  SRGBWRITEENABLE: 194,
  DEPTHBIAS: 195,
  WRAP8: 198,
  SEPARATEALPHABLENDENABLE: 206,
  SRCBLENDALPHA: 207,
  DESTBLENDALPHA: 208,
  BLENDOPALPHA: 209,
} as const;

/** `D3DTEXTURESTAGESTATETYPE`. */
export const TSS = {
  COLOROP: 1,
  COLORARG1: 2,
  COLORARG2: 3,
  ALPHAOP: 4,
  ALPHAARG1: 5,
  ALPHAARG2: 6,
  BUMPENVMAT00: 7,
  BUMPENVMAT01: 8,
  BUMPENVMAT10: 9,
  BUMPENVMAT11: 10,
  TEXCOORDINDEX: 11,
  BUMPENVLSCALE: 22,
  BUMPENVLOFFSET: 23,
  TEXTURETRANSFORMFLAGS: 24,
  COLORARG0: 26,
  ALPHAARG0: 27,
  RESULTARG: 28,
  CONSTANT: 32,
} as const;

/** `D3DSAMPLERSTATETYPE`. */
export const SAMP = {
  ADDRESSU: 1,
  ADDRESSV: 2,
  ADDRESSW: 3,
  BORDERCOLOR: 4,
  MAGFILTER: 5,
  MINFILTER: 6,
  MIPFILTER: 7,
  MIPMAPLODBIAS: 8,
  MAXMIPLEVEL: 9,
  MAXANISOTROPY: 10,
  SRGBTEXTURE: 11,
  ELEMENTINDEX: 12,
  DMAPOFFSET: 13,
} as const;

/** `D3DTEXTUREOP`. */
export const TOP = {
  DISABLE: 1,
  SELECTARG1: 2,
  SELECTARG2: 3,
  MODULATE: 4,
  MODULATE2X: 5,
  MODULATE4X: 6,
  ADD: 7,
  ADDSIGNED: 8,
  ADDSIGNED2X: 9,
  SUBTRACT: 10,
  ADDSMOOTH: 11,
  BLENDDIFFUSEALPHA: 12,
  BLENDTEXTUREALPHA: 13,
  BLENDFACTORALPHA: 14,
  BLENDTEXTUREALPHAPM: 15,
  BLENDCURRENTALPHA: 16,
  PREMODULATE: 17,
  MODULATEALPHA_ADDCOLOR: 18,
  MODULATECOLOR_ADDALPHA: 19,
  MODULATEINVALPHA_ADDCOLOR: 20,
  MODULATEINVCOLOR_ADDALPHA: 21,
  BUMPENVMAP: 22,
  BUMPENVMAPLUMINANCE: 23,
  DOTPRODUCT3: 24,
  MULTIPLYADD: 25,
  LERP: 26,
} as const;

/** `D3DTA_*` selectors (low 4 bits) and modifiers. */
export const TA = {
  DIFFUSE: 0,
  CURRENT: 1,
  TEXTURE: 2,
  TFACTOR: 3,
  SPECULAR: 4,
  TEMP: 5,
  CONSTANT: 6,
  SELECTMASK: 0xf,
  COMPLEMENT: 0x10,
  ALPHAREPLICATE: 0x20,
} as const;

/** `D3DTS_*` transform state indices. */
export const TS = {VIEW: 2, PROJECTION: 3, TEXTURE0: 16, WORLD: 256} as const;

/** Device limits reported in the caps (`D3DCAPS9`, shader model 3.0). */
export const MAX_TEXTURE_STAGES = 8;
export const MAX_PIXEL_SAMPLERS = 16;
export const VERTEX_SAMPLER_BASE = 257; // D3DVERTEXTEXTURESAMPLER0
export const MAX_VERTEX_SAMPLERS = 4;
export const VERTEX_SAMPLER_UNIT_BASE = 16;
export const MAX_VS_FLOAT_CONSTANTS = 256;
export const MAX_PS_FLOAT_CONSTANTS = 224;

const f = (value: number): number => new Int32Array(new Float32Array([value]).buffer)[0]!;

/** `float` render-state values are stored as their bit pattern, as `SetRenderState` takes. */
export const floatBits = f;
export function bitsToFloat(bits: number): number {
  return new Float32Array(new Int32Array([bits]).buffer)[0]!;
}

/** Render-state defaults. ZENABLE depends on the automatic depth-stencil surface. */
export function renderStateDefaults(autoDepthStencil: boolean): Map<number, number> {
  const values: [number, number][] = [
    [RS.ZENABLE, autoDepthStencil ? 1 : 0],
    [RS.FILLMODE, 3],
    [RS.SHADEMODE, 2],
    [RS.ZWRITEENABLE, 1],
    [RS.ALPHATESTENABLE, 0],
    [RS.LASTPIXEL, 1],
    [RS.SRCBLEND, 2],
    [RS.DESTBLEND, 1],
    [RS.CULLMODE, 3],
    [RS.ZFUNC, 4],
    [RS.ALPHAREF, 0],
    [RS.ALPHAFUNC, 8],
    [RS.DITHERENABLE, 0],
    [RS.ALPHABLENDENABLE, 0],
    [RS.FOGENABLE, 0],
    [RS.SPECULARENABLE, 0],
    [RS.FOGCOLOR, 0],
    [RS.FOGTABLEMODE, 0],
    [RS.FOGSTART, f(0)],
    [RS.FOGEND, f(1)],
    [RS.FOGDENSITY, f(1)],
    [RS.RANGEFOGENABLE, 0],
    [RS.STENCILENABLE, 0],
    [RS.STENCILFAIL, 1],
    [RS.STENCILZFAIL, 1],
    [RS.STENCILPASS, 1],
    [RS.STENCILFUNC, 8],
    [RS.STENCILREF, 0],
    [RS.STENCILMASK, -1],
    [RS.STENCILWRITEMASK, -1],
    [RS.TEXTUREFACTOR, -1],
    [RS.CLIPPING, 1],
    [RS.LIGHTING, 1],
    [RS.AMBIENT, 0],
    [RS.FOGVERTEXMODE, 0],
    [RS.COLORVERTEX, 1],
    [RS.LOCALVIEWER, 1],
    [RS.NORMALIZENORMALS, 0],
    [RS.DIFFUSEMATERIALSOURCE, 1],
    [RS.SPECULARMATERIALSOURCE, 2],
    [RS.AMBIENTMATERIALSOURCE, 0],
    [RS.EMISSIVEMATERIALSOURCE, 0],
    [RS.VERTEXBLEND, 0],
    [RS.CLIPPLANEENABLE, 0],
    [RS.POINTSIZE, f(1)],
    [RS.POINTSIZE_MIN, f(1)],
    [RS.POINTSPRITEENABLE, 0],
    [RS.POINTSCALEENABLE, 0],
    [RS.POINTSCALE_A, f(1)],
    [RS.POINTSCALE_B, f(0)],
    [RS.POINTSCALE_C, f(0)],
    [RS.MULTISAMPLEANTIALIAS, 1],
    [RS.MULTISAMPLEMASK, -1],
    [RS.PATCHEDGESTYLE, 0],
    [RS.DEBUGMONITORTOKEN, 0],
    [RS.POINTSIZE_MAX, f(64)],
    [RS.INDEXEDVERTEXBLENDENABLE, 0],
    [RS.COLORWRITEENABLE, 0xf],
    [RS.TWEENFACTOR, f(0)],
    [RS.BLENDOP, 1],
    [RS.POSITIONDEGREE, 3],
    [RS.NORMALDEGREE, 1],
    [RS.SCISSORTESTENABLE, 0],
    [RS.SLOPESCALEDEPTHBIAS, 0],
    [RS.ANTIALIASEDLINEENABLE, 0],
    [RS.MINTESSELLATIONLEVEL, f(1)],
    [RS.MAXTESSELLATIONLEVEL, f(1)],
    [RS.ADAPTIVETESS_X, f(0)],
    [RS.ADAPTIVETESS_Y, f(0)],
    [RS.ADAPTIVETESS_Z, f(1)],
    [RS.ADAPTIVETESS_W, f(0)],
    [RS.ENABLEADAPTIVETESSELLATION, 0],
    [RS.TWOSIDEDSTENCILMODE, 0],
    [RS.CCW_STENCILFAIL, 1],
    [RS.CCW_STENCILZFAIL, 1],
    [RS.CCW_STENCILPASS, 1],
    [RS.CCW_STENCILFUNC, 8],
    [RS.COLORWRITEENABLE1, 0xf],
    [RS.COLORWRITEENABLE2, 0xf],
    [RS.COLORWRITEENABLE3, 0xf],
    [RS.BLENDFACTOR, -1],
    [RS.SRGBWRITEENABLE, 0],
    [RS.DEPTHBIAS, 0],
    [RS.SEPARATEALPHABLENDENABLE, 0],
    [RS.SRCBLENDALPHA, 2],
    [RS.DESTBLENDALPHA, 1],
    [RS.BLENDOPALPHA, 1],
  ];
  for (let i = 0; i < 8; i++) values.push([RS.WRAP0 + i, 0], [RS.WRAP8 + i, 0]);
  return new Map(values);
}

/** Texture-stage-state defaults for `stage`. */
export function textureStageDefaults(stage: number): Map<number, number> {
  return new Map([
    [TSS.COLOROP, stage === 0 ? TOP.MODULATE : TOP.DISABLE],
    [TSS.COLORARG1, TA.TEXTURE],
    [TSS.COLORARG2, TA.CURRENT],
    [TSS.ALPHAOP, stage === 0 ? TOP.SELECTARG1 : TOP.DISABLE],
    [TSS.ALPHAARG1, TA.TEXTURE],
    [TSS.ALPHAARG2, TA.CURRENT],
    [TSS.BUMPENVMAT00, f(0)],
    [TSS.BUMPENVMAT01, f(0)],
    [TSS.BUMPENVMAT10, f(0)],
    [TSS.BUMPENVMAT11, f(0)],
    [TSS.TEXCOORDINDEX, stage],
    [TSS.BUMPENVLSCALE, f(0)],
    [TSS.BUMPENVLOFFSET, f(0)],
    [TSS.TEXTURETRANSFORMFLAGS, 0],
    [TSS.COLORARG0, TA.CURRENT],
    [TSS.ALPHAARG0, TA.CURRENT],
    [TSS.RESULTARG, TA.CURRENT],
    [TSS.CONSTANT, 0],
  ]);
}

export function samplerStateDefaults(): Map<number, number> {
  return new Map([
    [SAMP.ADDRESSU, 1],
    [SAMP.ADDRESSV, 1],
    [SAMP.ADDRESSW, 1],
    [SAMP.BORDERCOLOR, 0],
    [SAMP.MAGFILTER, 1],
    [SAMP.MINFILTER, 1],
    [SAMP.MIPFILTER, 0],
    [SAMP.MIPMAPLODBIAS, 0],
    [SAMP.MAXMIPLEVEL, 0],
    [SAMP.MAXANISOTROPY, 1],
    [SAMP.SRGBTEXTURE, 0],
    [SAMP.ELEMENTINDEX, 0],
    [SAMP.DMAPOFFSET, 0],
  ]);
}

/** Valid `D3DTS_*` index: VIEW, PROJECTION, TEXTURE0-7 or WORLDMATRIX(0-255). */
export function isTransformState(state: number): boolean {
  return (
    state === TS.VIEW ||
    state === TS.PROJECTION ||
    (state >= TS.TEXTURE0 && state < TS.TEXTURE0 + 8) ||
    (state >= TS.WORLD && state < TS.WORLD + 256)
  );
}

/** Sampler index → texture unit: pixel samplers 0-15, vertex samplers 257-260 → 16-19. */
export function samplerUnit(sampler: number): number {
  if (sampler >= 0 && sampler < MAX_PIXEL_SAMPLERS) return sampler;
  if (sampler >= VERTEX_SAMPLER_BASE && sampler < VERTEX_SAMPLER_BASE + MAX_VERTEX_SAMPLERS)
    return VERTEX_SAMPLER_UNIT_BASE + sampler - VERTEX_SAMPLER_BASE;
  return -1;
}

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Row-major `D3DMATRIX` product a·b (row vectors: v·a·b). */
export function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k]! * b[k * 4 + c]!;
      out[r * 4 + c] = sum;
    }
  return out;
}

/** `D3DCOLOR` (0xAARRGGBB) → normalized [r, g, b, a]. */
export function d3dColorToRgba(color: number): [number, number, number, number] {
  return [
    ((color >>> 16) & 0xff) / 255,
    ((color >>> 8) & 0xff) / 255,
    (color & 0xff) / 255,
    ((color >>> 24) & 0xff) / 255,
  ];
}

// ---- WebGL2 mappings ----

const blendFactors: Record<number, number> = {
  1: GL.ZERO,
  2: GL.ONE,
  3: GL.SRC_COLOR,
  4: GL.ONE_MINUS_SRC_COLOR,
  5: GL.SRC_ALPHA,
  6: GL.ONE_MINUS_SRC_ALPHA,
  7: GL.DST_ALPHA,
  8: GL.ONE_MINUS_DST_ALPHA,
  9: GL.DST_COLOR,
  10: GL.ONE_MINUS_DST_COLOR,
  11: GL.SRC_ALPHA_SATURATE,
  14: GL.CONSTANT_COLOR,
  15: GL.ONE_MINUS_CONSTANT_COLOR,
};

const D3DBLEND_BOTHSRCALPHA = 12;
const D3DBLEND_BOTHINVSRCALPHA = 13;

/**
 * `D3DBLEND` source/destination pair → GL factors. BOTHSRCALPHA and BOTHINVSRCALPHA as the
 * source set both factors and override the destination, as Direct3D 9 defines them.
 */
export function blendFactorPair(source: number, destination: number): [number, number] {
  if (source === D3DBLEND_BOTHSRCALPHA) return [GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA];
  if (source === D3DBLEND_BOTHINVSRCALPHA) return [GL.ONE_MINUS_SRC_ALPHA, GL.SRC_ALPHA];
  return [blendFactors[source] ?? GL.ONE, blendFactors[destination] ?? GL.ZERO];
}

const blendOps: Record<number, number> = {
  1: GL.FUNC_ADD,
  2: GL.FUNC_SUBTRACT,
  3: GL.FUNC_REVERSE_SUBTRACT,
  4: GL.MIN,
  5: GL.MAX,
};
export function blendEquation(op: number): number {
  return blendOps[op] ?? GL.FUNC_ADD;
}

const compareFuncs = [
  GL.ALWAYS,
  GL.NEVER,
  GL.LESS,
  GL.EQUAL,
  GL.LEQUAL,
  GL.GREATER,
  GL.NOTEQUAL,
  GL.GEQUAL,
  GL.ALWAYS,
];
export function compareFunction(func: number): number {
  return compareFuncs[func] ?? GL.ALWAYS;
}

const stencilOps = [
  GL.KEEP,
  GL.KEEP,
  GL.ZERO,
  GL.REPLACE,
  GL.INCR,
  GL.DECR,
  GL.INVERT,
  GL.INCR_WRAP,
  GL.DECR_WRAP,
];
export function stencilOperation(op: number): number {
  return stencilOps[op] ?? GL.KEEP;
}

/**
 * `D3DTEXTUREADDRESS` → GL wrap. BORDER and MIRRORONCE have no WebGL2 equivalent; they map to
 * CLAMP_TO_EDGE and MIRRORED_REPEAT.
 */
export function addressMode(mode: number): number {
  switch (mode) {
    case 2:
    case 5:
      return GL.MIRRORED_REPEAT;
    case 3:
    case 4:
      return GL.CLAMP_TO_EDGE;
    default:
      return GL.REPEAT;
  }
}

/** `D3DTEXTUREFILTERTYPE` magnification → GL (anything above POINT filters linearly). */
export function magFilter(filter: number): number {
  return filter <= 1 ? GL.NEAREST : GL.LINEAR;
}

/** MINFILTER and MIPFILTER → GL minification filter. */
export function minFilter(filter: number, mipFilter: number): number {
  const linear = filter > 1;
  if (mipFilter === 0) return linear ? GL.LINEAR : GL.NEAREST;
  if (mipFilter === 1) return linear ? GL.LINEAR_MIPMAP_NEAREST : GL.NEAREST_MIPMAP_NEAREST;
  return linear ? GL.LINEAR_MIPMAP_LINEAR : GL.NEAREST_MIPMAP_LINEAR;
}

/** `D3DPRIMITIVETYPE` → GL mode and vertex count, or null for an invalid type. */
export function primitiveLayout(
  type: number,
  count: number,
): {mode: number; vertices: number} | null {
  switch (type) {
    case 1:
      return {mode: GL.POINTS, vertices: count};
    case 2:
      return {mode: GL.LINES, vertices: count * 2};
    case 3:
      return {mode: GL.LINE_STRIP, vertices: count + 1};
    case 4:
      return {mode: GL.TRIANGLES, vertices: count * 3};
    case 5:
      return {mode: GL.TRIANGLE_STRIP, vertices: count + 2};
    case 6:
      return {mode: GL.TRIANGLE_FAN, vertices: count + 2};
    default:
      return null;
  }
}
