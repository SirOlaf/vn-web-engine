import {defineNativeContract} from '../../platform/native-libraries.js';

/**
 * `d3d9.dll` interfaces used by client libraries. Members keep their COM slot numbers; the
 * set grows as clients are lifted. A device is shared by every library that receives it
 * (the compositor that created it and the runtimes it hands it to), so all of them draw
 * into one context and see each other's state, as on Direct3D 9.
 *
 * Results that carry an out-parameter are records with the HRESULT. Matrices are 16
 * floats, row-major as `D3DMATRIX`. Byte data crosses the contract as `Uint8Array`.
 */

/** HRESULT values. */
export const D3D_OK = 0;
export const D3DERR_DEVICELOST = 0x88760868 | 0;
export const D3DERR_DEVICENOTRESET = 0x88760869 | 0;
export const D3DERR_INVALIDCALL = 0x8876086c | 0;
export const D3DERR_NOTAVAILABLE = 0x8876086a | 0;
export const E_OUTOFMEMORY = 0x8007000e | 0;
export const D3DERR_NOTFOUND = 0x88760866 | 0;

/** `D3DFORMAT` values used by clients. */
export const D3DFMT_A8R8G8B8 = 21;
export const D3DFMT_X8R8G8B8 = 22;
export const D3DFMT_R5G6B5 = 23;
export const D3DFMT_A1R5G5B5 = 25;
export const D3DFMT_A4R4G4B4 = 26;
export const D3DFMT_A8 = 28;
export const D3DFMT_L8 = 50;
export const D3DFMT_A8L8 = 51;
export const D3DFMT_DXT1 = 0x31545844;
export const D3DFMT_DXT3 = 0x33545844;
export const D3DFMT_DXT5 = 0x35545844;
export const D3DFMT_D24S8 = 75;

export const D3DPOOL_DEFAULT = 0;
export const D3DPOOL_MANAGED = 1;
export const D3DUSAGE_RENDERTARGET = 1;
export const D3DUSAGE_DYNAMIC = 0x200;

/** `D3DLOCK_*` flags. */
export const D3DLOCK_READONLY = 0x10;
export const D3DLOCK_DISCARD = 0x2000;
export const D3DLOCK_NO_DIRTY_UPDATE = 0x8000;

export const D3DDEVTYPE_HAL = 1;
export const D3DDEVTYPE_REF = 2;
export const D3DADAPTER_DEFAULT = 0;
/** `D3D_SDK_VERSION` of the Direct3D 9 headers (31 for the pre-9.0c SDK). */
export const D3D_SDK_VERSION = 32;

/** `D3DCREATE_*` behaviour flags. */
export const D3DCREATE_FPU_PRESERVE = 0x2;
export const D3DCREATE_MULTITHREADED = 0x4;
export const D3DCREATE_SOFTWARE_VERTEXPROCESSING = 0x20;
export const D3DCREATE_HARDWARE_VERTEXPROCESSING = 0x40;
export const D3DCREATE_MIXED_VERTEXPROCESSING = 0x80;

export const D3DSWAPEFFECT_DISCARD = 1;
export const D3DSWAPEFFECT_FLIP = 2;
export const D3DSWAPEFFECT_COPY = 3;
export const D3DRTYPE_TEXTURE = 3;

/** `D3DTRANSFORMSTATETYPE`. */
export const D3DTS_VIEW = 2;
export const D3DTS_PROJECTION = 3;
export const D3DTS_WORLD = 256;

/** `D3DCLEAR` flags. */
export const D3DCLEAR_TARGET = 1;
export const D3DCLEAR_ZBUFFER = 2;
export const D3DCLEAR_STENCIL = 4;

export const D3DPT_TRIANGLELIST = 4;
export const D3DPT_TRIANGLESTRIP = 5;

/** FVF bits. */
export const D3DFVF_XYZ = 0x002;
export const D3DFVF_XYZRHW = 0x004;
export const D3DFVF_DIFFUSE = 0x040;
export const D3DFVF_TEX1 = 0x100;

