# VC-1 video

`Vc1Decoder` in `decoder.ts` accepts complete ASF video media objects for WMV3
Main profile and WVC1 Advanced profile. It decodes progressive I and P pictures
into planar 8-bit 4:2:0, preserving FFmpeg 7.1.1 integer rounding and packet
presentation times. ASF demuxing and WMA audio decoding belong to other modules.

The decoder returns one picture or `null` per packet. Main profile outputs the
current picture; Advanced profile delays one reference picture. Call
`decode(null, 0)` until it returns `null` to drain. Returned planes belong to the
decoder and must be copied before its next call. Use `width` and `height` to crop
the padded planes; luma and chroma have separate strides.

The facade selects `wasm-decoder.ts` when WebAssembly SIMD is available, or
`reference.ts` with `{wasm: false}` or when module initialization fails.
`accelerated` reports the selected backend. Each accelerated decoder keeps its
pixel buffers in one private Wasm instance, bounded to 128 MiB. Sequence and picture headers use the shared TypeScript parser. The Rust block
loop handles entropy decoding, prediction, transforms, motion compensation and
filtering with one call per slice; the JS fallback performs the same operations
in `reference.ts`.

`bitstream.ts` implements the checked MSB-first reader and multilevel VLC tables.
`tables.ts` contains the progressive decoding tables. `dsp.ts` implements inverse
transforms, interpolation and loop filters with reusable typed-array scratch
storage. Picture storage is reused in a bounded pool; whole skipped pictures share their
reference planes while retaining independent type and timestamp metadata. Dimensions are limited to
4096 by 2160 and compressed packets to 16 MiB.

Supported tools include 1-MV and mixed 4-MV motion compensation, half- and
quarter-pel interpolation, intensity compensation, bitplanes, AC/DC prediction,
8×8/8×4/4×8/4×4 transforms, loop filtering and progressive slices. Interlacing,
B/BI pictures, sprites, X8 intra coding, multiresolution, range reduction or
mapping, overlap transforms and macroblock quantizer changes are refused.

`tests/vc1-video.test.mjs` exercises synthetic I/P streams and the delayed-output
contract and kernel arithmetic without game data. `src/video/windows-media.ts`
adapts this decoder to caller-owned cropped frames for ASF playback.

The implementation is derived from FFmpeg 7.1.1 and distributed under LGPL 2.1
or later. See [NOTICE](NOTICE) for copyright notices and [LICENSE](LICENSE) for
the license terms.
