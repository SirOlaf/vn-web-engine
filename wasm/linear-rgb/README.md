# Exact linear RGB kernel

This small, dependency-free Rust library accelerates the shared software graphics
path. It interpolates RGB using separate binary32 multiplication and addition,
transparent-black texture borders, and ties-to-even RGBA8 conversion. It does not
own native vertex coordinates, viewport policy, texture lifetime, or presentation.
Those remain with the caller. There is no WASI, host import, heap allocator, relaxed
SIMD, or fused multiply-add in the module.

`src/graphics/linear-rgb-wasm.ts` validates spans, copies bounded input into private
Wasm memory, invokes the synchronous kernel, and copies the output back. The native
Aokana caller retains its first-read validation and falls back to JavaScript for
nonfinite coordinates or unavailable acceleration. Existing point/cubic paths remain
in JavaScript.

Rebuild after editing Rust:

```sh
rustup target add wasm32-unknown-unknown
npm run build:wasm
npm run build
```

The checked-in `src/graphics/linear-rgb-wasm-binary.ts` is generated from this crate.
Normal `npm run build` does not require Rust, a network connection, or a separate
Wasm-file copy step. The generated binary is embedded so deployment uses the existing
JavaScript serving path. Unsupported WebAssembly/SIMD or a blocking CSP selects the
JavaScript fallback.

The artifact was built with `rustc 1.100.0-nightly (bba531001 2026-09-20)` using
`-C target-feature=+simd128`, optimized without fast-math. The Cargo build is locked,
offline, and uses a temporary output directory. Benchmark without loading game assets:

```sh
node tools/benchmark-aokana-hotspots.mjs /path/to/baseline/dist
```

SIMD operation definitions: [Rust wasm32 intrinsics](https://doc.rust-lang.org/core/arch/wasm32/index.html).