/** `D3DRENDERSTATETYPE` values used by clients. */
export const D3DRS = {
  ZENABLE: 7,
  ZWRITEENABLE: 14,
  ALPHATESTENABLE: 15,
  SRCBLEND: 19,
  DESTBLEND: 20,
  CULLMODE: 22,
  ZFUNC: 23,
  ALPHAREF: 24,
  ALPHAFUNC: 25,
  ALPHABLENDENABLE: 27,
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
  LIGHTING: 137,
  COLORWRITEENABLE: 168,
  BLENDOP: 171,
  SCISSORTESTENABLE: 174,
  SEPARATEALPHABLENDENABLE: 206,
  SRCBLENDALPHA: 207,
  DESTBLENDALPHA: 208,
  BLENDOPALPHA: 209,
} as const;

/** `D3DBLEND`. */
export const D3DBLEND = {
  ZERO: 1,
  ONE: 2,
  SRCCOLOR: 3,
  INVSRCCOLOR: 4,
  SRCALPHA: 5,
  INVSRCALPHA: 6,
  DESTALPHA: 7,
  INVDESTALPHA: 8,
  DESTCOLOR: 9,
  INVDESTCOLOR: 10,
  SRCALPHASAT: 11,
} as const;

/** `D3DBLENDOP`. */
export const D3DBLENDOP = {ADD: 1, SUBTRACT: 2, REVSUBTRACT: 3, MIN: 4, MAX: 5} as const;

/** `D3DCMPFUNC`. */
export const D3DCMP = {
  NEVER: 1,
  LESS: 2,
  EQUAL: 3,
  LESSEQUAL: 4,
  GREATER: 5,
  NOTEQUAL: 6,
  GREATEREQUAL: 7,
  ALWAYS: 8,
} as const;

/** `D3DSTENCILOP`. */
export const D3DSTENCILOP = {
  KEEP: 1,
  ZERO: 2,
  REPLACE: 3,
  INCRSAT: 4,
  DECRSAT: 5,
  INVERT: 6,
  INCR: 7,
  DECR: 8,
} as const;

export const D3DCULL_NONE = 1;

/** `D3DTEXTURESTAGESTATETYPE`. */
export const D3DTSS = {
  COLOROP: 1,
  COLORARG1: 2,
  COLORARG2: 3,
  ALPHAOP: 4,
  ALPHAARG1: 5,
  ALPHAARG2: 6,
} as const;

/** `D3DTEXTUREOP` values used by clients. */
export const D3DTOP = {
  DISABLE: 1,
  SELECTARG1: 2,
  SELECTARG2: 3,
  MODULATE: 4,
  MODULATE2X: 5,
  ADD: 7,
} as const;

/** `D3DTA` argument selectors and modifiers. */
export const D3DTA = {
  DIFFUSE: 0,
  CURRENT: 1,
  TEXTURE: 2,
  TFACTOR: 3,
  COMPLEMENT: 0x10,
  ALPHAREPLICATE: 0x20,
} as const;

/** `D3DSAMPLERSTATETYPE`. */
export const D3DSAMP = {
  ADDRESSU: 1,
  ADDRESSV: 2,
  MAGFILTER: 5,
  MINFILTER: 6,
  MIPFILTER: 7,
} as const;

export const D3DTADDRESS_WRAP = 1;
export const D3DTADDRESS_CLAMP = 3;
export const D3DTEXF_NONE = 0;
export const D3DTEXF_POINT = 1;
export const D3DTEXF_LINEAR = 2;

/** `D3DVIEWPORT9`. */
export interface D3dViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** `RECT`. */
export interface D3dRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The `D3DCAPS9` fields clients read. Versions use the `D3DVS_VERSION`/`D3DPS_VERSION` encoding. */
export interface D3dCaps {
  readonly maxTextureWidth: number;
  readonly maxTextureHeight: number;
  /** `D3DPTEXTURECAPS_*` bits. */
  readonly textureCaps: number;
  readonly vertexShaderVersion: number;
  readonly pixelShaderVersion: number;
}

export const D3DPTEXTURECAPS_MIPMAP = 0x4000;

/** `D3DDISPLAYMODE`. */
export interface D3dDisplayMode {
  readonly width: number;
  readonly height: number;
  readonly refreshRate: number;
  readonly format: number;
}

/** `D3DSURFACE_DESC` fields clients read. */
export interface D3dSurfaceDesc {
  readonly format: number;
  readonly usage: number;
  readonly pool: number;
  readonly width: number;
  readonly height: number;
}

