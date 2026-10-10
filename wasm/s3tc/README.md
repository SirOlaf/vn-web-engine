# DXT5 (BC3) decoder

This dependency-free Rust module decodes DXT5 surfaces to RGBA8 for
`src/graphics/s3tc.ts`, which uses it when a WebGL context lacks
`WEBGL_compressed_texture_s3tc` (or for CPU consumers). `Dxt5Decoder` falls back to a
JavaScript twin of the kernel when the module cannot be instantiated.

`dxt5_decode(source, width, height, destination, mode)` reads
`ceil(width / 4) * ceil(height / 4)` row-major 16-byte blocks and writes tightly packed
R, G, B, A bytes, skipping texels of edge blocks outside the surface. The host validates
and copies all spans before entry. Decode semantics, including the two color modes for
blocks with `color0 <= color1`, are documented in `src/graphics/s3tc.ts`; all
interpolations use truncating integer division, as emotedriver.dll's converter does.

The module is scalar and built without `simd128`, so the fallback also runs where
WebAssembly SIMD is unavailable. It has no imports, allocator or host callbacks.

Rebuild after editing Rust:

```sh
rustup target add wasm32-unknown-unknown
npm run build:wasm
git checkout src/engines/buriko/bp/wasm-binary.ts   # unrelated binary drifts on rebuild
npm run build
```

The checked-in `src/graphics/s3tc-wasm-binary.ts` is generated from this crate and was
built with `rustc 1.100.0-nightly (bba531001 2026-09-20)`.

Verification without viewing pixels: `tests/kirikiri-emote-textures.test.mjs` compares the
kernel, the JavaScript twin and a per-texel reference on synthetic blocks, and
`tools/probe-kirikiri-emote-textures.mjs` compares the kernel with an independent
reference decoder by SHA-256 on real archives.
