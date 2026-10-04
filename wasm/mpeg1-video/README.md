# MPEG-1 video decoder

This dependency-free Rust module decodes MPEG-1 video elementary streams for
`src/formats/mpeg1/wasm-decoder.ts`. It is a complete port of
`src/formats/mpeg1/reference.ts`: start-code scanning, sequence, GOP, picture,
user-data (CRI `IDCPREC`) and slice decoding, motion compensation, the inverse DCT,
and I/P/B reordering. CRI USM movies (CHAOS;HEAD NOAH) and MPEG-1 program streams
(codeX RScript) both decode through it via `Mpeg1Decoder` in
`src/formats/mpeg1/decoder.ts`, which falls back to the reference when the module
cannot be instantiated.

Output is bit-identical to the reference, and so is every error message:

- **Inverse DCT.** The reference sums binary64 products in increasing frequency
  order, skipping zero coefficients and columns. A sum that starts at +0 never becomes
  -0, so those skipped products are exact no-ops, and the kernel can compute dense
  `f64x2` sums without fused multiply-add. The host writes the reference's
  `BASIS_BY_FREQUENCY` into the instance, so the cosines come from the same `Math.cos`.
  Results are clamped to -256..511 before integer conversion, which yields the same
  byte after adding any prediction sample.
- **Motion compensation.** `u8x16_avgr` is the reference's `(a + b + 1) >> 1`. The
  four-sample average widens to 16 bits. Blocks that reach outside the plane use the
  reference's per-sample clamped path.
- **Prefix codes.** The host builds each table of `src/formats/mpeg1/tables.ts` into a
  lookup of up to ten bits and a binary tree. Longer codes continue in the tree from the
  node the lookup reached. An invalid prefix, or one too close to the section end, takes
  the bitwise tree walk from the start, which reports the reference's VLC or range error
  at the reference's bit position.
- **Errors.** A failure stores a code, its operands, and for slices the picture, slice,
  macroblock and bit position. The host formats the reference's message from them,
  including the wrapped slice error and its cause.

The instance owns its state in statics. `init` reserves a 16 MiB input buffer, the
reference's section limit, plus slack that the bit reader's cache may read past a
section end. The first sequence header allocates three picture buffers and the
macroblock coverage map; resolution changes are rejected as in the reference. The
host appends each pushed chunk after the pending section and calls `push`, which
scans and decodes every completed section and keeps the remainder. The scan resumes
where the previous call stopped, which examines the same positions as the reference's
rescan. Each output picture is passed to the imported `mpeg1_emit`, and the host
copies its planes into fresh arrays before returning. Output pictures therefore
belong to the caller, as they do from the reference, and the movie worker transfers
them without another copy.

Rebuild with `npm run build:wasm`, which embeds the binary in
`src/formats/mpeg1/wasm-binary.ts`. The current artifact uses
`rustc 1.100.0-nightly (bba531001 2026-09-20)` with `-C target-feature=+simd128`.

`tests/mpeg1-wasm.test.mjs` compares the module with the reference on synthetic FFmpeg
I/P/B streams at random chunkings, on 400 corrupted variants of them (output, sequence
and error messages), and checks that output pictures are independent of the decoder's
references.
