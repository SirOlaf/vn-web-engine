# `emotedriver.dll`

TypeScript implementation of the E-mote Direct3D runtime, for build SHA-256
`a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86` (NEKOPARA Vol. 1).
It provides `contract.ts` and is registered with the loader by `library.ts`. Native
addresses in comments refer to that build.

## Layout

| Path                     | Native counterpart                      | Content                                            |
| ------------------------ | --------------------------------------- | -------------------------------------------------- |
| `contract.ts`            | exports, `IEmoteDevice`, `IEmotePlayer` | public surface                                     |
| `library.ts`             | `EmoteCreate`, `EmoteFilterTexture`     | loader registration, player assembly               |
| `filter-texture.ts`      | `EmoteFilterTexture` (0x10002c20)       | in-place decrypt and RGBA8 pixel filter            |
| `device.ts`              | `PEmoteDevice` (0x100716ec)             | module options, player creation                    |
| `player.ts`              | `PEmotePlayer` (0x1007174c)             | slot facade over the player core                   |
| `runtime/interfaces.ts`  |                                         | boundaries between the parts below                 |
| `runtime/player-core.ts` | `MEmotePlayer`                          | Progress, queuing, timelines, variables, tweens    |
| `runtime/clip.ts`        | `MMotionPlayer`                         | clip time, layer nodes, keyframes, layer pass      |
| `runtime/clip/`          | 0x1003aaf0, 0x1003ece0, 0x1003f9c0      | clip, frame slots, interpolation, vertex passes    |
| `runtime/controls/`      | `emote::EP*`                            | eye, eyebrow, mouth, selector, loop, wind, physics |
| `runtime/mesh/`          | 0x1002cd90, 0x1002d960, 0x1003f680      | vertex kernel (Wasm crate `wasm/emote-mesh`)       |
| `runtime/render/`        | `MMotionRenderer`, `MMotionDevice`      | draw list, textures, D3D9 calls                    |

Models come from `src/formats/kirikiri/emote-model.ts`; the player keeps the typed
model in place of the native PSB views. Drawing goes through the `d3d9.dll` contract
(`src/native/d3d9/contract.ts`) on the device the compositor passes to `emoteCreate`,
so state the compositor sets is visible to the runtime and restored after `render`,
as on Direct3D 9.

## Wiring

`emoteDriverLibrary({shaders})` registers the library for its SHA-256. `shaders` are the
compiled blobs of the installation's `emotedriver.dll`, read with
`extractEmoteShaderBlobs` (each blob is checked against its SHA-256); null runs the
device at shader level 0 (fixed function), as the native device does without shader
support. A player is assembled from `EmotePlayerCore` (with `emoteClipFactory` and
`createEmoteControls`) and the renderer `PEmoteDevice.createPlayers` builds.

## Unsupported paths

Paths that shipped `win` files do not use throw on load instead of approximating:
particle, anchor and screen-bounds layers, `groundCorrection`, multi-angle motions,
motion `variable` tracks, `cp`/`prt`/`camera`/`anchor`/`model`/`feedback` content, the
angle and zoom parts of `meshSyncChildMask`, and software texture converters other than
DXT5 → A8R8G8B8. Stereovision clip pairs (`p+0x1c0`, never set in this build) and the
joinTarget pass (0x100460f0, whose maps are empty in shipped data) are not reproduced.

## Numeric conventions

The native code stores single-precision floats and computes in x87 registers, with SSE
paths in some math routines (selected by 0x10028200). SSE paths are reproduced in single
precision; x87 code uses doubles with `Math.fround` where the native code stores a
`float`. `Math.pow`/`sin`/`cos`/`atan` stand in for the CRT versions and can differ by one
ulp before rounding.

## Tests

`tests/emotedriver-*.test.mjs` drive the runtime through the contract on synthetic
models (`tests/kirikiri-psb-fixtures.mjs`) and compare variables, node state and vertex
output at fixed times. Rendering tests record D3D9 calls on a recording device.
`tests/emotedriver-library.test.mjs` loads the library through the loader and plays a
synthetic motion file through the contract.

Probes on real files (non-visual: counts, NaN checks and SHA-256 digests):

- `tools/probe-emotedriver.mjs <tpm> <emotedriver.dll> <xp3>...`: every model through
  the contract on a counting D3D9 device (create, play each main timeline, progress,
  render);
- `tools/probe-emotedriver-clip.mjs`: clip evaluation and mesh kernel agreement;
- `tools/probe-emotedriver-controls.mjs`: control and physics output sequences.

## Artemis x64 integration

A browser port of the E-mote 3.9.8 runtime in the x64 D3D11 `emotedriver.dll`, SHA-256
`80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051` (SDK `3.9.8`, build
`2022/12/28-13:02:35`). Addresses in these sources are functions of that build. Only this
exact DLL hash selects the driver (`emoteDriverProfile`); any other build is refused.
The engine reads the DLL as data for its hash; it never runs.

## Layout

