# WMA audio kernels

Rust implementation of the WMA Lossless entropy decoder, wrapping integer
adaptive predictors, stereo reconstruction and shared float IMDCT. The TypeScript packet/tile front
end and JavaScript fallback live in `src/formats/wma`.

Build the checked-in embedded module with:

```sh
npm run build:wasm -- wma-audio
```

The crate has no dependencies, imports or allocator. The host reserves a bounded
arena and passes pointers to internal typed arrays. SIMD dot products read
signed 16/32-bit histories and update signed 16-bit LMS coefficients with exactly
the scalar decoder's modulo arithmetic.

`imdct.rs` implements the power-of-two split-radix inverse MDCT with fixed-size
FFT codelets. A caller-owned plan contains gather maps, pre/post rotations and
cosine table pointers. All products and sums retain separate float rounding;
full and middle-half transforms share the same code and caller-owned buffers.

`standard.rs` decodes a WMA v2 frame in one call: variable block headers, VLC
exponents, run/level coefficients, normalization, stereo and windowed IMDCT.
Predictors, coefficient tables and overlap buffers share the front end's arena.
The host initializes a bounded double-precision gain table; reconstruction rounds
the gain division to float before the block normalization multiply. SIMD kernels
preserve the same product/add order for contiguous coefficients and overlap windows.

`pro.rs` decodes stereo WMA Pro subframes in one frame call. Eighteen-word channel
records retain scale-factor buffers, resampling state and overlap lengths; the host
only supplies new tile lengths and copies completed PCM. The quantizer uses a
bounded float table for exponents -903 through 770, with zero/infinity outside the
float range. SIMD stereo, coefficient scaling and paired overlap products retain
the scalar decoder's operation order.

Derived from FFmpeg 7.1.1 under LGPL 2.1 or later; attribution and license text are
in `src/formats/wma/NOTICE` and `src/formats/wma/LICENSE`.