export interface D3dResult<T> {
  readonly hr: number;
  readonly value: T | null;
}

/**
 * `D3DLOCKED_RECT`. `bits` is a view of `pitch × rows` bytes for the level; writes become
 * the texture contents at `unlockRect`.
 */
export interface D3dLockedRect {
  readonly pitch: number;
  readonly bits: Uint8Array;
}

interface IUnknown {
  /** Slot 1. */
  addRef(): number;
  /** Slot 2. */
  release(): number;
}

/**
 * `D3DPRESENT_PARAMETERS` without the window handle, which `createDevice` receives as a
 * `D3dDeviceWindow`. A zero width or height in windowed mode takes the window's size.
 */
export interface D3dPresentParameters {
  readonly backBufferWidth: number;
  readonly backBufferHeight: number;
  readonly backBufferFormat: number;
  readonly backBufferCount: number;
  readonly multiSampleType: number;
  readonly multiSampleQuality: number;
  readonly swapEffect: number;
  readonly windowed: boolean;
  readonly enableAutoDepthStencil: boolean;
  readonly autoDepthStencilFormat: number;
  readonly flags: number;
  readonly fullScreenRefreshRateInHz: number;
  readonly presentationInterval: number;
}

/**
 * The window a device presents to (`hFocusWindow` and the device window). On the web it is
 * a WebGL2 context whose default framebuffer is the back buffer. The library that owns the
 * canvas (the compositor) implements it and passes it to `IDirect3D9.createDevice`; the device
 * then owns the context's GL state.
 *
 * This is the one host object that crosses the d3d9 contract. A Wasm-backed implementation
 * keeps it on the JavaScript side of its boundary and refers to it by handle.
 */
export interface D3dDeviceWindow {
  /**
   * The context. It is created with `depth: true, stencil: true` when the presentation asks
   * for an automatic depth-stencil surface.
   */
  readonly context: WebGL2RenderingContext;
  /** Sizes the back buffer (the drawing buffer) to the presentation size. */
  setBackBufferSize(width: number, height: number): void;
  /** The adapter's display mode: the desktop mode for a windowed device. */
  displayMode(): D3dDisplayMode;
}

/** `IDirect3D9`. */
export interface IDirect3D9 extends IUnknown {
  /** Slot 10. */
  checkDeviceFormat(
    adapter: number,
    deviceType: number,
    adapterFormat: number,
    usage: number,
    resourceType: number,
    checkFormat: number,
  ): number;
  /**
   * Slot 16. `window` stands for `hFocusWindow` and `presentation.hDeviceWindow`. The device
   * holds a reference to this `IDirect3D9`.
   */
  createDevice(
    adapter: number,
    deviceType: number,
    window: D3dDeviceWindow,
    behaviorFlags: number,
    presentation: D3dPresentParameters,
  ): D3dResult<IDirect3DDevice9>;
}

/** `IDirect3DSurface9`. */
export interface IDirect3DSurface9 extends IUnknown {
  /** Slot 12. */
  getDesc(): D3dSurfaceDesc;
}

/** `IDirect3DTexture9`. */
export interface IDirect3DTexture9 extends IUnknown {
  /** Slot 17. */
  getLevelDesc(level: number): D3dResult<D3dSurfaceDesc>;
  /** Slot 18. */
  getSurfaceLevel(level: number): D3dResult<IDirect3DSurface9>;
  /** Slot 19. A null `rect` locks the whole level. Flags are `D3DLOCK_*`. */
  lockRect(level: number, rect: D3dRect | null, flags: number): D3dResult<D3dLockedRect>;
  /** Slot 20. */
  unlockRect(level: number): number;
}

export type IDirect3DVertexShader9 = IUnknown;
export type IDirect3DPixelShader9 = IUnknown;

