# E-mote mesh kernel

This dependency-free Rust module implements the vertex loops used by
`src/native/emotedriver/runtime/mesh/`. `createEmoteMeshKernel({driverSha256})`
selects arithmetic by exact DLL identity; omission retains the x86 image. It uses
WebAssembly SIMD when available and otherwise the TypeScript twin. `wasm: false`
selects the twin explicitly.

The x86 image (`a3b693b6…5e70b3a86`) retains its SSE-style float32 accumulations,
x87 Bernstein tables and quad stores. The x64 image (`80d28bd0…1e051`) accumulates
x/y pairs in independent `f64x2` lanes, in native row/column order. Control-point,
affine and final vertex stores retain the native float32 rounding. No relaxed
SIMD or fused multiply-add changes the accumulation order.

| Exports                                | Work                                                 |
| -------------------------------------- | ---------------------------------------------------- |
| `evaluate_patch`, `evaluate_patch_x64` | Grid from world-space control points                 |
| `deform_points`, `deform_points_x64`   | Ancestor affine transform and patch mapping          |
| `subdivide_quad`, `subdivide_quad_x64` | Bilinear grid over a quad                            |
| `evaluate_transformed_patch_x64`       | Transform a patch, then evaluate its grid            |
| `map_patch_points_x64`                 | In-place patch mapping                               |
| `affine_points_x64`                    | In-place affine mapping with double offsets/products |

The host copies inputs into a reusable arena and writes results into caller-owned
buffers. The module has no imports, heap allocator or callbacks. Short x64 patch
queries (fewer than 16 points) use the TypeScript arithmetic directly to avoid a
host transition and copies; grids and larger batches use SIMD. This fixed-size
choice does not retry failed operations with another implementation.

The TypeScript x64 twin reuses world-coordinate and weight scratch arrays. Its
Bernstein cache holds at most 16 tables, each for at most 1024 segments. Larger
one-off tables are not cached. Compatibility helpers retain at most 64 small
tables. Device resources consume `EmoteX64MeshKernel`, allowing other kernel
implementations without changing the clip or player.

Rebuild only this crate:

```sh
npm run build:wasm -- emote-mesh
npm run build:runtime
```

The generated binary is checked in at
`src/native/emotedriver/runtime/mesh/wasm-binary.ts`. Synthetic system tests in
`tests/emotedriver-clip.test.mjs` compare both implementations and check build
selection, caller-owned output and offset point buffers. Nonvisual model probes
compare draw lists and render-command hashes; they never display assets.
