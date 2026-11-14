# VC-1 block decoder

This crate implements the progressive VC-1 macroblock loop of
`src/formats/vc1/reference.ts`. `blocks.rs` decodes VLCs and AC/DC coefficients,
predicts motion and intra blocks, compensates motion and applies the loop
filters. `bits.rs` and `tables.rs` use the checked bit-reader behavior and VLC
layout of the JS fallback. `lib.rs` supplies SIMD pixel operations, and
`block_support.rs` provides internal views into the bounded decoder arena.

The TypeScript front end parses sequence/picture headers and manages reference
pictures. `src/formats/vc1/wasm-decoder.ts` reserves all context, coefficient and
picture storage in one private instance. The header parser and Rust block loop
share their bitplanes and prediction arrays. Each slice crosses the ABI once;
no copies or host calls occur for individual blocks. Whole skipped pictures
share reference storage and keep independent metadata.

The 8×8 inverse transform processes four columns at a time. Interpolation uses
four-lane integer vectors, clipping before averaging; smaller transforms and
loop filters preserve the reference's pass order and rounding. Signed 16-bit
coefficient storage wraps at each transform pass, while pixel output saturates.
Scratch arrays live on the Wasm stack, and kernels make no host calls.

Build with `npm run build:wasm -- vc1-video`. The dependency-free crate targets
`wasm32-unknown-unknown` with SIMD enabled. Its embedded output in
`src/formats/vc1/wasm-binary.ts` is checked in. The host falls back to JavaScript
when the module or its bounded storage is unavailable.

`tests/vc1-video.test.mjs` compares synthetic pictures and pixel operations with
the reference. `tools/benchmark-vc1.mjs` compares complete decoded output and
throughput with a baseline Windows Media decoder, without displaying media.

Derived from FFmpeg 7.1.1; distributed under LGPL 2.1 or later. Copyright notices
and license terms are in `src/formats/vc1/NOTICE` and `src/formats/vc1/LICENSE`.
