# E-mote mesh kernel

This dependency-free Rust module holds the per-vertex loops of the `emotedriver.dll` mesh
pass (0x1003f9c0) for `src/native/emotedriver/runtime/mesh/`. `createEmoteMeshKernel()`
uses it when it instantiates and otherwise the TypeScript twin in `mesh/kernel.ts`.

| Export           | Native                 | Work                                                     |
| ---------------- | ---------------------- | -------------------------------------------------------- |
| `evaluate_patch` | 0x1002cd90, 0x100286d0 | (columns + 1) × (rows + 1) points of a world-space patch |
| `deform_points`  | 0x1003f680             | points through an ancestor's inverse frame and patch     |
| `subdivide_quad` | 0x1002d960             | bilinear grid over a quad                                |

The native build runs its SSE paths on every SSE-capable CPU; they compute in single
precision, and the kernel performs the same `f32` operations in the same order. The
Bernstein tables and the quad subdivision are x87 code: the kernel computes them in `f64`
and rounds where the native code stores a float. The TypeScript twin uses `Math.fround` at
the same points, so both produce identical bits. The host copies inputs to the heap base
and reads results back; there are no imports, allocator or callbacks. The module is scalar.

Rebuild after editing Rust:

```sh
npm run build:wasm
git checkout src/engines/buriko/bp/wasm-binary.ts   # unrelated binary drifts on rebuild
npm run build:runtime
```

The checked-in `src/native/emotedriver/runtime/mesh/wasm-binary.ts` was built with
`rustc 1.100.0-nightly (bba531001 2026-09-20)`.

Verification: `tests/emotedriver-clip.test.mjs` compares the Wasm and TypeScript kernels bit
for bit on synthetic patches; `tools/probe-emotedriver-clip.mjs --compare` compares the
vertex digests of every NEKOPARA motion under both kernels.