| File                        | Native part                                                             |
| --------------------------- | ----------------------------------------------------------------------- |
| `driver.ts`                 | The device: driver profile, PSB header key, model cache, `createPlayer` |
| `player.ts`                 | `MEmotePlayer`: variables, controls, timelines, player transforms       |
| `clip.ts`                   | `MMotionPlayer`: motion evaluation, nested clips, the draw list         |
| `controls.ts`, `physics.ts` | Gaze, blink, mouth, selector and orbit controls; bust, pendulum, wind   |
| `timelines.ts`, `tween.ts`  | Main and difference timelines; value and rotation tweens                |
| `mesh.ts`                   | Bezier patches and mesh interpolation                                   |
| `renderer.ts`               | The D3D11 renderer as WebGL draw commands                               |

Motion files are read by `src/formats/psb` (PSB containers, filtered headers) and
`src/formats/emote` (typed model and metadata). Atlas textures decode through
`src/graphics/block-texture.ts`.

## Data flow

`EmotePlayer.progress(frames)` steps the controls, applies the variables to the clip and
rebuilds `clip.drawList`: one `EmoteDrawItem` per visible image layer with its icon
rectangle, corner colours, blend mode, vertex grid and stencil links. A host draws the
player by passing the draw list to `EmoteRenderer.render`, which returns the commands that
draw it into the renderer's `surface`. The Artemis CEmoteLayer does this on every draw of
its layer (`src/engines/artemis/image-graphics.ts`).

## Renderer

`EmoteRenderer` reproduces the render handler 0x180006430/0x1800069a0 and the device:

- Ordering: the list is sorted by depth (`z`), then the clip flags compared as float32,
  then list index; unordered (NaN) comparisons are false, as in the native comparator.
  Blank items, zero opacity and blend mode 6 are skipped.
- Meshes: a 1×1 grid is a four-vertex strip; larger grids are triangle lists with corner
  colours spread by the native 8-bit fixed-point interpolation (`emoteColorGrid`).
  Positions are raw E-mote coordinates under the host projection
  `[2/W, −2/H]` (origin at the target centre, y down). Vertex colours are the item
  colours as UNORM bytes; `bm & 0x10` doubles the colour of halved (0x80 = 1.0) items.
- Masks: the device runs in alpha-mask mode. When the stencil parent changes, the parent
  chain draws into two viewport-sized mask targets — intersect parents (stencil type 1)
  multiply, subtract parents (type 2) erase — and the group then draws with its alpha
  multiplied by the mask. Stencil type 4 draws the parent's composite list instead of the
  parent.
- Destination blends (`bm & 0xf00` = 0x100): before each draw the destination region (the
  item's grid bounds, projected and rounded out) is copied into a copy texture that is
  reallocated when the region outgrows it or falls below half its size. 0x100 adds; 0x101–0x10b
  are the subtract, overlay, hard/soft light, dodge, burn, lighten, darken, difference,
  exclusion and luminosity modes; 0x10c is a mosaic, 0x10d a blur of horizontal and vertical
  passes whose radii step down through 9, 6, 3, 2, 1 texels.
- Colour filters (`grayscaleMode` 1–4: mix, add, subtract, invert by the level colour) and
  the colour fix-ups of blend modes 3 and 4 (premultiply) and 5 (invert) follow `fs_basic`.

The pixel programs are generated GLSL; the native HLSL is not used. Blend states follow
the device table 0x180061d60.

### Textures

PSB atlases upload their block data unchanged and decode once on the GPU into an RGBA8
surface shared by every renderer of a texture cache (`EmoteTextureCache`). Supported types:
`L8`, `A8`, `A8L8`, `DXT1`, `DXT3`, `DXT5`, `BC7` and their `_SW` variants. Reserved BC7
blocks decode to transparent black, as D3D11 specifies. The types the device converts on
the CPU (`RGBA5650`, `RGBA5551`, `RGBA4444`, `RGBA8`, `RGBX8`, `ETC1`, `PVRTC`, `CI4`,
`CI8`) throw `EmoteUnsupportedError`.

## Unsupported paths

Data or calls outside the supported paths throw `EmoteUnsupportedError` instead of drawing
approximately: easing curves and `cp` paths, motion tags, variable lists, streams,
own-rotation motions, particle, anchor, camera and clip-rect layers, ground correction,
stencil alpha tests, directional nested-motion modes, stereovision, `clone`,
`assignState`/`getState`, API-log replay, item clip rectangles, the stencil-buffer device
mode and blend indices 13–15.

## Verification

- `tests/emote-renderer.test.mjs` checks ordering, decoding, mesh vertices, the colour grid,
  mask passes, the destination copy and the blur passes on synthetic draw lists.
- `tests/block-texture.test.mjs` checks the BCn and linear decodes against reference
  texels.
- Amakano 3's 132 character models (`image/fg/*.psb`, BC7 and DXT5 atlases) play 240
  frames each through the player and the renderer without errors; their draw lists use
  blend modes 0x10, 0x13 and 0x118 and composite intersect masks (stencil type 5).
