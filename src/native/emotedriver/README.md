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
