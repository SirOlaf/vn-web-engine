# Outline raster kernel

This dependency-free Rust library is the WebAssembly backend of
`src/text/outline-font/raster.ts`: FreeType 2.4.8's smooth renderer (`ftgrays.c`, nonzero
fill, 8-bit coverage) and `FT_Bitmap_Embolden`. All arithmetic is 32-bit and wrapping, like
the 32-bit C build, so the output is identical to the JavaScript rasterizer. The cover prefix
sums and coverage conversion of the sweep, the embolden window sums and the row merges use
WebAssembly SIMD.

`src/text/outline-font/raster-wasm.ts` copies an outline (26.6 points, tags, contour ends)
into the module's memory, calls `outline_render` and, for bold glyphs, `outline_embolden`,
then copies the bitmap out. The module has no imports or allocator; the host lays out all
buffers above `__heap_base`.

Rebuild after editing Rust:

```sh
rustup target add wasm32-unknown-unknown
npm run build:wasm -- outline-raster
npm run build
```

The checked-in `src/text/outline-font/raster-wasm-binary.ts` is generated from this crate
with `rustc 1.97.1 (8bab26f4f 2026-07-14)` and `-C target-feature=+simd128`. Unsupported
WebAssembly SIMD selects the JavaScript rasterizer.

Benchmark with any TrueType or OpenType font, optionally against a baseline build:

```sh
node tools/benchmark-outline-font.mjs /path/to/font.otf /path/to/baseline/dist
```

This code is derived from FreeType 2.4.8; see `src/text/outline-font/README.md` and its
`LICENSE`.
