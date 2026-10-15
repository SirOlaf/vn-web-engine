# d3d9.dll

`contract.ts` is the export surface (`D3D9`: `direct3DCreate9`) and the COM interfaces
clients use. `library.ts` registers the WebGL2 implementation in `webgl2/` for the system
identity `d3d9.dll`.

## Creating a device

The runtime wiring probes the context it will present to with `describeWebGl2Adapter(gl)` and
registers `d3d9WebGl2Library(adapter)`, so `IDirect3D9.checkDeviceFormat` answers before any
device exists. The compositor (the library that owns the canvas, e.g. `drawdeviceD3DZ.dll`)
calls `direct3DCreate9(D3D_SDK_VERSION)` and then `createDevice(adapter, D3DDEVTYPE_HAL,
window, flags, presentation)`. `window` is a `D3dDeviceWindow`: the WebGL2 context (created
with `depth` and `stencil` when `enableAutoDepthStencil` is set), a back-buffer resize hook
and the display mode. The device owns the context's GL state from then on; it shares that
state with every library it is handed to, as a Direct3D 9 device does.

## Implementation (`webgl2/`)

| File                | Contents                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| `direct3d.ts`       | `IDirect3D9`: `checkDeviceFormat`, `createDevice`                            |
| `device.ts`         | `IDirect3DDevice9`; state application, draws, clears, loss and `reset`       |
| `state.ts`          | Render/stage/sampler state enumerations, D3D9 defaults, D3D→GL mappings      |
| `fvf.ts`            | FVF → vertex declaration (usage, offset, type); D3DCOLOR BGRA→RGBA copy      |
| `formats.ts`        | Texture formats: lock layout, GL storage, conversion at unlock               |
| `textures.ts`       | `IDirect3DTexture9`, `IDirect3DSurface9`, render-target framebuffers         |
| `shaders.ts`        | Shader objects, program sources for any VS/PS (or fixed-function) pairing    |
| `fixed-function.ts` | GLSL for the fixed-function vertex stage, texture-stage combiner, alpha test |
| `gl-state.ts`       | Redundant-call cache in front of the context                                 |

Behaviour:

- **State** is stored as set (`get*` returns it or the D3D9 default) and applied to GL at
  draw/clear time through `GlStateCache`. `SetRenderTarget(0)` resets viewport and scissor
  rect to the target, as Direct3D 9 does.
- **Coordinates.** The back buffer is the default framebuffer; render-target textures are
  framebuffers whose GL row 0 is D3D row 0, so drawing into them flips clip-space y
  (`dx_posFixup`) and `frontFace` (CW for the back buffer, CCW for textures) so D3D's
  clockwise-front culling holds. Pixel centres are shifted by 63/128 pixel rather than 1/2
  (as Wine does): edges lying exactly on pixel centres then follow D3D's top-left fill rule
  regardless of the GL implementation's tie rule.
- **Clear** clears the viewport (or the given rects ∩ viewport), intersected with the scissor
  rect when the scissor test is on, and ignores colour, depth and stencil write masks.
- **Draws** (`DrawPrimitiveUP`) copy the vertices into a stream buffer, swapping D3DCOLOR
  bytes to RGBA; attributes bind to FVF elements by declaration usage, for both the
  fixed-function vertex stage and vertex shaders (`a_<usage><n>`).
- **Shaders** are parsed and translated at creation (unsupported bytecode fails there); VS/PS
  pairs, and pairs with a fixed-function half, link on first draw and are cached by shader
  ids and fixed-function state. Float constants upload when changed. The alpha test is
  compiled into every fragment shader (8-bit alpha against `ALPHAREF`).
- **Fixed function**: WORLD·VIEW·PROJECTION or XYZRHW screen positions; lighting with no
  lights (no `SetLight`/`SetMaterial` exist): emissive + ambient terms by material source;
  all `D3DTOP` combiner operations except PREMODULATE and bump mapping, all `D3DTA`
  arguments and modifiers, RESULTARG TEMP, SPECULARENABLE.
- **Textures**: lockable textures keep a D3D-layout system-memory copy that `LockRect`
  exposes and `UnlockRect` converts and uploads (ARGB byte swizzle, 16-bit repacking, X
  formats forced opaque). DXT levels upload compressed with `WEBGL_compressed_texture_s3tc`,
  otherwise decoded to RGBA8. X8R8G8B8 render targets are RGB8, so destination alpha reads 1.
  Sampler states map to WebGL2 sampler objects.
- **Depth-stencil**: the back buffer uses the context's depth/stencil buffer; offscreen
  targets no larger than the back buffer share one DEPTH24_STENCIL8 renderbuffer.
- **Loss**: `webglcontextlost` makes `testCooperativeLevel` return `D3DERR_DEVICELOST`, then
  `D3DERR_DEVICENOTRESET` once restored. `reset` fails while default-pool resources live,
  recreates GL objects, re-uploads managed textures and restores state defaults.

Differences from Direct3D 9: the back buffer's depth-stencil contents are not visible to
offscreen targets (and vice versa); BORDER and MIRRORONCE addressing become CLAMP and
MIRROR; MIPMAPLODBIAS, fill modes, shade mode, fog, clip planes, point sprites and vertex
blending are stored but not applied; one render target (`NumSimultaneousRTs` 1); a texture
argument on a stage with no texture reads (1, 1, 1, 1).

`tools/probe-d3d9-webgl2.mjs` draws synthetic content in headless Chromium and checks
read-back pixels (half-pixel coverage, orientation, blending, alpha test, stencil masks,
formats, combiners, translated shaders). `tests/d3d9-webgl2.test.mjs` checks the GL calls
against a recording context.