/** `IDirect3DDevice9`. */
export interface IDirect3DDevice9 extends IUnknown {
  /** Slot 3. `D3D_OK`, `D3DERR_DEVICELOST` or `D3DERR_DEVICENOTRESET`. */
  testCooperativeLevel(): number;
  /** Slot 6. */
  getDirect3D(): D3dResult<IDirect3D9>;
  /** Slot 7. */
  getDeviceCaps(): D3dResult<D3dCaps>;
  /** Slot 8. */
  getDisplayMode(swapChain: number): D3dResult<D3dDisplayMode>;
  /**
   * Slot 16. Restores a lost device, or changes the presentation. Every `D3DPOOL_DEFAULT`
   * resource must be released first. All states return to their defaults.
   */
  reset(presentation: D3dPresentParameters): number;
  /** Slot 23. */
  createTexture(
    width: number,
    height: number,
    levels: number,
    usage: number,
    format: number,
    pool: number,
  ): D3dResult<IDirect3DTexture9>;
  /** Slot 37. */
  setRenderTarget(index: number, surface: IDirect3DSurface9 | null): number;
  /** Slot 38. The caller releases the returned surface. */
  getRenderTarget(index: number): D3dResult<IDirect3DSurface9>;
  /** Slot 43. A null `rects` clears the viewport. */
  clear(
    rects: readonly D3dRect[] | null,
    flags: number,
    color: number,
    z: number,
    stencil: number,
  ): number;
  /** Slot 44. */
  setTransform(state: number, matrix: Float32Array): number;
  /** Slot 45. */
  getTransform(state: number): D3dResult<Float32Array>;
  /** Slot 47. */
  setViewport(viewport: D3dViewport): number;
  /** Slot 48. */
  getViewport(): D3dResult<D3dViewport>;
  /** Slot 57. */
  setRenderState(state: number, value: number): number;
  /** Slot 58. */
  getRenderState(state: number): D3dResult<number>;
  /** Slot 64. The caller releases the returned texture. */
  getTexture(stage: number): D3dResult<IDirect3DTexture9>;
  /** Slot 65. */
  setTexture(stage: number, texture: IDirect3DTexture9 | null): number;
  /** Slot 66. */
  getTextureStageState(stage: number, type: number): D3dResult<number>;
  /** Slot 67. */
  setTextureStageState(stage: number, type: number, value: number): number;
  /** Slot 68. */
  getSamplerState(sampler: number, type: number): D3dResult<number>;
  /** Slot 69. */
  setSamplerState(sampler: number, type: number, value: number): number;
  /** Slot 75. */
  setScissorRect(rect: D3dRect): number;
  /** Slot 76. */
  getScissorRect(): D3dResult<D3dRect>;
  /**
   * Slot 83. `vertices` holds the vertex stream bytes (little-endian, as laid out for the
   * current FVF or shader inputs); the device reads `primitiveCount` primitives from it.
   */
  drawPrimitiveUP(
    primitiveType: number,
    primitiveCount: number,
    vertices: Uint8Array,
    stride: number,
  ): number;
  /** Slot 89. */
  setFVF(fvf: number): number;
  /** Slot 90. */
  getFVF(): D3dResult<number>;
  /** Slot 91. `bytecode` is a compiled `vs_*` token stream. */
  createVertexShader(bytecode: Uint8Array): D3dResult<IDirect3DVertexShader9>;
  /** Slot 92. */
  setVertexShader(shader: IDirect3DVertexShader9 | null): number;
  /** Slot 93. The caller releases the returned shader. */
  getVertexShader(): D3dResult<IDirect3DVertexShader9>;
  /** Slot 94. `data` holds `count` float4 registers. */
  setVertexShaderConstantF(register: number, data: Float32Array, count: number): number;
  /** Slot 95. */
  getVertexShaderConstantF(register: number, count: number): D3dResult<Float32Array>;
  /** Slot 106. `bytecode` is a compiled `ps_*` token stream. */
  createPixelShader(bytecode: Uint8Array): D3dResult<IDirect3DPixelShader9>;
  /** Slot 107. */
  setPixelShader(shader: IDirect3DPixelShader9 | null): number;
  /** Slot 108. The caller releases the returned shader. */
  getPixelShader(): D3dResult<IDirect3DPixelShader9>;
  /** Slot 109. */
  setPixelShaderConstantF(register: number, data: Float32Array, count: number): number;
}

/** `d3d9.dll` exports. */
export interface D3d9Exports {
  /** `Direct3DCreate9`. Null when `sdkVersion` is not one this runtime accepts. */
  direct3DCreate9(sdkVersion: number): IDirect3D9 | null;
}

export const D3D9 = defineNativeContract<D3d9Exports>('d3d9.dll', '1');
